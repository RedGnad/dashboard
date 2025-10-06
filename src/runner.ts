import 'dotenv/config'
import { Address, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Implementation, toMetaMaskSmartAccount, ExecutionMode, getDeleGatorEnvironment } from '@metamask/delegation-toolkit'
import { DelegationManager } from '@metamask/delegation-toolkit/contracts'
import { publicClient, bundlerClient, paymasterClient, monadTestnet } from './clients'
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

export async function runOnceForDelegator(delegatorSA: Address, opts?: { runIndex?: number }) {
  const pk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}`
  if (!pk) throw new Error('Missing DELEGATE_PRIVATE_KEY')

  const delegateEOA = privateKeyToAccount(pk)
  const env = getDeleGatorEnvironment(monadTestnet.id)
  const delegateSA = await toMetaMaskSmartAccount({
    client: publicClient,
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

  const amountUSDC = parseUnits(String(json.job?.amountUSDC ?? '1'), 6)
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
  try {
    const erc20Abi = [
      { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
    ] as const
    const bal = (await publicClient.readContract({
      address: USDC,
      abi: erc20Abi as any,
      functionName: 'balanceOf',
      args: [delegatorSA],
    })) as bigint
    delegatorUsdcBal = bal
    if (bal < amountUSDC) {
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
  const usedFrontendExecutions = Array.isArray(json.job?.executions) && json.job.executions.length > 0
  let executions = usedFrontendExecutions
    ? (json.job.executions as any[]).map((e) => ({
        target: e.target as Address,
        value: typeof e.value === 'string' ? BigInt(e.value) : BigInt(e.value ?? 0),
        callData: e.callData as `0x${string}`,
      }))
    : (await (async () => {
        // Attempt on-chain quote for minOut to have a safe withdraw amount.
        let minOut: bigint | undefined = undefined
        if (wantUnwrapThisRun) {
          try {
            const quote = await publicClient.readContract({
              address: UNISWAP_V2_ROUTER02,
              abi: [ { name: 'getAmountsOut', type: 'function', stateMutability: 'view', inputs: [ { name: 'amountIn', type: 'uint256' }, { name: 'path', type: 'address[]' } ], outputs: [ { name: 'amounts', type: 'uint256[]' } ] } ] as any,
              functionName: 'getAmountsOut',
              args: [amountUSDC, [USDC, WMON]],
            }) as bigint[]
            if (Array.isArray(quote) && quote[1] !== undefined) {
              // Apply slippageBps: minOut = quote * (1 - slippageBps/10_000)
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
      })())

  // If we reused frontend-provided executions (approve + swap) but need unwrap, append withdraw if missing
  if (usedFrontendExecutions && wantUnwrapThisRun) {
    const hasWithdraw = executions.some((ex) => ex.target.toLowerCase() === WMON.toLowerCase() && (ex.callData as string).slice(0, 10) === '0x2e1a7d4d') // WETH9 withdraw selector
    if (!hasWithdraw) {
      try {
        // Quote expected WMON out
        let minOut: bigint | undefined
        try {
          const quote = await publicClient.readContract({
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

  // If SA USDC is insufficient and we have an offchain auth, prepend top-up (one-time per 24h)
  if (delegatorUsdcBal !== null && delegatorUsdcBal < amountUSDC && ownerEOA && !topupUsed) {
    // Check allowance first
    try {
      const { encodeFunctionData } = await import('viem')
      const erc20Abi = [
        { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [ { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' } ], outputs: [ { name: '', type: 'uint256' } ] },
      ] as const
      const allowance = await publicClient.readContract({
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
      const allowance = await publicClient.readContract({
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
    uoHash = await bundlerClient.sendUserOperation({
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
        amountInUSDC: amountUSDC.toString(),
        amountOutToken: '0',
        unwrap: wantUnwrapThisRun,
        userOperationHash: uoHash,
        strategy: 'dca-basic',
        gas: { maxFeePerGas: String(maxFeePerGas), maxPriorityFeePerGas: String(maxPriorityFeePerGas) },
      })
    } catch {}
    // Persist job counters and flags on success
    try {
      const updated = { ...json }
      updated.job = updated.job || {}
      updated.job.runCounter = (runCounter || 0) + 1
      // increment daily cap usage tracking if configured
      if (typeof updated.job.dailyCapUSDC === 'number') {
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
    client: publicClient,
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
      amt = await publicClient.readContract({ address: token, abi: erc20Abi as any, functionName: 'balanceOf', args: [delegatorSA] }) as bigint
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
  const uoHash = await bundlerClient.sendUserOperation({
    account: delegateSA,
    calls: [{ to: env.DelegationManager as Address, data }],
    maxFeePerGas,
    maxPriorityFeePerGas,
  })
  return uoHash
}
