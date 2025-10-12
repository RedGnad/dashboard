import 'dotenv/config'
import { Address, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Implementation, toMetaMaskSmartAccount, ExecutionMode, getDeleGatorEnvironment } from '@metamask/delegation-toolkit'
import { publicClient, bundlerClient, paymasterClient, monadTestnet, asToolkitClient } from './clients'
import { Address as AddressType } from 'viem'
// Reuse helper from server for consistent paymaster injection (light duplicate parse to avoid circular import)
function parseUsePaymasterFlag(v?: string): boolean { return !!v && ['true','1','yes','on','enabled'].includes(v.toLowerCase()) }
import { buildExecutions } from './dca'
import { USDC, UNISWAP_V2_ROUTER02, WMON } from './constants'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDebugBundle, summarizeExecutions } from './utils/debug'
import { encodePermissionContextsFromDelegations, encodeExecutionCalldatasWithModes } from './encoding'
import { appendRunEvent } from './utils/history'
import { appendAudit, newRunId } from './audit'

export async function runOnceForDelegator(delegatorSA: Address, opts?: { runIndex?: number }) {
  const pk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}`
  if (!pk) throw new Error('Missing DELEGATE_PRIVATE_KEY')

  const delegateEOA = privateKeyToAccount(pk)
  const env = getDeleGatorEnvironment(monadTestnet.id)
  const delegateSA = await toMetaMaskSmartAccount({
    client: asToolkitClient(),
    implementation: Implementation.Hybrid,
    deployParams: [delegateEOA.address, [], [], []],
    deploySalt: '0x',
    signer: { account: delegateEOA },
    environment: env as any,
  })

  const file = join(process.cwd(), 'data', 'delegations', `${delegatorSA}.json`)
  const json = JSON.parse(readFileSync(file, 'utf-8'))
  const signed = json.signedDelegation
  const delegation = { ...signed.delegation, signature: signed.signature }
  // Validate input early with clear messages
  if (!delegation?.delegator || !delegation?.signature) {
    throw new Error('Malformed signedDelegation: missing delegator or signature')
  }

  let amountUSDC = parseUnits(String(json.job?.amountUSDC ?? '1'), 6)
  // Keep a copy of intended amount before any gating to log counterfactuals
  let amountIntendedUSDC: bigint | undefined
  // Telemetry fields for history
  let sizePctBase: number | undefined
  let sizePctEffective: number | undefined
  let aiActionType: string | undefined
  let aiRawScore: number | undefined
  let aiMomentum: number | undefined
  // Manual baseline telemetry
  let balanceAtRunUSDC: bigint | undefined
  let baselineManualUSDC: bigint | undefined
  let executingSell = false
  // --- Enforcements (off-chain logical limits) ---
  // Chaque condition de skip enregistre un événement dans l'historique avec skipped=true et skipReason
  // afin de permettre des analyses (AI / monitoring) sans casser le flux principal.
  // Si des caveats on-chain (timeWindow/dailyCap) sont détectés (enforcers placeholders), on log et on N'EFFECTUE PAS
  // l'enforcement off-chain (évite double filtrage). On laisse la validation on-chain faire foi.
  let onChainLimits = false
  try {
    const caveats = json?.signedDelegation?.delegation?.caveats || []
    const { ENFORCERS } = await import('./enforcers')
    const OFFCHAIN_KEYS: { type: 'timeWindow' | 'dailyCap' | 'maxRuns'; detected: boolean }[] = [
      { type: 'timeWindow', detected: false },
      { type: 'dailyCap', detected: false },
      { type: 'maxRuns', detected: false },
    ]
    for (const c of caveats) {
      const enf = (c?.enforcer || '').toLowerCase()
      if (enf === ENFORCERS.TimestampEnforcer) OFFCHAIN_KEYS.find(k=>k.type==='timeWindow')!.detected = true
      if (enf === ENFORCERS.ERC20PeriodTransferEnforcer) OFFCHAIN_KEYS.find(k=>k.type==='dailyCap')!.detected = true
      if (enf === ENFORCERS.LimitedCallsEnforcer) OFFCHAIN_KEYS.find(k=>k.type==='maxRuns')!.detected = true
    }
    onChainLimits = OFFCHAIN_KEYS.some(k=>k.detected)
    if (onChainLimits) {
      console.log('[runner] on-chain limit caveats detected', OFFCHAIN_KEYS)
    }
  } catch {}
  const now = new Date()
  const hour = now.getUTCHours()
  const tw = json.job?.timeWindow as { startHour: number; endHour: number } | undefined
  if (!onChainLimits && tw) {
    const { startHour, endHour } = tw
    const within = startHour < endHour ? (hour >= startHour && hour < endHour) : (hour >= startHour || hour < endHour)
    if (!within) {
      console.log('[runner] skip: outside_time_window', { hourUTC: hour, startHour, endHour })
      try { appendRunEvent({ ts: Date.now(), delegator: delegatorSA, amountInUSDC: amountUSDC.toString(), skipped: true, skipReason: 'outside_time_window', strategy: 'dca-basic' }) } catch {}
      return '0x' as any
    }
  }
  if (!onChainLimits && typeof json.job?.maxRuns === 'number' && json.job.maxRuns > 0) {
    const current = Number(json.job?.runCounter || 0)
    if (current >= json.job.maxRuns) {
      console.log('[runner] skip: max_runs_reached', { current, max: json.job.maxRuns })
      try { appendRunEvent({ ts: Date.now(), delegator: delegatorSA, amountInUSDC: amountUSDC.toString(), skipped: true, skipReason: 'max_runs_reached', strategy: 'dca-basic' }) } catch {}
      return '0x' as any
    }
  }
  if (!onChainLimits && typeof json.job?.dailyCapUSDC === 'number') {
    const cap = BigInt(Math.floor(json.job.dailyCapUSDC * 1_000_000))
    const today = new Date().toISOString().slice(0,10)
    const usedDate = json.job._dailyCapDate
    let used = BigInt(json.job._dailyCapUsed || 0)
    if (usedDate !== today) {
      used = 0n
      json.job._dailyCapDate = today
      json.job._dailyCapUsed = '0'
    }
    if (used + amountUSDC > cap) {
      console.log('[runner] skip: daily_cap_exceeded', { used: used.toString(), cap: cap.toString(), attempt: amountUSDC.toString() })
      try { appendRunEvent({ ts: Date.now(), delegator: delegatorSA, amountInUSDC: amountUSDC.toString(), skipped: true, skipReason: 'daily_cap_exceeded', strategy: 'dca-basic' }) } catch {}
      // persist updated date reset if it happened
      try { require('node:fs').writeFileSync(file, JSON.stringify(json, null, 2)) } catch {}
      return '0x' as any
    }
  }
  const slippageBps = Number(json.job?.slippageBps ?? 100)
  const unwrapToMon = Boolean(json.job?.unwrapToMon ?? false)
  const unwrapEvery = Number(json.job?.unwrapEvery ?? 1)
  const createdAtMs = Number(json.job?.createdAtMs || Date.now())
  const durationSec = Number(json.job?.durationSec || (24 * 60 * 60))
  const cycleEndsAt = createdAtMs + durationSec * 1000
  const runCounter = Number(json.job?.runCounter || 0)
  const ownerEOA = (json.job?.ownerEOA || '') as Address
  const savedPermit = json.job?.permit as
    | { owner: Address; spender: Address; value: string; deadline: string; v: number; r: `0x${string}`; s: `0x${string}` }
    | undefined
  const auth3009 = json.job?.auth3009 as
    | { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: `0x${string}`; v: number; r: `0x${string}`; s: `0x${string}` }
    | undefined
  const dailyTopupUSDC = BigInt((json.job?.dailyTopupUSDC ?? 24) * 1_000_000)
  const topupUsed: boolean = Boolean(json.job?.topupUsed)
  let usedTopupThisRun = false

  // Pre-check: ensure delegator has enough USDC to avoid simulation revert (TransferHelper: TRANSFER_FROM_FAILED)
  let delegatorUsdcBal: bigint | null = null
  // Helper: read last AI decision from audit for this delegator (to drive dynamic sizing and action gating)
  function getLastAiDecision(): { actionType?: string; rawScore?: number; momentum?: number; risk?: number } | null {
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      const path = require('node:path') as typeof import('node:path')
      const file = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
      if (!fs.existsSync(file)) return null
      const raw = fs.readFileSync(file, 'utf8').trim()
      if (!raw) return null
      const lines = raw.split('\n')
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 1000; i--) {
        const l = lines[i]
        if (!l) continue
        try {
          const j = JSON.parse(l)
          if (j && j.action === 'ai_decision' && String(j.delegator || '').toLowerCase() === String(delegatorSA).toLowerCase()) {
            const actionType = j.aiActionType
            const rawScore = typeof j.rawScore === 'number' ? j.rawScore : undefined
            const risk = typeof j.aiRiskScore === 'number' ? j.aiRiskScore : undefined
            const momentum = j.inferenceFeatures && typeof j.inferenceFeatures.momentumShortMinusLong === 'number' ? j.inferenceFeatures.momentumShortMinusLong : undefined
            return { actionType, rawScore, momentum, risk }
          }
        } catch {}
      }
    } catch {}
    return null
  }
  const lastAi = getLastAiDecision()
  if (lastAi) {
    aiActionType = lastAi.actionType
    if (typeof lastAi.rawScore === 'number') aiRawScore = lastAi.rawScore
    if (typeof lastAi.momentum === 'number') aiMomentum = lastAi.momentum
    // If AI says SELL and job allows it, mark flow as SELL
    try {
      const allowSell = json.job?.allowSellExecution === true
      const t = String(lastAi.actionType || '').toUpperCase()
      if (allowSell && (t === 'SELL' || t === 'REBALANCE')) {
        executingSell = true
      }
    } catch {}
  }
  try {
    const erc20Abi = [
      { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
    ] as const
  const bal = (await (publicClient as any).readContract({
      address: USDC,
      abi: erc20Abi as any,
      functionName: 'balanceOf',
      args: [delegatorSA],
    })) as bigint
    delegatorUsdcBal = bal
    balanceAtRunUSDC = bal
    // Dynamic sizing: if job.amountPolicy === 'pctBalance', compute amountUSDC = balance * sizePct
    try {
      const policy = (json.job?.amountPolicy || '').toString().toLowerCase()
      if (policy === 'pctbalance') {
        // Base pct from job
        const pct = Number(json.job?.sizePct ?? 0)
        const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))
        let p = clamp(Number.isFinite(pct) ? pct : 0, 0, 1)
        sizePctBase = p
        // Optional dynamic scaling by latest AI signal
        if (json.job?.dynamicByAI && lastAi) {
          const score = typeof lastAi.rawScore === 'number' && isFinite(lastAi.rawScore) ? lastAi.rawScore : 0.5
          const mom = typeof lastAi.momentum === 'number' && isFinite(lastAi.momentum) ? lastAi.momentum : 0
          // Scale base pct by score in [0.6, 1.4]
          const scalarScore = 0.6 + 0.8 * clamp(score, 0, 1)
          // Small momentum tilt: map mom (roughly -0.2..+0.2) to +/-15%
          const scalarMom = 1 + clamp(mom * 5, -0.15, 0.15)
          p = clamp(p * scalarScore * scalarMom, 0.001, 0.5)
        }
        sizePctEffective = p
        const ppm = BigInt(Math.floor(p * 1_000_000)) // parts-per-million
        let dyn = (bal * ppm) / 1_000_000n
        // Apply min/max bounds if provided (in USDC units)
        const minU = typeof json.job?.minUSDC === 'number' ? parseUnits(String(json.job.minUSDC), 6) : undefined
        const maxU = typeof json.job?.maxUSDC === 'number' ? parseUnits(String(json.job.maxUSDC), 6) : undefined
        if (minU !== undefined && dyn < minU) dyn = minU
        if (maxU !== undefined && dyn > maxU) dyn = maxU
        // Avoid zero-amount executions
        if (dyn > 0n) amountUSDC = dyn
        // Compute a manual baseline using BASE percentage (pre-AI) with same bounds
        try {
          let baseDyn = bal * BigInt(Math.floor((sizePctBase ?? p) * 1_000_000)) / 1_000_000n
          if (minU !== undefined && baseDyn < minU) baseDyn = minU
          if (maxU !== undefined && baseDyn > maxU) baseDyn = maxU
          baselineManualUSDC = baseDyn
        } catch {}
      }
      // If fixed policy, allow AI to modulate around the fixed base amount
      else if (policy === 'fixed' || policy === '') {
        // Baseline = fixed amount (unmodulated)
        baselineManualUSDC = amountUSDC
        if (json.job?.dynamicByAI && lastAi) {
          const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))
          const score = typeof lastAi.rawScore === 'number' && isFinite(lastAi.rawScore) ? lastAi.rawScore : 0.5
          const mom = typeof lastAi.momentum === 'number' && isFinite(lastAi.momentum) ? lastAi.momentum : 0
          const scalarScore = 0.6 + 0.8 * clamp(score, 0, 1)
          const scalarMom = 1 + clamp(mom * 5, -0.15, 0.15)
          const factor = scalarScore * scalarMom
          // Apply scaling to fixed base amount; clamp to [0.001, 2.0]×base as a safety window
          const lo = amountUSDC / 1000n // 0.1%
          const hi = amountUSDC * 2n     // 200%
          let scaled = BigInt(Math.floor(Number(amountUSDC) * factor))
          if (scaled < lo) scaled = lo
          if (scaled > hi) scaled = hi
          if (scaled > 0n) amountUSDC = scaled
          // Record an approximate effectivePct relative to balance when known (for telemetry only)
          try {
            if (bal > 0n) {
              sizePctBase = undefined
              sizePctEffective = Number((Number(amountUSDC) / Number(bal)).toFixed(6))
            }
          } catch {}
        }
      }
    } catch {}
    amountIntendedUSDC = amountUSDC
    // Respect AI action gating if requested: skip if last AI says SKIP/SELL (unless SELL execution is allowed)
    try {
      const respectAi = json.job?.respectAiAction !== false // default true
      const aiType = String(lastAi?.actionType || '').toUpperCase()
      const isSell = aiType === 'SELL' || aiType === 'REBALANCE'
      if (respectAi && lastAi && lastAi.actionType && aiType !== 'DCA_SWAP' && !(executingSell && isSell)) {
        const reason = String(lastAi.actionType).toUpperCase() === 'SELL' ? 'ai_sell_action' : 'ai_skip_action'
        console.log('[runner] skip due to AI action', { actionType: lastAi.actionType })
        try { appendRunEvent({ ts: Date.now(), delegator: delegatorSA, amountInUSDC: '0', amountIntendedUSDC: (amountIntendedUSDC ?? amountUSDC).toString(), skipped: true, skipReason: reason, strategy: 'dca-basic', ai: { actionType: aiActionType, rawScore: aiRawScore, momentum: aiMomentum }, sizing: { basePct: sizePctBase, effectivePct: sizePctEffective }, balanceAtRunUSDC: (balanceAtRunUSDC ?? 0n).toString(), baselineManualUSDC: (baselineManualUSDC ?? 0n).toString() }) } catch {}
        return '0x' as any
      }
    } catch {}
    if (!executingSell && bal < amountUSDC) {
      const msg = `Insufficient USDC: have ${bal.toString()}, need ${amountUSDC.toString()}`
      console.warn('[runner] skip execution:', msg)
      // We'll try permit + transferFrom if we have an owner and permit
      if (!ownerEOA || !savedPermit) throw new Error(msg)
    }
  } catch (e) {
    // If read fails, proceed (bundler may still simulate); but prefer explicit error
    if (e instanceof Error && /Insufficient USDC/.test(e.message)) {
      // if missing permit info, rethrow; else continue to attempt pull
      if (!ownerEOA || !savedPermit) throw e
    }
  }

  // Prefer executions passed from the frontend (to match exactExecutionBatch caveat); otherwise build locally.
  const wantUnwrapThisRun = unwrapToMon && (unwrapEvery > 1 ? ((runCounter + 1) % unwrapEvery === 0) : true)
  const usedFrontendExecutions = (Array.isArray(json.job?.executions) && json.job.executions.length > 0)
  let executions = (usedFrontendExecutions && !executingSell)
    ? (json.job.executions as any[]).map((e) => ({
        target: e.target as Address,
        value: typeof e.value === 'string' ? BigInt(e.value) : BigInt(e.value ?? 0),
        callData: e.callData as `0x${string}`,
      }))
    : (await (async () => {
        if (!executingSell) {
          // BUY path (USDC -> WMON [+ unwrap])
          let minOut: bigint | undefined = undefined
          if (wantUnwrapThisRun) {
            try {
              const quote = await (publicClient as any).readContract({
                address: UNISWAP_V2_ROUTER02,
                abi: [ { name: 'getAmountsOut', type: 'function', stateMutability: 'view', inputs: [ { name: 'amountIn', type: 'uint256' }, { name: 'path', type: 'address[]' } ], outputs: [ { name: 'amounts', type: 'uint256[]' } ] } ] as any,
                functionName: 'getAmountsOut',
                args: [amountUSDC, [USDC, WMON]],
              }) as bigint[]
              if (Array.isArray(quote) && quote[1] !== undefined) {
                const q = quote[1]
                const slip = BigInt(slippageBps)
                minOut = q - (q * slip / 10_000n)
                if (minOut < 0n) minOut = 0n
              }
            } catch (e) {
              console.warn('[runner] getAmountsOut failed, falling back to minOut=0 withdraw skipped', e)
            }
          }
          return buildExecutions({
            amountUSDC,
            slippageBps,
              unwrapToMon: wantUnwrapThisRun,
            recipient: delegatorSA,
            amountOutMin: wantUnwrapThisRun ? (minOut ?? 0n) : 0n,
            withdrawAmount: wantUnwrapThisRun ? (minOut ?? 0n) : undefined,
          }).executions
        }
        // SELL path (MON -> WMON -> USDC). We'll wrap all native MON (if any) into WMON and then swap total WMON to USDC.
        const { encodeFunctionData } = await import('viem')
        // 1) Balances: WMON and native MON
        let wbal: bigint = 0n
        try {
          wbal = await (publicClient as any).readContract({
            address: WMON,
            abi: [ { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [ { name: 'owner', type: 'address' } ], outputs: [ { name: '', type: 'uint256' } ] } ] as any,
            functionName: 'balanceOf',
            args: [delegatorSA],
          }) as bigint
        } catch {}
        let monBal: bigint = 0n
        try { monBal = await publicClient.getBalance({ address: delegatorSA }) } catch {}
        if (wbal === 0n && monBal === 0n) {
          console.log('[runner] SELL requested but no WMON or MON balance; skipping')
          try { appendRunEvent({ ts: Date.now(), delegator: delegatorSA, amountInUSDC: '0', skipped: true, skipReason: 'sell_no_wmon_or_mon', strategy: 'dca-sell', ai: { actionType: aiActionType, rawScore: aiRawScore, momentum: aiMomentum } }) } catch {}
          return []
        }
        const execs: { target: Address; value: bigint; callData: `0x${string}` }[] = []
        // 2) If MON > 0, wrap it fully into WMON via deposit()
        let wrapAmt = 0n
        if (monBal > 0n) {
          try {
            const depositData = encodeFunctionData({
              abi: [ { name: 'deposit', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] } ] as any,
              functionName: 'deposit',
              args: [],
            }) as `0x${string}`
            execs.push({ target: WMON as Address, value: monBal, callData: depositData })
            wrapAmt = monBal
          } catch (e) { console.warn('[runner] failed to encode WMON.deposit for wrap', e) }
        }
        const totalWmon = wbal + wrapAmt
        // 3) Quote USDC out for total WMON
        let minUsdcOut: bigint = 0n
        try {
          const quote = await (publicClient as any).readContract({
            address: UNISWAP_V2_ROUTER02,
            abi: [ { name: 'getAmountsOut', type: 'function', stateMutability: 'view', inputs: [ { name: 'amountIn', type: 'uint256' }, { name: 'path', type: 'address[]' } ], outputs: [ { name: 'amounts', type: 'uint256[]' } ] } ] as any,
            functionName: 'getAmountsOut',
            args: [totalWmon, [WMON, USDC]],
          }) as bigint[]
          if (Array.isArray(quote) && quote[1] !== undefined) {
            const q = quote[1]
            const slip = BigInt(slippageBps)
            minUsdcOut = q - (q * slip / 10_000n)
            if (minUsdcOut < 0n) minUsdcOut = 0n
          }
        } catch (e) { console.warn('[runner] SELL getAmountsOut failed', e) }
        // 4) Approve WMON to router if needed for totalWmon
        try {
          const allowance = await (publicClient as any).readContract({
            address: WMON,
            abi: [ { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [ { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' } ], outputs: [ { name: '', type: 'uint256' } ] } ] as any,
            functionName: 'allowance',
            args: [delegatorSA, UNISWAP_V2_ROUTER02],
          }) as bigint
          if (allowance < totalWmon) {
            const approveData = encodeFunctionData({
              abi: [ { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [ { name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' } ], outputs: [ { name: '', type: 'bool' } ] } ] as any,
              functionName: 'approve',
              args: [UNISWAP_V2_ROUTER02, totalWmon],
            }) as `0x${string}`
            execs.push({ target: WMON as Address, value: 0n, callData: approveData })
          }
        } catch {}
        // 5) Swap WMON -> USDC
        const swapData = encodeFunctionData({
          abi: [ { name: 'swapExactTokensForTokens', type: 'function', stateMutability: 'nonpayable', inputs: [ { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' } ], outputs: [ { name: 'amounts', type: 'uint256[]' } ] } ] as any,
          functionName: 'swapExactTokensForTokens',
          args: [totalWmon, minUsdcOut, [WMON as Address, USDC as Address], delegatorSA, BigInt(Math.floor(Date.now()/1000) + 1200)],
        }) as `0x${string}`
        execs.push({ target: UNISWAP_V2_ROUTER02 as Address, value: 0n, callData: swapData })
        return execs
      })())

  // If we reused frontend-provided executions (approve + swap) but need unwrap, append withdraw if missing
  if (usedFrontendExecutions && wantUnwrapThisRun) {
    const hasWithdraw = executions.some((ex) => ex.target.toLowerCase() === WMON.toLowerCase() && (ex.callData as string).slice(0, 10) === '0x2e1a7d4d') // WETH9 withdraw selector
    if (!hasWithdraw) {
      try {
        // Quote expected WMON out
        let minOut: bigint | undefined
        try {
          const quote = await (publicClient as any).readContract({
            address: UNISWAP_V2_ROUTER02,
            abi: [ { name: 'getAmountsOut', type: 'function', stateMutability: 'view', inputs: [ { name: 'amountIn', type: 'uint256' }, { name: 'path', type: 'address[]' } ], outputs: [ { name: 'amounts', type: 'uint256[]' } ] } ] as any,
            functionName: 'getAmountsOut',
            args: [amountUSDC, [USDC, WMON]],
          }) as bigint[]
          if (Array.isArray(quote) && quote[1] !== undefined) {
            const q = quote[1]
            const slip = BigInt(slippageBps)
            minOut = q - (q * slip / 10_000n)
            if (minOut < 0n) minOut = 0n
          }
        } catch (e) {
          console.warn('[runner] quote for append-withdraw failed', e)
        }
        if (minOut && minOut > 0n) {
          const { encodeFunctionData } = await import('viem')
          const withdrawCalldata = encodeFunctionData({
            abi: [ { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [ { name: 'wad', type: 'uint256' } ], outputs: [] } ] as any,
            functionName: 'withdraw',
            args: [minOut],
          }) as `0x${string}`
          executions = [...executions, { target: WMON as Address, value: 0n, callData: withdrawCalldata }]
          console.log('[runner] appended withdraw for unwrapToMon', { minOut: String(minOut) })
        } else {
          console.warn('[runner] unwrap requested but minOut unavailable; skipping withdraw append')
        }
      } catch (e) {
        console.warn('[runner] failed to append withdraw execution', e)
      }
    }
  }

  // --- Whitelist Validation (only if executions came from front) ---
  if (usedFrontendExecutions) {
    try {
      const ALLOWED_TARGETS = new Set([
        USDC.toLowerCase(),
        UNISWAP_V2_ROUTER02.toLowerCase(),
        WMON.toLowerCase(),
        delegatorSA.toLowerCase(), // direct recipient transfers
      ])
      const ALLOWED_SELECTORS = new Set([
        '0x095ea7b3', // approve
        '0x23b872dd', // transferFrom
        '0xa9059cbb', // transfer (not strictly needed if using transferFrom, kept for safety)
        '0x2e1a7d4d', // withdraw (WETH/WMON)
        '0x7ff36ab5', // swapExactETHForTokens (example, may not be used)
        '0x38ed1739', // swapExactTokensForTokens
        '0x18cbafe5', // swapExactTokensForETH
        '0x414bf389', // swapTokensForExactTokens
        '0x4bb278f3', // swapTokensForExactETH
      ])
      const violations: any[] = []
      for (const [i, ex] of executions.entries()) {
        const tgt = (ex.target || '').toLowerCase()
        if (!ALLOWED_TARGETS.has(tgt)) {
          violations.push({ i, reason: 'target_not_whitelisted', target: ex.target })
          continue
        }
        const selector = (ex.callData as string)?.slice(0, 10)
        if (ex.callData && ex.callData !== '0x' && !ALLOWED_SELECTORS.has(selector)) {
          violations.push({ i, reason: 'selector_not_whitelisted', selector })
        }
      }
      if (violations.length > 0) {
        console.warn('[runner] frontend executions rejected due to whitelist violations', violations)
        try { appendRunEvent({ ts: Date.now(), delegator: delegatorSA, amountInUSDC: amountUSDC.toString(), skipped: true, skipReason: 'whitelist_violation', strategy: 'dca-basic' }) } catch {}
        return '0x' as any
      }
    } catch (e) {
      console.warn('[runner] whitelist validation failed (soft pass)', e)
    }
  }

  // If SA USDC is insufficient and we have an offchain auth, prepend top-up (one-time per 24h)
  if (delegatorUsdcBal !== null && delegatorUsdcBal < amountUSDC && ownerEOA && !topupUsed) {
    // Check allowance first
    try {
      const { encodeFunctionData } = await import('viem')
      const erc20Abi = [
        { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [ { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' } ], outputs: [ { name: '', type: 'uint256' } ] },
      ] as const
  const allowance = await (publicClient as any).readContract({
        address: USDC,
        abi: erc20Abi as any,
        functionName: 'allowance',
        args: [ownerEOA, delegatorSA],
      }) as bigint
      const need = dailyTopupUSDC // pull fixed daily amount as requested
      const calls: { target: Address; value: bigint; callData: `0x${string}` }[] = []
      if (savedPermit && allowance < need) {
        const permitCalldata = encodeFunctionData({
          abi: [
            { name: 'permit', type: 'function', stateMutability: 'nonpayable', inputs: [
              { name: 'owner', type: 'address' },
              { name: 'spender', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'deadline', type: 'uint256' },
              { name: 'v', type: 'uint8' },
              { name: 'r', type: 'bytes32' },
              { name: 's', type: 'bytes32' },
            ], outputs: [] },
          ] as any,
          functionName: 'permit',
          args: [savedPermit.owner, delegatorSA, BigInt(savedPermit.value), BigInt(savedPermit.deadline), savedPermit.v, savedPermit.r, savedPermit.s],
        }) as `0x${string}`
        calls.push({ target: USDC as Address, value: 0n, callData: permitCalldata })
      }
      if (savedPermit) {
        const transferFromCalldata = encodeFunctionData({
          abi: [
            { name: 'transferFrom', type: 'function', stateMutability: 'nonpayable', inputs: [
              { name: 'owner', type: 'address' },
              { name: 'to', type: 'address' },
              { name: 'value', type: 'uint256' },
            ], outputs: [{ name: '', type: 'bool' }] },
          ] as any,
          functionName: 'transferFrom',
          args: [ownerEOA, delegatorSA, need],
        }) as `0x${string}`
        calls.push({ target: USDC as Address, value: 0n, callData: transferFromCalldata })
      } else if (auth3009) {
        // EIP-3009 transferWithAuthorization
        const twa = encodeFunctionData({
          abi: [
            { name: 'transferWithAuthorization', type: 'function', stateMutability: 'nonpayable', inputs: [
              { name: 'from', type: 'address' },
              { name: 'to', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'validAfter', type: 'uint256' },
              { name: 'validBefore', type: 'uint256' },
              { name: 'nonce', type: 'bytes32' },
              { name: 'v', type: 'uint8' },
              { name: 'r', type: 'bytes32' },
              { name: 's', type: 'bytes32' },
            ], outputs: [] },
          ] as any,
          functionName: 'transferWithAuthorization',
          args: [auth3009.from, delegatorSA, BigInt(auth3009.value), BigInt(auth3009.validAfter), BigInt(auth3009.validBefore), auth3009.nonce, auth3009.v, auth3009.r, auth3009.s],
        }) as `0x${string}`
        calls.push({ target: USDC as Address, value: 0n, callData: twa })
      }
      executions = [...calls, ...executions]
      usedTopupThisRun = calls.length > 0
    } catch (e) {
      console.warn('[runner] permit/transferFrom preparation failed; proceeding without pull', e)
    }
  }
  // If first call is USDC.approve and allowance already sufficient, drop the approve to make repeats succeed
  try {
    const sel = (executions?.[0]?.callData as string | undefined)?.slice(0, 10)
    if (executions?.[0]?.target?.toLowerCase() === USDC.toLowerCase() && sel === '0x095ea7b3') {
      // read allowance(delegatorSA, router)
      const erc20Abi = [
        { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [ { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' } ], outputs: [ { name: '', type: 'uint256' } ] },
      ] as const
  const allowance = await (publicClient as any).readContract({
        address: USDC,
        abi: erc20Abi as any,
        functionName: 'allowance',
        args: [delegatorSA, UNISWAP_V2_ROUTER02],
      }) as bigint
      if (allowance >= amountUSDC) {
        executions = executions.slice(1)
      }
    }
  } catch {}
  // Minimal debug context without simulations
  const debugBundle = { ...buildDebugBundle({
    label: 'runner.pre-encode',
    env,
    delegatorSA,
    delegateSA: delegateSA.address,
    signedDelegation: signed,
    executions,
  }) }
  console.log('[runner] context', JSON.stringify(debugBundle, null, 2))
  // No supportsExecutionMode probe per requirement

  // Encode redeem using the typed variant to ensure correct struct packing (one group, SingleDefault mode)
  // Normalize signed delegation shape for encode (uint256 salt, include signature)
  const flat = {
    delegate: signed.delegation.delegate,
    delegator: signed.delegation.delegator,
    authority: signed.delegation.authority,
    caveats: (signed.delegation.caveats || []).map((c: any) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args })),
    salt: signed.delegation.salt,
    signature: signed.signature,
  }
  const { encodeFunctionData, encodeAbiParameters } = await import('viem')
  // Encode permission contexts (ABI bytes for DelegationManager.redeemDelegations)
  console.log('[runner] encoding permission contexts…')
  const encodedCtxArr = encodePermissionContextsFromDelegations([[flat as any]])
  console.log('[runner] encodedCtxArr meta', { isArray: Array.isArray(encodedCtxArr), len: encodedCtxArr?.length })
  if (!Array.isArray(encodedCtxArr) || encodedCtxArr.length === 0) {
    throw new Error('encodePermissionContextsFromDelegations returned empty array')
  }
  const [ctx] = encodedCtxArr
  // Build 1 redemption per execution using SingleDefault to match enforcer expectations
  const execGroups = executions.map((e) => [e])
  const { calldatas, modes } = encodeExecutionCalldatasWithModes(execGroups)
  const permissionContexts = execGroups.map(() => ctx)
  const DM_REDEEM_ABI = [
    { type: 'function', name: 'redeemDelegations', stateMutability: 'nonpayable', inputs: [
      { name: '_permissionContexts', type: 'bytes[]' },
      { name: '_modes', type: 'bytes32[]' },
      { name: '_executionCallDatas', type: 'bytes[]' },
    ], outputs: [] },
  ] as const
  const calldata = encodeFunctionData({ abi: DM_REDEEM_ABI as any, functionName: 'redeemDelegations', args: [permissionContexts as any, modes as any, calldatas as any] }) as `0x${string}`
  console.log('[runner] calldata size', { bytes: (calldata as string).length / 2 - 1, executions: executions.length, permissionContexts: permissionContexts.length, modes: modes.length, execCalldatas: calldatas.length })
  // Resolve gas prices: prefer bundler's pimlico_getUserOperationGasPrice, then public getGasPrice, then sane floor
  let maxFeePerGas: bigint = 0n
  let maxPriorityFeePerGas: bigint = 0n
  const MIN_GAS = 80n * 10n ** 9n // 80 gwei safety floor to satisfy bundler minimums
  try {
    const res: any = await (bundlerClient as any).request?.({ method: 'pimlico_getUserOperationGasPrice', params: [] })
    const pick = res?.standard || res?.fast || res?.slow || res
    const parse = (v: any) => (typeof v === 'string' ? BigInt(v) : (typeof v === 'number' ? BigInt(v) : 0n))
    const mf = parse(pick?.maxFeePerGas)
    const mp = parse(pick?.maxPriorityFeePerGas)
    if (mf > 0n && mp > 0n) {
      maxFeePerGas = mf
      maxPriorityFeePerGas = mp
    }
  } catch {}
  if (maxFeePerGas === 0n) {
    try {
      const gp = await publicClient.getGasPrice()
      // EIP-1559: set both to gasPrice baseline; bundler can bump as needed
      maxFeePerGas = gp
      maxPriorityFeePerGas = gp / 2n || 1n
    } catch {}
  }
  if (maxFeePerGas < MIN_GAS) maxFeePerGas = MIN_GAS
  if (maxPriorityFeePerGas === 0n) maxPriorityFeePerGas = maxFeePerGas / 2n
  // Default paymaster OFF to avoid external policy reverts during debugging; can be enabled via env or job.usePaymaster
  let usePm = parseUsePaymasterFlag(process.env.USE_PAYMASTER)
  const jobFlagPresent = typeof json.job?.usePaymaster === 'boolean'
  if (jobFlagPresent) usePm = json.job.usePaymaster
  const forceOverride = parseUsePaymasterFlag(process.env.FORCE_USE_PAYMASTER)
  if (forceOverride) {
    usePm = true
  } else if (!jobFlagPresent && usePm) {
    // env true, no per-job flag: already true
  } else if (usePm === false && parseUsePaymasterFlag(process.env.USE_PAYMASTER) && process.env.OVERRIDE_JOB_PAYMASTER === '1') {
    // allow optional override when job explicitly set false but we want global
    console.log('[runner] overriding job.usePaymaster=false due to OVERRIDE_JOB_PAYMASTER=1')
    usePm = true
  }
  console.log('[runner] sending userOp', {
    bundlerSet: !!process.env.ZERO_DEV_BUNDLER_RPC,
    paymasterSet: !!process.env.ZERO_DEV_PAYMASTER_RPC,
  usePm,
  jobFlagPresent,
  forceOverride,
    delegateSA: delegateSA.address,
    dm: env.DelegationManager,
  maxFeePerGas: String(maxFeePerGas),
  maxPriorityFeePerGas: String(maxPriorityFeePerGas),
  })
  let uoHash: `0x${string}`
  try {
    if (usePm && !(process.env.ZERO_DEV_PAYMASTER_RPC || process.env.PIMLICO_PAYMASTER_RPC)) {
      console.warn('[runner] paymaster wanted but no PAYMASTER RPC set, proceeding unsponsored')
    }
    const willInject = usePm && (process.env.ZERO_DEV_PAYMASTER_RPC || process.env.PIMLICO_PAYMASTER_RPC)
    if (willInject) {
      console.log('[runner] injecting paymaster for DCA op')
    }
    const runId = newRunId()
  uoHash = await (bundlerClient as any).sendUserOperation({
      account: delegateSA,
      calls: [{ to: env.DelegationManager as Address, data: calldata }],
      maxFeePerGas,
      maxPriorityFeePerGas,
      ...(willInject ? { paymaster: paymasterClient } : {}),
    })
    console.log('[runner] userOp sent', { userOperationHash: uoHash })
    // Append history event (amountOutToken unknown at submission time)
    try {
      appendRunEvent({
        ts: Date.now(),
        delegator: delegatorSA,
        amountInUSDC: executingSell ? '0' : amountUSDC.toString(),
        amountIntendedUSDC: (amountIntendedUSDC ?? amountUSDC).toString(),
        amountOutToken: '0',
        unwrap: wantUnwrapThisRun,
        ai: { actionType: aiActionType, rawScore: aiRawScore, momentum: aiMomentum },
        sizing: { basePct: sizePctBase, effectivePct: sizePctEffective },
        balanceAtRunUSDC: (balanceAtRunUSDC ?? 0n).toString(),
        baselineManualUSDC: (baselineManualUSDC ?? 0n).toString(),
        userOperationHash: uoHash,
        strategy: executingSell ? 'dca-sell' : 'dca-basic',
        gas: { maxFeePerGas: String(maxFeePerGas), maxPriorityFeePerGas: String(maxPriorityFeePerGas) },
      })
      // Also append audit entries for the delegation consumed (struct hash recompute now)
      try {
        const d = signed.delegation
        const domainCfg = { name: process.env.DELEGATION_DOMAIN_NAME || 'Delegation', version: process.env.DELEGATION_DOMAIN_VERSION || '1', chainId: monadTestnet.id, verifyingContract: (process.env.DELEGATION_MANAGER_ADDRESS || (getDeleGatorEnvironment(monadTestnet.id) as any).DelegationManager) }
        const { computeCanonicalDelegationHashes } = await import('./eip712')
        const h = computeCanonicalDelegationHashes({ delegator: d.delegator, delegate: d.delegate, authority: d.authority, caveats: d.caveats||[], salt: d.salt }, domainCfg as any)
        appendAudit({ ts: Date.now(), action: 'execute', delegator: delegatorSA, delegate: d.delegate, role: 'core', structHash: h.structHash, digest: h.digest, domainSeparator: h.domainSeparator, caveatsRoot: h.caveatsHash, salt: d.salt, warnings: [], userOperationHash: uoHash, runId })
      } catch {}
    } catch {}
    // Persist job counters and flags on success
    try {
      const updated = { ...json }
      updated.job = updated.job || {}
      updated.job.runCounter = (runCounter || 0) + 1
      // increment daily cap usage tracking if configured (BUY only)
      if (!executingSell && typeof updated.job.dailyCapUSDC === 'number') {
        const today = new Date().toISOString().slice(0,10)
        if (updated.job._dailyCapDate !== today) {
          updated.job._dailyCapDate = today
          updated.job._dailyCapUsed = '0'
        }
        try {
          const prev = BigInt(updated.job._dailyCapUsed || '0')
          updated.job._dailyCapUsed = (prev + amountUSDC).toString()
        } catch {}
      }
      if (usedTopupThisRun) {
        updated.job.topupUsed = true
        updated.job.topupUsedAt = Date.now()
      }
      const file = join(process.cwd(), 'data', 'delegations', `${delegatorSA}.json`)
      try { require('node:fs').writeFileSync(file, JSON.stringify(updated, null, 2)) } catch {}
    } catch {}
  } catch (err: any) {
    const enriched = new Error(err?.message || 'sendUserOperation failed') as any
    enriched.cause = err?.cause || err?.stack || String(err)
    enriched.details = err?.details || err?.shortMessage
    enriched.debugBundle = debugBundle
    // Try a secondary estimate to extract inner revert data (if bundler exposes it)
    // Do not run extra simulations; still enrich error with context if available
    console.error('[runner] sendUserOperation error', {
      message: enriched.message,
      details: enriched.details,
      cause: String(enriched.cause),
      executions: summarizeExecutions(executions),
    })
    throw enriched
  }
  console.log('Sent DCA userOperationHash', uoHash)
  return uoHash
}

export async function flushTokenForDelegator(delegatorSA: Address, token: Address, to: Address, amount: 'all' | bigint) {
  const pk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}`
  if (!pk) throw new Error('Missing DELEGATE_PRIVATE_KEY')
  const delegateEOA = privateKeyToAccount(pk)
  const env = getDeleGatorEnvironment(monadTestnet.id)
  const delegateSA = await toMetaMaskSmartAccount({
    client: asToolkitClient(),
    implementation: Implementation.Hybrid,
    deployParams: [delegateEOA.address, [], [], []],
    deploySalt: '0x',
    signer: { account: delegateEOA },
    environment: env as any,
  })
  const file = join(process.cwd(), 'data', 'delegations', `${delegatorSA}.json`)
  const json = JSON.parse(readFileSync(file, 'utf-8'))
  const signed = json.signedDelegation
  let amt: bigint
  if (amount === 'all') {
    try {
      const erc20Abi = [ { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] } ] as const
  amt = await (publicClient as any).readContract({ address: token, abi: erc20Abi as any, functionName: 'balanceOf', args: [delegatorSA] }) as bigint
    } catch { amt = 0n }
  } else amt = amount
  const { encodeFunctionData } = await import('viem')
  const callData = encodeFunctionData({
    abi: [ { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [ { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' } ], outputs: [ { name: '', type: 'bool' } ] } ] as any,
    functionName: 'transfer',
    args: [to, amt],
  }) as `0x${string}`
  const exec = [{ target: token, value: 0n, callData }]
  const flat = {
    delegate: signed.delegation.delegate,
    delegator: signed.delegation.delegator,
    authority: signed.delegation.authority,
    caveats: (signed.delegation.caveats || []).map((c: any) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args })),
    salt: signed.delegation.salt,
    signature: signed.signature,
  }
  const [ctx] = encodePermissionContextsFromDelegations([[flat as any]])
  const { calldatas, modes } = encodeExecutionCalldatasWithModes([exec])
  const DM_REDEEM_ABI = [
    { type: 'function', name: 'redeemDelegations', stateMutability: 'nonpayable', inputs: [
      { name: '_permissionContexts', type: 'bytes[]' },
      { name: '_modes', type: 'bytes32[]' },
      { name: '_executionCallDatas', type: 'bytes[]' },
    ], outputs: [] },
  ] as const
  const data = encodeFunctionData({ abi: DM_REDEEM_ABI as any, functionName: 'redeemDelegations', args: [[ctx] as any, modes as any, calldatas as any] }) as `0x${string}`
  // gas
  let maxFeePerGas: bigint = 80n * 10n ** 9n
  let maxPriorityFeePerGas: bigint = maxFeePerGas / 2n
  try { const gp = await publicClient.getGasPrice(); if (gp > maxFeePerGas) { maxFeePerGas = gp; maxPriorityFeePerGas = gp / 2n || 1n } } catch {}
  const uoHash = await (bundlerClient as any).sendUserOperation({
    account: delegateSA,
    calls: [{ to: env.DelegationManager as Address, data }],
    maxFeePerGas,
    maxPriorityFeePerGas,
  })
  return uoHash
}
