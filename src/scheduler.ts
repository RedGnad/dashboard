import type { Address } from 'viem'
import { runOnceForDelegator } from './runner'
// Suppression du flush WMON direct: on déclenche maintenant un retrait MON natif via la logique /api/send-mon
// pour bénéficier du mode scope natif ou fallback WMON automatiquement.

export type JobStatus = {
  delegatorSA: Address
  intervalSec: number
  active: boolean
  jobType: 'dca_ai' | 'dca_schedule'
  lastRunAt?: number
  lastOpHash?: `0x${string}`
  lastError?: string
  // Optional expiration timestamp (ms since epoch); when reached, job auto-stops
  expiresAt?: number
  // Number of successful runOnceForDelegator calls completed while active
  runsDone?: number
}

type InternalJob = JobStatus & {
  _timer?: NodeJS.Timeout
  _running?: boolean
}

// ---- Auto-anchoring (Proof Pack) periodic job ----
interface AnchorJobState { intervalSec: number; _timer?: NodeJS.Timeout; active: boolean }
let anchorJob: AnchorJobState | null = null

export function startAutoAnchoring(intervalSec = 300) { // default 5 min
  if (anchorJob?.active) {
    anchorJob.intervalSec = intervalSec
    return { ok: true, updated: true, intervalSec }
  }
  anchorJob = { intervalSec, active: true }
  const tick = async () => {
    if (!anchorJob?.active) return
    try {
      const url = new URL('http://127.0.0.1:' + (process.env.PORT || '8787') + '/api/strategy/proof-pack/latest?anchor=1')
      const fetchMod = await import('node-fetch').catch(()=>null) as any
      let res: any
      if (fetchMod && typeof fetchMod.default === 'function') {
        res = await fetchMod.default(url.toString())
      } else if (typeof (globalThis as any).fetch === 'function') {
        res = await (globalThis as any).fetch(url.toString())
      } else {
        console.warn('[auto-anchor] fetch non disponible')
        return
      }
      if (!res.ok) {
        console.warn('[auto-anchor] http_status', res.status)
        return
      }
      const packHash = res.headers.get('x-pack-keccak256') || 'unknown'
      console.log('[auto-anchor] anchored pack', { packHash, intervalSec })
    } catch (e:any) {
      console.warn('[auto-anchor] tick failed', e?.message || e)
    }
  }
  anchorJob._timer = setInterval(tick, Math.max(60, intervalSec) * 1000)
  console.log('[auto-anchor] started', { intervalSec })
  // Immediate first run (detached, no await)
  tick()
  return { ok: true, started: true, intervalSec }
}

export function stopAutoAnchoring() {
  if (anchorJob?._timer) clearInterval(anchorJob._timer)
  if (anchorJob) anchorJob.active = false
  console.log('[auto-anchor] stopped')
  return { ok: true, stopped: true }
}

const jobs: Record<string, InternalJob> = {}

function schedule(job: InternalJob) {
  if (job._timer) clearInterval(job._timer)
  if (!job.active) return
  console.log('[scheduler] start', { delegatorSA: job.delegatorSA, intervalSec: job.intervalSec, jobType: job.jobType })
  const tick = async () => {
    // Auto-stop if expired
    if (job.expiresAt && Date.now() >= job.expiresAt) {
      job.active = false
      if (job._timer) clearInterval(job._timer)
      job._timer = undefined
      console.log('[scheduler] expired', { delegatorSA: job.delegatorSA })
      // Retrait automatique MON natif (ou fallback) à la fin du cycle si ownerEOA connu
      try {
        const fs = await import('node:fs')
        const path = await import('node:path')
        const file = path.join(process.cwd(), 'data', 'delegations', `${job.delegatorSA}.json`)
        if (fs.existsSync(file)) {
          const raw = fs.readFileSync(file, 'utf8')
          const json = JSON.parse(raw)
          const eoa = json?.job?.ownerEOA as any
          if (eoa) {
            console.log('[scheduler] end-of-cycle: attempting native MON withdrawal…')
            try {
              // Appel interne: réutiliser le code déjà existant (import dynamique de server helpers non nécessaire)
              const mod = await import('./server') // pour accéder à sendUserOpWithOptionalPaymaster si requis plus tard
              // On réimplémente localement le petit bout nécessaire (évite endpoint HTTP interne):
              const { publicClient, monadTestnet, bundlerClient, paymasterClient, asToolkitClient } = await import('./clients')
              const { Implementation, toMetaMaskSmartAccount, getDeleGatorEnvironment } = await import('@metamask/delegation-toolkit')
              const { privateKeyToAccount } = await import('viem/accounts')
              const { encodePermissionContextsFromDelegations, encodeExecutionCalldatasWithModes } = await import('./encoding')
              const { WMON } = await import('./constants')
              // Removed dependency on server internal detectNativeValueScope to avoid circular + build error; fallback simple detection.
              const { encodeFunctionData } = await import('viem')
              const valueFile = path.join(process.cwd(), 'data', 'delegations', `${job.delegatorSA.toLowerCase()}__value.json`)
              if (!fs.existsSync(valueFile)) throw new Error('value_delegation_missing')
              const coreFile = path.join(process.cwd(), 'data', 'delegations', `${job.delegatorSA.toLowerCase()}.json`)
              if (!fs.existsSync(coreFile)) throw new Error('core_delegation_missing')
              const core = JSON.parse(fs.readFileSync(coreFile, 'utf8'))
              const valueDel = JSON.parse(fs.readFileSync(valueFile, 'utf8'))
              const pk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}`
              if (!pk) throw new Error('Missing DELEGATE_PRIVATE_KEY')
              const eoaAcc = privateKeyToAccount(pk)
              const env = getDeleGatorEnvironment(monadTestnet.id)
              const delegateSA = await toMetaMaskSmartAccount({
                client: asToolkitClient(),
                implementation: Implementation.Hybrid,
                deployParams: [eoaAcc.address, [], [], []],
                deploySalt: '0x',
                signer: { account: eoaAcc },
                environment: env as any,
              })
              // Détection scope natif
              const caveats = valueDel?.signedDelegation?.delegation?.caveats || []
              const nativeDetect = { hasNativeScope: caveats.some((c: any) => String(c?.enforcer||'').toLowerCase().includes('native')) }
              let calls: { to: `0x${string}`; data: `0x${string}` }[] = []
              if (nativeDetect.hasNativeScope) {
                // Un seul contexte: value delegation -> transfert natif (callData vide) vers EOA
                let bal = 0n
                try { bal = await publicClient.getBalance({ address: job.delegatorSA as Address }) } catch {}
                if (bal > 0n) {
                  const flatValue = {
                    delegate: valueDel.signedDelegation.delegation.delegate,
                    delegator: valueDel.signedDelegation.delegation.delegator,
                    authority: valueDel.signedDelegation.delegation.authority,
                    caveats: (valueDel.signedDelegation.delegation.caveats || []).map((c: any) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args })),
                    salt: valueDel.signedDelegation.delegation.salt,
                    signature: valueDel.signedDelegation.signature,
                  }
                  const [ctx] = encodePermissionContextsFromDelegations([[flatValue as any]])
                  const execGroups = [[{ target: eoa as Address, value: bal, callData: '0x' as `0x${string}` }]]
                  const { calldatas, modes } = encodeExecutionCalldatasWithModes(execGroups)
                  const DM_REDEEM_ABI = [ { type: 'function', name: 'redeemDelegations', stateMutability: 'nonpayable', inputs: [ { name: '_permissionContexts', type: 'bytes[]' }, { name: '_modes', type: 'bytes32[]' }, { name: '_executionCallDatas', type: 'bytes[]' } ], outputs: [] } ] as const
                  const dmData = encodeFunctionData({ abi: DM_REDEEM_ABI as any, functionName: 'redeemDelegations', args: [[ctx] as any, modes as any, calldatas as any] }) as `0x${string}`
                  calls = [{ to: env.DelegationManager as `0x${string}`, data: dmData }]
                } else {
                  console.log('[scheduler] no native MON to flush at end-of-cycle')
                }
              } else {
                // Fallback: withdraw WMON puis transfert natif (2 contextes)
                let wbal = 0n
                try {
                  wbal = await (publicClient as any).readContract({
                    address: WMON as Address,
                    abi: [ { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [ { name: 'owner', type: 'address' } ], outputs: [ { name: '', type: 'uint256' } ] } ] as any,
                    functionName: 'balanceOf',
                    args: [job.delegatorSA as Address],
                  }) as bigint
                } catch {}
                if (wbal > 0n) {
                  const flatCore = {
                    delegate: core.signedDelegation.delegation.delegate,
                    delegator: core.signedDelegation.delegation.delegator,
                    authority: core.signedDelegation.delegation.authority,
                    caveats: (core.signedDelegation.delegation.caveats || []).map((c: any) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args })),
                    salt: core.signedDelegation.delegation.salt,
                    signature: core.signedDelegation.signature,
                  }
                  const flatValue = {
                    delegate: valueDel.signedDelegation.delegation.delegate,
                    delegator: valueDel.signedDelegation.delegation.delegator,
                    authority: valueDel.signedDelegation.delegation.authority,
                    caveats: (valueDel.signedDelegation.delegation.caveats || []).map((c: any) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args })),
                    salt: valueDel.signedDelegation.delegation.salt,
                    signature: valueDel.signedDelegation.signature,
                  }
                  const withdrawData = encodeFunctionData({
                    abi: [ { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [ { name: 'wad', type: 'uint256' } ], outputs: [] } ] as any,
                    functionName: 'withdraw',
                    args: [wbal],
                  }) as `0x${string}`
                  const execWithdraw = { target: WMON as Address, value: 0n, callData: withdrawData }
                  const execValue = { target: eoa as Address, value: wbal, callData: '0x' as `0x${string}` }
                  const ctxArr = encodePermissionContextsFromDelegations([[flatCore as any], [flatValue as any]])
                  if (Array.isArray(ctxArr) && ctxArr.length === 2) {
                    const execGroups = [[execWithdraw], [execValue]]
                    const { calldatas, modes } = encodeExecutionCalldatasWithModes(execGroups)
                    const permissionContexts = [ctxArr[0], ctxArr[1]]
                    const DM_REDEEM_ABI = [ { type: 'function', name: 'redeemDelegations', stateMutability: 'nonpayable', inputs: [ { name: '_permissionContexts', type: 'bytes[]' }, { name: '_modes', type: 'bytes32[]' }, { name: '_executionCallDatas', type: 'bytes[]' } ], outputs: [] } ] as const
                    const dmData = encodeFunctionData({ abi: DM_REDEEM_ABI as any, functionName: 'redeemDelegations', args: [permissionContexts as any, modes as any, calldatas as any] }) as `0x${string}`
                    calls = [{ to: env.DelegationManager as `0x${string}`, data: dmData }]
                  }
                } else {
                  console.log('[scheduler] no WMON to fallback-withdraw at end-of-cycle')
                }
              }
              if (calls.length) {
                let maxFeePerGas = await publicClient.getGasPrice().catch(() => 80n * 10n ** 9n)
                if (maxFeePerGas < 80n * 10n ** 9n) maxFeePerGas = 80n * 10n ** 9n
                const maxPriorityFeePerGas = maxFeePerGas / 2n
                const wantPm = !!process.env.USE_PAYMASTER && ['true','1','yes','on','enabled'].includes(process.env.USE_PAYMASTER.toLowerCase())
                const willInject = wantPm && (process.env.ZERO_DEV_PAYMASTER_RPC || process.env.PIMLICO_PAYMASTER_RPC)
                const uoHash = await ((await import('./clients')).bundlerClient as any).sendUserOperation({
                  account: delegateSA,
                  calls,
                  maxFeePerGas,
                  maxPriorityFeePerGas,
                  ...(willInject ? { paymaster: (await import('./clients')).paymasterClient } : {}),
                })
                console.log('[scheduler] end-of-cycle withdrawal userOp', { userOperationHash: uoHash })
                try { (await import('./utils/history')).appendRunEvent({ ts: Date.now(), delegator: job.delegatorSA, amountInUSDC: '0', amountOutToken: '0', strategy: nativeDetect.hasNativeScope ? 'auto-withdraw-native' : 'auto-withdraw-fallback', userOperationHash: uoHash }) } catch {}
              }
            } catch (inner) {
              console.warn('[scheduler] end-of-cycle native withdraw failed', inner)
            }
          }
        }
      } catch (e) {
        console.warn('[scheduler] end-of-cycle flush failed', e)
      }
      return
    }
    if (job._running) return
    console.log('[scheduler] tick', { delegatorSA: job.delegatorSA, jobType: job.jobType })
    job._running = true
    try {
      if (job.jobType === 'dca_ai') {
        // Pre-tick: generate a fresh AI decision so runner can consult latest action/score from audit
        try {
          const fs = await import('node:fs')
          const path = await import('node:path')
          const file = path.join(process.cwd(), 'data', 'delegations', `${job.delegatorSA}.json`)
          let providerOverride: string | undefined
          if (fs.existsSync(file)) {
            try { const js = JSON.parse(fs.readFileSync(file, 'utf8')); providerOverride = js?.job?.inferenceProvider } catch {}
          }
          const { strategyEngine } = await import('./strategy/engine')
          const { computeCoreFeaturesAsync } = await import('./features')
          const feat = await computeCoreFeaturesAsync(job.delegatorSA as string)
          const ctx: any = {
            timestamp: Date.now(),
            delegator: job.delegatorSA,
            balances: {},
            targets: [{ symbol: 'WMON', weightBps: 5000 }],
            prices: { USDC: '1', WMON: '0' },
            recentExecutions: [],
            riskParams: { maxSlippageBps: 80, maxSingleUsd: 100 },
            marketVolatilityScore: typeof feat.features.volatilitySimple === 'number' ? feat.features.volatilitySimple : 0.35,
            strategyProfile: 'default',
            inferenceProviderOverride: providerOverride,
          }
          const decision = await strategyEngine.decide(ctx)
          // Persist audit line minimally (reuse server appendAudit typing without pulling heavy deps)
          try {
            const { appendAudit } = await import('./audit')
            const { hashRationale } = await import('./strategy/engine')
            const aiRationaleHash = hashRationale(decision.rationale)
            const meta = decision.meta || {}
            appendAudit({ action: 'ai_decision', ts: ctx.timestamp, delegator: job.delegatorSA, delegate: '0x', role: 'ai', structHash:'0x', digest:'0x', domainSeparator:'0x', caveatsRoot:'0x', salt:'0x', warnings:[], signatureModel:'UNKNOWN', aiRationaleHash, aiRiskScore: decision.riskScore, aiConfidence: decision.confidence, strategyEngineVersion: typeof (strategyEngine as any).version === 'function' ? (strategyEngine as any).version() : 'det-v1', aiActionType: decision.actionType, aiTargetSymbol: Array.isArray(decision.steps) && (decision as any).steps?.[0]?.to ? (decision as any).steps[0].to : undefined, featureHash: (feat as any).featureHash, featureHashV2: (feat as any).featureHashV2, featureSchemaVersion: (feat as any).schemaVersion, modelHash: meta.modelHash, inferenceProvider: meta.inferenceProvider, featuresCanonical: undefined, inferenceVersion: meta.inferenceVersion, inferenceFeatures: { allocationDeviation: feat.features.allocationDeviation ?? 0, executionsLast24h: feat.features.executionsLast24h ?? 0, volatilitySimple: feat.features.volatilitySimple ?? 0 }, rawScore: meta.rawScore, logitZ: meta.logitZ, mappingVersion: meta.mappingVersion, weightsUsedHash: meta.weightsUsedHash, inferenceProofHash: meta.inferenceProofHash })
          } catch (e) { console.warn('[scheduler] append ai_decision failed (non-blocking)', (e as any)?.message || e) }

          // Check AI decision before executing
          if (decision && decision.actionType === 'SKIP') {
            console.log('[scheduler] AI decided SKIP, skipping execution for', job.delegatorSA)
            job.lastRunAt = Date.now()
            job.lastError = undefined
            job.runsDone = (job.runsDone || 0) + 1
            return
          }
        } catch (e) { console.warn('[scheduler] pre-tick decision failed (non-blocking)', (e as any)?.message || e) }
        const hash = await runOnceForDelegator(job.delegatorSA)
        job.lastRunAt = Date.now()
        job.lastOpHash = hash
        job.lastError = undefined
        job.runsDone = (job.runsDone || 0) + 1
      } else {
        // dca_schedule: execute regardless of AI, using ignoreAi flag
        const hash = await runOnceForDelegator(job.delegatorSA, { ignoreAi: true })
        job.lastRunAt = Date.now()
        job.lastOpHash = hash
        job.lastError = undefined
        job.runsDone = (job.runsDone || 0) + 1
      }
    } catch (e: any) {
      job.lastRunAt = Date.now()
      job.lastError = e?.message || String(e)
    } finally {
      job._running = false
    }
  }
  job._timer = setInterval(tick, Math.max(5, job.intervalSec) * 1000)
}

export function startJob(
  delegatorSA: Address,
  intervalSec: number,
  opts?: { durationSec?: number; immediate?: boolean; expiresAtMs?: number; jobType?: 'dca_ai' | 'dca_schedule' }
): JobStatus {
  const key = delegatorSA.toLowerCase()
  const existing = jobs[key]
  const now = Date.now()
  const expiresAt = opts?.expiresAtMs
    ? opts.expiresAtMs
    : (opts?.durationSec && opts.durationSec > 0 ? now + opts.durationSec * 1000 : undefined)
  const jobType = opts?.jobType || existing?.jobType || 'dca_ai'
  const job: InternalJob = existing
    ? { ...existing, intervalSec, active: true, expiresAt, jobType }
    : { delegatorSA, intervalSec, active: true, expiresAt, runsDone: 0, jobType }
  jobs[key] = job
  // Toujours réinitialiser lastRunAt lors d'un nouveau start pour un timer cohérent
  // Sauf si immediate=true, auquel cas on laisse runOnceForDelegator le mettre à jour
  if (!opts?.immediate) {
    job.lastRunAt = Date.now()
  } else {
    // Pour immediate=true, on remet à zéro pour que l'exécution immédiate définisse le timing
    job.lastRunAt = undefined
  }
  schedule(job)
  // Optional immediate tick on start
  if (opts?.immediate) {
    // Fire and forget; interval will continue afterwards
    Promise.resolve().then(async () => {
      if (!job.active) return
      try {
        if (job.jobType === 'dca_ai') {
          // For AI job, do not force execution if AI would SKIP
          const { strategyEngine } = await import('./strategy/engine')
          const { computeCoreFeaturesAsync } = await import('./features')
          const feat = await computeCoreFeaturesAsync(job.delegatorSA as string)
          const ctx: any = { timestamp: Date.now(), delegator: job.delegatorSA, balances: {}, targets: [{ symbol: 'WMON', weightBps: 5000 }], prices: { USDC: '1', WMON: '0' }, recentExecutions: [], riskParams: { maxSlippageBps: 80, maxSingleUsd: 100 }, marketVolatilityScore: typeof feat.features.volatilitySimple === 'number' ? feat.features.volatilitySimple : 0.35, strategyProfile: 'default' }
          const decision = await strategyEngine.decide(ctx)
          if (decision?.actionType === 'SKIP') {
            console.log('[scheduler] immediate: AI decided SKIP, skipping execution for', job.delegatorSA)
            job.lastRunAt = Date.now()
            job.lastError = undefined
            job.runsDone = (job.runsDone || 0) + 1
            return
          }
          const hash = await runOnceForDelegator(job.delegatorSA)
          job.lastOpHash = hash
        } else {
          const hash = await runOnceForDelegator(job.delegatorSA, { ignoreAi: true })
          job.lastOpHash = hash
        }
        job.lastRunAt = Date.now()
        job.lastError = undefined
        job.runsDone = (job.runsDone || 0) + 1
      } catch (e: any) {
        job.lastRunAt = Date.now()
        job.lastError = e?.message || String(e)
      }
    })
  }
  return publicStatus(job)
}

export function stopJob(delegatorSA: Address): JobStatus | null {
  const key = delegatorSA.toLowerCase()
  const job = jobs[key]
  if (!job) return null
  job.active = false
  if (job._timer) clearInterval(job._timer)
  job._timer = undefined
  // Réinitialiser le timer : supprimer lastRunAt pour que le prochain start reparte de 0
  job.lastRunAt = undefined
  job.lastError = undefined
  console.log('[scheduler] stop + reset timer', { delegatorSA })
  return publicStatus(job)
}

export function runNow(delegatorSA: Address): Promise<JobStatus | null> {
  const key = delegatorSA.toLowerCase()
  const job = jobs[key]
  if (!job) return Promise.resolve(null)
  return (async () => {
    try {
      const hash = await runOnceForDelegator(job.delegatorSA, { ignoreAi: job.jobType === 'dca_schedule' })
      job.lastRunAt = Date.now()
      job.lastOpHash = hash
      job.lastError = undefined
    } catch (e: any) {
      job.lastRunAt = Date.now()
      job.lastError = e?.message || String(e)
    }
    return publicStatus(job)
  })()
}

export function getJobs(): JobStatus[] {
  return Object.values(jobs).map(publicStatus)
}

function publicStatus(job: InternalJob): JobStatus {
  const { delegatorSA, intervalSec, active, jobType, lastRunAt, lastOpHash, lastError, expiresAt, runsDone } = job
  return { delegatorSA, intervalSec, active, jobType, lastRunAt, lastOpHash, lastError, expiresAt, runsDone }
}
