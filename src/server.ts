import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import { writeFileSync, mkdirSync, existsSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publicClient, monadTestnet, bundlerClient } from './clients'
import { startJob, stopJob, runNow, getJobs } from './scheduler'
import { decodeErrorResult } from 'viem'
import { runOnceForDelegator } from './runner'
import { buildDebugBundle } from './utils/debug'
import { Implementation, toMetaMaskSmartAccount, getDeleGatorEnvironment } from '@metamask/delegation-toolkit'
import { privateKeyToAccount } from 'viem/accounts'
import { USDC, UNISWAP_V2_ROUTER02, WMON } from './constants'
import { encodePermissionContextsFromDelegations, encodeExecutionCalldatasWithModes } from './encoding'
import { Address, encodeFunctionData } from 'viem'

const app = express()
app.use(cors({ origin: true }))
app.use(express.json({ limit: '256kb' }))
// In-memory log buffer to expose logs via HTTP for convenience
const LOG_BUFFER: string[] = []
function pushLog(prefix: string, args: any[]) {
  try {
    const ts = new Date().toISOString()
    const line = `${ts} ${prefix} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`
    LOG_BUFFER.push(line)
    if (LOG_BUFFER.length > 500) LOG_BUFFER.shift()
  } catch {}
}
// Patch console to also write to buffer (non-invasive)
const _log = console.log.bind(console)
console.log = (...args: any[]) => {
  pushLog('[log]', args)
  _log(...args)
}
const _error = console.error.bind(console)
console.error = (...args: any[]) => {
  pushLog('[err]', args)
  _error(...args)
}
// Simple request logger
app.use((req, _res, next) => {
  const start = Date.now()
  const id = Math.random().toString(36).slice(2, 8)
  console.log(`[api] >> ${id} ${req.method} ${req.path}`)
  ;(req as any).__reqId = id
  _res.on('finish', () => {
    console.log(`[api] << ${id} ${req.method} ${req.path} ${_res.statusCode} ${Date.now() - start}ms`)
  })
  next()
})

let cachedDelegate: { eoa: string; sa: string; envSupported?: boolean } | null = null
// Root landing page for quick sanity check
app.get('/', (_req, res) => {
  res.json({ ok: true, name: 'DCA API', endpoints: ['/api/health', '/api/delegate', '/api/diag'] })
})
app.get('/api/health', (_req, res) => res.json({ ok: true }))
// Lightweight cached git version info to avoid spawning repeatedly
let CACHED_VERSION: { git: string; resolvedAt: number } | null = null
function resolveGitShort(): string {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT.slice(0, 12)
  try {
    // Try reading .git/HEAD then referenced ref for detached-less lookup
    const fs = require('node:fs') as typeof import('node:fs')
    const headPath = join(process.cwd(), '.git', 'HEAD')
    if (fs.existsSync(headPath)) {
      const head = fs.readFileSync(headPath, 'utf8').trim()
      if (head.startsWith('ref:')) {
        const ref = head.split(' ')[1].trim()
        const refPath = join(process.cwd(), '.git', ref)
        if (fs.existsSync(refPath)) {
          const full = fs.readFileSync(refPath, 'utf8').trim()
          if (full) return full.slice(0, 12)
        }
      } else if (/^[0-9a-f]{40}$/i.test(head)) {
        return head.slice(0, 12)
      }
    }
  } catch {}
  try {
    const cp = require('node:child_process').execSync('git rev-parse --short HEAD', { stdio: ['ignore','pipe','ignore'] })
    return String(cp).trim()
  } catch {}
  return 'unknown'
}
app.get('/api/version', (_req, res) => {
  const now = Date.now()
  if (!CACHED_VERSION || now - CACHED_VERSION.resolvedAt > 15_000) {
    CACHED_VERSION = { git: resolveGitShort(), resolvedAt: now }
  }
  res.json({ ok: true, ts: now, git: CACHED_VERSION.git })
})
// Enumerate registered routes (debug)
app.get('/api/routes', (_req, res) => {
  try {
    const anyApp: any = app as any
    const stack = (anyApp?._router?.stack || [])
    const routes = stack
      .filter((l: any) => l.route && l.route.path)
      .map((l: any) => ({
        path: l.route.path,
        methods: Object.keys(l.route.methods || {}),
      }))
    return res.json({ ok: true, count: routes.length, routes })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'failed' })
  }
})
// View recent logs in the browser (last 200 lines by default)
app.get('/api/_logs', (req, res) => {
  const n = Math.min(Number(req.query.n ?? 200), 500)
  const tail = LOG_BUFFER.slice(-n)
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.send(tail.join('\n'))
})
app.get('/api/delegate', async (_req, res) => {
  try {
    if (!cachedDelegate) {
      const pk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}`
      if (!pk) return res.status(500).json({ error: 'Missing DELEGATE_PRIVATE_KEY' })
      const eoa = privateKeyToAccount(pk)
      let env: any | undefined
      try {
        env = getDeleGatorEnvironment(monadTestnet.id)
      } catch (err) {
        console.warn('[delegation] Environment not found for chain', monadTestnet.id, err)
      }
      const sa = await toMetaMaskSmartAccount({
        client: publicClient,
        implementation: Implementation.Hybrid,
        deployParams: [eoa.address, [], [], []],
        deploySalt: '0x',
        signer: { account: eoa },
        ...(env ? { environment: env } : {}),
      })
      cachedDelegate = { eoa: eoa.address, sa: sa.address, envSupported: !!env }
    }
    return res.json(cachedDelegate)
  } catch (e: any) {
    console.error('GET /api/delegate failed:', e)
    return res.status(500).json({ error: e?.message || 'failed', stack: e?.stack })
  }
})

// Quick diagnostics: balances and router quote for the given delegator smart account
app.get('/api/diag', async (req, res) => {
  try {
    const delegator = (req.query.delegator as string | undefined) as `0x${string}` | undefined
    const amount = BigInt((req.query.amountUsdc as string | undefined) ?? '1000000') // 1 USDC default (6 decimals)
    const out: any = { chainId: monadTestnet.id }
    // Ensure delegate SA is available
    if (!cachedDelegate) {
      const pk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}`
      if (pk) {
        const eoa = privateKeyToAccount(pk)
        let env: any | undefined
        try { env = getDeleGatorEnvironment(monadTestnet.id) } catch {}
        const sa = await toMetaMaskSmartAccount({
          client: publicClient,
          implementation: Implementation.Hybrid,
          deployParams: [eoa.address, [], [], []],
          deploySalt: '0x',
          signer: { account: eoa },
          ...(env ? { environment: env } : {}),
        })
        cachedDelegate = { eoa: eoa.address, sa: sa.address, envSupported: !!env }
      }
    }
    out.delegate = cachedDelegate || null
    // Add delegate balances if available
    try {
      if (cachedDelegate?.sa) {
        const [balMon, balToken, balWmon] = await Promise.all([
          publicClient.getBalance({ address: cachedDelegate.sa as `0x${string}` }),
          publicClient.readContract({
            address: USDC,
            abi: [ { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] } ] as any,
            functionName: 'balanceOf',
            args: [cachedDelegate.sa as `0x${string}`],
          }) as Promise<bigint>,
          publicClient.readContract({
            address: WMON,
            abi: [ { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] } ] as any,
            functionName: 'balanceOf',
            args: [cachedDelegate.sa as `0x${string}`],
          }) as Promise<bigint>,
        ])
        out.delegateBalances = { mon: balMon.toString(), usdc: (balToken as bigint).toString(), wmon: (balWmon as bigint).toString() }
      }
    } catch (e: any) {
      out.delegateBalancesError = String(e?.message || e)
    }
    if (delegator) {
      out.delegator = delegator
      try {
        const [balMon, balToken, balWmon] = await Promise.all([
          publicClient.getBalance({ address: delegator }),
          publicClient.readContract({
            address: USDC,
            abi: [ { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] } ] as any,
            functionName: 'balanceOf',
            args: [delegator],
          }) as Promise<bigint>,
          publicClient.readContract({
            address: WMON,
            abi: [ { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] } ] as any,
            functionName: 'balanceOf',
            args: [delegator],
          }) as Promise<bigint>,
        ])
        out.delegatorBalances = { mon: balMon.toString(), usdc: (balToken as bigint).toString(), wmon: (balWmon as bigint).toString() }
      } catch (e: any) {
        out.delegatorBalancesError = String(e?.message || e)
      }
    }
    // Paymaster-independent router quote (if pool exists)
    try {
      const amounts = await publicClient.readContract({
        address: UNISWAP_V2_ROUTER02,
        abi: [
          { name: 'getAmountsOut', type: 'function', stateMutability: 'view', inputs: [ { name: 'amountIn', type: 'uint256' }, { name: 'path', type: 'address[]' } ], outputs: [{ name: 'amounts', type: 'uint256[]' }] },
        ] as any,
        functionName: 'getAmountsOut',
        args: [amount, [USDC, WMON]],
      }) as bigint[]
      out.quote = { in: amount.toString(), out: (amounts?.[1] as bigint | undefined)?.toString() }
    } catch (e: any) {
      out.quoteError = String(e?.message || e)
    }
  return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'diag failed' })
  }
})

// Créer / stocker une délégation. Paramètre facultatif ?role=VALUE pour stocker plusieurs rôles.
// Rôle par défaut: "core" (fichier: <delegator>.json). Rôle autre: <delegator>__<role>.json
app.post('/api/delegations', async (req, res) => {
  let { delegatorSA, signedDelegation, job } = req.body || {}
  const role = (req.query.role as string | undefined)?.toLowerCase() || 'core'
  if (typeof delegatorSA === 'string') delegatorSA = delegatorSA.toLowerCase()
  if (!delegatorSA || !signedDelegation) return res.status(400).json({ error: 'Missing delegatorSA or signedDelegation', role })
  const dir = join(process.cwd(), 'data', 'delegations')
  mkdirSync(dir, { recursive: true })
  const baseName = role === 'core' ? `${delegatorSA}.json` : `${delegatorSA}__${role}.json`
  const enrichedJob = role === 'core'
    ? ({ createdAtMs: Date.now(), unwrapEvery: Number(job?.unwrapEvery ?? 24), ...job })
    : undefined // seules les meta de job sur la délégation core
  const payload: any = { delegatorSA, signedDelegation }
  if (enrichedJob) payload.job = enrichedJob
  writeFileSync(join(dir, baseName), JSON.stringify(payload, null, 2))
  console.log('[api/delegations] intake', {
    role,
    file: baseName,
    delegatorSA,
    hasSigned: !!signedDelegation,
    signedShape: {
      hasDelegation: !!signedDelegation?.delegation,
      hasSignature: !!signedDelegation?.signature,
      caveats: Array.isArray(signedDelegation?.delegation?.caveats) ? signedDelegation.delegation.caveats.length : 'n/a',
      saltType: typeof signedDelegation?.delegation?.salt,
    },
    jobKeys: enrichedJob ? Object.keys(job || {}) : [],
  })
  // Si ce n'est pas la délégation core on ne lance pas le job
  if (role !== 'core') return res.json({ ok: true, role, notice: 'Délégation rôle ajoutée' })
  try {
    let usdcBal = 0n
    try {
      usdcBal = await publicClient.readContract({
        address: USDC,
        abi: [ { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] } ] as any,
        functionName: 'balanceOf',
        args: [delegatorSA as Address],
      }) as bigint
    } catch {}
    const iv = Number(job?.intervalSec)
    let startedJob: any = null
    let immediateResult: { ok: boolean; hash?: string; error?: string } | null = null
    try {
      const hash = await runOnceForDelegator(delegatorSA as Address, { runIndex: 0 })
      immediateResult = { ok: true, hash }
    } catch (e: any) {
      immediateResult = { ok: false, error: e?.message || String(e) }
    }
    if (!Number.isNaN(iv) && iv > 0) {
      const durationSec = Number(job?.durationSec) > 0 ? Number(job?.durationSec) : 24 * 60 * 60
      startedJob = startJob(delegatorSA, Math.max(10, iv), { durationSec, immediate: false })
    }
    const needsTopup = usdcBal === 0n
    return res.json({
      ok: true,
      role,
      job: startedJob,
      needsTopup,
      immediateRun: immediateResult,
      notice: immediateResult?.ok ? 'Premier swap exécuté immédiatement' : `Tentative immédiate échouée: ${immediateResult?.error}`,
    })
  } catch (e: any) {
    return res.status(500).json({ ok: false, role, error: e?.message || 'post-delegation failed' })
  }
})

// Check if a signed delegation exists for a delegator smart account
// GET /api/delegations/:delegatorSA
app.get('/api/delegations/:delegatorSA', async (req, res) => {
  try {
    const delegatorSA = (req.params.delegatorSA || '').toLowerCase()
    if (!delegatorSA.startsWith('0x') || delegatorSA.length !== 42) {
      return res.status(400).json({ error: 'Invalid delegatorSA' })
    }
    const dir = join(process.cwd(), 'data', 'delegations')
    const roles: string[] = []
    let coreJson: any = null
    let coreFileName: string | null = null
    const matchedFiles: string[] = []
    let allFiles: string[] = []
    let renameAttempt = false
    let renameError: string | null = null
    try {
      const files = require('node:fs').readdirSync(dir)
      allFiles = files
      for (const f of files) {
        const fl = f.toLowerCase()
        if (!fl.startsWith(delegatorSA)) continue
        if (fl === `${delegatorSA}.json`) {
          roles.push('core')
          coreFileName = f // preserve original case
          matchedFiles.push(f)
        } else if (/__([a-z0-9_-]+)\.json$/.test(fl)) {
          const m = fl.match(/__([a-z0-9_-]+)\.json$/)
          if (m?.[1]) roles.push(m[1])
          matchedFiles.push(f)
        }
      }
      // Backward compatibility: if no lowercase core file but a single file matches case-insensitively, pick it
      if (!coreFileName) {
        const legacy = files?.find((f: string) => f.toLowerCase() === `${delegatorSA}.json`)
        if (legacy) {
          coreFileName = legacy
          if (!roles.includes('core')) roles.push('core')
          if (!matchedFiles.includes(legacy)) matchedFiles.push(legacy)
        }
      }
      // Optionally normalize filename to lowercase for future (rename once)
      if (coreFileName && coreFileName !== `${delegatorSA}.json`) {
        try {
          const from = join(dir, coreFileName)
          const to = join(dir, `${delegatorSA}.json`)
          renameAttempt = true
          require('node:fs').renameSync(from, to)
          coreFileName = `${delegatorSA}.json`
          console.log('[delegations] normalized filename to lowercase', { delegatorSA })
        } catch (e: any) {
          renameAttempt = true
            renameError = e?.message || String(e)
        }
      }
    } catch (e) {
      // ignore directory read errors
    }
    const out: any = { ok: true, roles, exists: roles.includes('core') }
    if (roles.includes('core') && coreFileName) {
      try {
        const raw = readFileSync(join(dir, coreFileName), 'utf8')
        coreJson = JSON.parse(raw)
        if (coreJson?.job) out.job = coreJson.job
      } catch (e) {
        out.coreReadError = String((e as any)?.message || e)
      }
    }
    // Truncate allFiles if large
    const truncatedAll = allFiles.slice(0, 50)
    out.debug = { coreFileName, fileCount: roles.length, matchedFiles, allFiles: truncatedAll, allFilesTruncated: allFiles.length > truncatedAll.length, renameAttempt, renameError }
    return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'check failed' })
  }
})

// Retrait MON natif amélioré:
// 1) Si la value delegation possède le caveat nativeTokenTransferAmount => transfert direct du solde (ou partiel si amount) en un seul contexte.
// 2) Sinon fallback historique: withdraw WMON via core + transfert natif via value (2 contextes).
app.post('/api/send-mon', async (req, res) => {
  try {
    let { delegatorSA, amount } = req.body || {}
    if (typeof delegatorSA === 'string') delegatorSA = delegatorSA.toLowerCase()
    if (!delegatorSA) return res.status(400).json({ error: 'Missing delegatorSA' })
    const dir = join(process.cwd(), 'data', 'delegations')
    const coreFile = join(dir, `${delegatorSA}.json`)
    const valueFile = join(dir, `${delegatorSA}__value.json`)
    if (!existsSync(coreFile)) return res.status(404).json({ error: 'core_delegation_missing', stage: 'read_core_file' })
    if (!existsSync(valueFile)) return res.status(404).json({ error: 'value_delegation_missing', stage: 'read_value_file' })
    const core = JSON.parse(readFileSync(coreFile, 'utf8'))
    const valueDel = JSON.parse(readFileSync(valueFile, 'utf8'))
    const ownerEOA = core?.job?.ownerEOA as string | undefined
    if (!ownerEOA) return res.status(400).json({ error: 'ownerEOA_missing', stage: 'owner_eoa' })

    // Détection scope natif: présence d'un caveat avec terms contenant 'nativeTokenTransferAmount'
    let hasNativeScope = false
    try {
      const caveats = valueDel?.signedDelegation?.delegation?.caveats || []
      hasNativeScope = caveats.some((c: any) => typeof c?.terms === 'string' && c.terms.includes('nativeTokenTransferAmount'))
    } catch {}

    if (hasNativeScope) {
      // Chemin direct: un seul contexte (value) et une exécution value -> ownerEOA avec callData vide
      let nativeBal = 0n
      try { nativeBal = await publicClient.getBalance({ address: delegatorSA as Address }) } catch {}
      if (nativeBal === 0n) return res.status(400).json({ error: 'no_mon_balance', mode: 'native-scope' })
      let wad: bigint
      if (amount != null) {
        try { wad = BigInt(String(amount)) } catch { wad = nativeBal }
        if (wad <= 0n || wad > nativeBal) wad = nativeBal
      } else wad = nativeBal
      const flatValue = {
        delegate: valueDel.signedDelegation.delegation.delegate,
        delegator: valueDel.signedDelegation.delegation.delegator,
        authority: valueDel.signedDelegation.delegation.authority,
        caveats: (valueDel.signedDelegation.delegation.caveats || []).map((c: any) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args })),
        salt: valueDel.signedDelegation.delegation.salt,
        signature: valueDel.signedDelegation.signature,
      }
      const { encodePermissionContextsFromDelegations, encodeExecutionCalldatasWithModes } = await import('./encoding')
      const [ctx] = encodePermissionContextsFromDelegations([[flatValue as any]])
      const execGroups = [[{ target: ownerEOA as Address, value: wad, callData: '0x' as `0x${string}` }]]
      const { calldatas, modes } = encodeExecutionCalldatasWithModes(execGroups)
      const DM_REDEEM_ABI = [ { type: 'function', name: 'redeemDelegations', stateMutability: 'nonpayable', inputs: [ { name: '_permissionContexts', type: 'bytes[]' }, { name: '_modes', type: 'bytes32[]' }, { name: '_executionCallDatas', type: 'bytes[]' } ], outputs: [] } ] as const
      const dmData = encodeFunctionData({ abi: DM_REDEEM_ABI as any, functionName: 'redeemDelegations', args: [[ctx] as any, modes as any, calldatas as any] }) as `0x${string}`
      const pk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}`
      if (!pk) return res.status(500).json({ error: 'Missing DELEGATE_PRIVATE_KEY' })
      const eoa = privateKeyToAccount(pk)
      const env = getDeleGatorEnvironment(monadTestnet.id)
      const delegateSA = await toMetaMaskSmartAccount({
        client: publicClient,
        implementation: Implementation.Hybrid,
        deployParams: [eoa.address, [], [], []],
        deploySalt: '0x',
        signer: { account: eoa },
        environment: env as any,
      })
      let maxFeePerGas = await publicClient.getGasPrice().catch(() => 80n * 10n ** 9n)
      if (maxFeePerGas < 80n * 10n ** 9n) maxFeePerGas = 80n * 10n ** 9n
      const maxPriorityFeePerGas = maxFeePerGas / 2n
      const uoHash = await bundlerClient.sendUserOperation({
        account: delegateSA,
        calls: [{ to: env.DelegationManager as Address, data: dmData }],
        maxFeePerGas,
        maxPriorityFeePerGas,
      })
      return res.json({ ok: true, userOperationHash: uoHash, transferred: wad.toString(), mode: 'native-scope' })
    }

    // Fallback historique (WMON withdraw + transfert) si pas de caveat natif
    // Lire balance WMON pour withdraw
    let wbal = 0n
    try {
      wbal = await publicClient.readContract({
        address: WMON as Address,
        abi: [ { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [ { name: 'owner', type: 'address' } ], outputs: [ { name: '', type: 'uint256' } ] } ] as any,
        functionName: 'balanceOf',
        args: [delegatorSA as Address],
      }) as bigint
    } catch {}
    if (wbal === 0n) return res.status(400).json({ error: 'no_wmon_balance', stage: 'balance_check', wmonBalance: '0', mode: 'fallback-wmon' })
    let wad: bigint
    if (amount != null) {
      try { wad = BigInt(String(amount)) } catch { wad = wbal }
      if (wad <= 0n || wad > wbal) wad = wbal
    } else wad = wbal
    const { encodeFunctionData } = await import('viem')
    const withdrawData = encodeFunctionData({
      abi: [ { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [ { name: 'wad', type: 'uint256' } ], outputs: [] } ] as any,
      functionName: 'withdraw',
      args: [wad],
    }) as `0x${string}`
    const execWithdraw = { target: WMON as Address, value: 0n, callData: withdrawData }
    const execValue = { target: ownerEOA as Address, value: wad, callData: '0x' as `0x${string}` }
    // Encodage multi-contexte: [[coreDelegationChain],[valueDelegationChain]]
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
    const { encodePermissionContextsFromDelegations, encodeExecutionCalldatasWithModes } = await import('./encoding')
    const ctxArr = encodePermissionContextsFromDelegations([[flatCore as any], [flatValue as any]])
  if (!Array.isArray(ctxArr) || ctxArr.length !== 2) return res.status(500).json({ error: 'ctx_encode_failed', stage: 'encode_contexts' })
    // 2 groupes: withdraw (ctx0), value transfer (ctx1)
    const execGroups = [[execWithdraw], [execValue]]
    const { calldatas, modes } = encodeExecutionCalldatasWithModes(execGroups)
    // permissionContexts ordre = context index correspondant
    const permissionContexts = [ctxArr[0], ctxArr[1]]
    const DM_REDEEM_ABI = [ { type: 'function', name: 'redeemDelegations', stateMutability: 'nonpayable', inputs: [ { name: '_permissionContexts', type: 'bytes[]' }, { name: '_modes', type: 'bytes32[]' }, { name: '_executionCallDatas', type: 'bytes[]' } ], outputs: [] } ] as const
    const dmData = encodeFunctionData({ abi: DM_REDEEM_ABI as any, functionName: 'redeemDelegations', args: [permissionContexts as any, modes as any, calldatas as any] }) as `0x${string}`
    const pk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}`
    if (!pk) return res.status(500).json({ error: 'Missing DELEGATE_PRIVATE_KEY' })
    const eoa = privateKeyToAccount(pk)
    const env = getDeleGatorEnvironment(monadTestnet.id)
    const delegateSA = await toMetaMaskSmartAccount({
      client: publicClient,
      implementation: Implementation.Hybrid,
      deployParams: [eoa.address, [], [], []],
      deploySalt: '0x',
      signer: { account: eoa },
      environment: env as any,
    })
    let maxFeePerGas = await publicClient.getGasPrice().catch(() => 80n * 10n ** 9n)
    if (maxFeePerGas < 80n * 10n ** 9n) maxFeePerGas = 80n * 10n ** 9n
    const maxPriorityFeePerGas = maxFeePerGas / 2n
    const uoHash = await bundlerClient.sendUserOperation({
      account: delegateSA,
      calls: [{ to: env.DelegationManager as Address, data: dmData }],
      maxFeePerGas,
      maxPriorityFeePerGas,
    })
    return res.json({ ok: true, userOperationHash: uoHash, withdrawn: wad.toString(), mode: 'fallback-wmon' })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'send_mon_failed' })
  }
})

// Resolve a userOperation hash to its receipt/transaction hash via the bundler
// GET /api/userop/:hash?waitMs=15000
app.get('/api/userop/:hash', async (req, res) => {
  try {
    const hash = (req.params.hash || '').toLowerCase() as `0x${string}`
    if (!hash || !hash.startsWith('0x') || hash.length !== 66) {
      return res.status(400).json({ error: 'Invalid userOperation hash' })
    }
    const waitMs = Math.min(Number(req.query.waitMs ?? 0), 60000)
    const started = Date.now()
    async function fetchOnce() {
      try {
        const receipt: any = await (bundlerClient as any).request?.({
          method: 'eth_getUserOperationReceipt',
          params: [hash],
        })
        return receipt
      } catch (e: any) {
        return { error: String(e?.message || e) }
      }
    }
    let receipt = await fetchOnce()
    if (!receipt && waitMs > 0) {
      // Poll every 1s until timeout
      while (!receipt && Date.now() - started < waitMs) {
        await new Promise((r) => setTimeout(r, 1000))
        receipt = await fetchOnce()
      }
    }
    if (!receipt) return res.json({ ok: true, hash, found: false, pending: true })
    // Normalize output
    const txHash = receipt?.receipt?.transactionHash || receipt?.transactionHash || null
    const blockNumber = receipt?.receipt?.blockNumber || null
    const status = receipt?.receipt?.status ?? null
    return res.json({ ok: true, hash, found: true, txHash, blockNumber, status, raw: receipt })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'lookup failed' })
  }
})

// Simple DCA job control endpoints
app.get('/api/jobs', (_req, res) => res.json({ ok: true, jobs: getJobs() }))
app.post('/api/jobs/start', async (req, res) => {
  try {
    const { delegatorSA, intervalSec, durationSec, immediate, expiresAtMs, unwrapToMon } = req.body || {}
    if (!delegatorSA) return res.status(400).json({ error: 'Missing delegatorSA' })
    // If unwrapToMon passed, patch delegation JSON job config
    if (typeof unwrapToMon === 'boolean') {
      try {
        const file = join(process.cwd(), 'data', 'delegations', `${delegatorSA.toLowerCase()}.json`)
        if (existsSync(file)) {
          const raw = readFileSync(file, 'utf8')
          const json = JSON.parse(raw)
            json.job = json.job || {}
            json.job.unwrapToMon = unwrapToMon
            json.job.unwrapEvery = unwrapToMon ? 1 : (json.job.unwrapEvery || 24)
            // Clear cached executions batch so runner rebuilds with withdraw if needed
            delete json.job.executions
          writeFileSync(file, JSON.stringify(json, null, 2))
        }
      } catch (e) { console.warn('[jobs/start] unwrap patch failed', e) }
    }
    const iv = Math.max(10, Number(intervalSec ?? 60))
    const j = startJob(delegatorSA, iv, {
      durationSec: typeof durationSec === 'number' ? durationSec : undefined,
      immediate: Boolean(immediate),
      expiresAtMs: typeof expiresAtMs === 'number' ? expiresAtMs : undefined,
    })
    return res.json({ ok: true, job: j })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'start_failed' })
  }
})
app.post('/api/jobs/stop', async (req, res) => {
  const { delegatorSA } = req.body || {}
  if (!delegatorSA) return res.status(400).json({ error: 'Missing delegatorSA' })
  const j = stopJob(delegatorSA)
  if (!j) return res.status(404).json({ error: 'Job not found' })
  return res.json({ ok: true, job: j })
})
app.post('/api/jobs/run', async (req, res) => {
  const { delegatorSA } = req.body || {}
  if (!delegatorSA) return res.status(400).json({ error: 'Missing delegatorSA' })
  const j = await runNow(delegatorSA)
  if (!j) return res.status(404).json({ error: 'Job not found' })
  return res.json({ ok: true, job: j })
})

// Manual unwrap endpoint: executes WMON.withdraw for the delegator SA under existing delegation
app.post('/api/unwrap', async (req, res) => {
  try {
    let { delegatorSA, amount, percent } = req.body || {}
    if (typeof delegatorSA === 'string') delegatorSA = delegatorSA.toLowerCase()
    if (!delegatorSA) return res.status(400).json({ error: 'Missing delegatorSA' })
    const file = join(process.cwd(), 'data', 'delegations', `${delegatorSA}.json`)
    if (!existsSync(file)) return res.status(404).json({ error: 'No delegation found for delegator' })
    const raw = readFileSync(file, 'utf8')
    const json = JSON.parse(raw)
    const signed = json.signedDelegation
    const pk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}`
    if (!pk) return res.status(500).json({ error: 'Missing DELEGATE_PRIVATE_KEY' })
    const eoa = privateKeyToAccount(pk)
    let env: any
    try { env = getDeleGatorEnvironment(monadTestnet.id) } catch {}
    const sa = await toMetaMaskSmartAccount({
      client: publicClient,
      implementation: Implementation.Hybrid,
      deployParams: [eoa.address, [], [], []],
      deploySalt: '0x',
      signer: { account: eoa },
      ...(env ? { environment: env } : {}),
    })
    // Determine withdraw amount:
    // Priority: explicit amount > percent (0-100) > default 96% if amount not provided/zero
    let wad = 0n
    if (amount != null) {
      try { wad = BigInt(String(amount)) } catch { wad = 0n }
    }
    let chosenPercent: number | null = null
    if (wad === 0n) {
      // fetch full balance
      let bal = 0n
      try {
        bal = await publicClient.readContract({
          address: WMON,
          abi: [ { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] } ] as any,
          functionName: 'balanceOf',
          args: [delegatorSA as Address],
        }) as bigint
      } catch {}
      // resolve percent
      let p = 96
      if (percent != null) {
        const pn = Number(percent)
        if (!Number.isNaN(pn) && pn > 0 && pn <= 100) p = pn
      }
      chosenPercent = p
      wad = (bal * BigInt(p)) / 100n
      if (wad === 0n && bal > 0n) wad = bal // ensure non-zero if balance positive
    }
    if (wad === 0n) return res.status(400).json({ error: 'No WMON to unwrap' })
    const callData = encodeFunctionData({
      abi: [{ name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'wad', type: 'uint256' }], outputs: [] }] as any,
      functionName: 'withdraw',
      args: [wad],
    })
    const exec = [{ target: WMON as Address, value: 0n, callData }]
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
    const DM_REDEEM_ABI = [ { type: 'function', name: 'redeemDelegations', stateMutability: 'nonpayable', inputs: [ { name: '_permissionContexts', type: 'bytes[]' }, { name: '_modes', type: 'bytes32[]' }, { name: '_executionCallDatas', type: 'bytes[]' } ], outputs: [] } ] as const
    const data = encodeFunctionData({ abi: DM_REDEEM_ABI as any, functionName: 'redeemDelegations', args: [[ctx] as any, modes as any, calldatas as any] }) as `0x${string}`
    let maxFeePerGas: bigint = 80n * 10n ** 9n
    let maxPriorityFeePerGas: bigint = maxFeePerGas / 2n
    try { const gp = await publicClient.getGasPrice(); if (gp > maxFeePerGas) { maxFeePerGas = gp; maxPriorityFeePerGas = gp/2n || 1n } } catch {}
    const uoHash = await bundlerClient.sendUserOperation({
      account: sa,
      calls: [{ to: env.DelegationManager as Address, data }],
      maxFeePerGas,
      maxPriorityFeePerGas,
    })
    return res.json({ ok: true, userOperationHash: uoHash, unwrapped: wad.toString(), percent: chosenPercent })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'unwrap failed' })
  }
})

// Withdraw native MON from delegator SA to its ownerEOA by unwrapping WMON balance
app.post('/api/withdraw-native', async (req, res) => {
  try {
    let { delegatorSA, amount } = req.body || {}
    if (typeof delegatorSA === 'string') delegatorSA = delegatorSA.toLowerCase()
    if (!delegatorSA) return res.status(400).json({ error: 'Missing delegatorSA' })
    const file = join(process.cwd(), 'data', 'delegations', `${delegatorSA}.json`)
    if (!existsSync(file)) return res.status(404).json({ error: 'delegation_missing' })
    const raw = readFileSync(file, 'utf8')
    const json = JSON.parse(raw)
    const ownerEOA = json?.job?.ownerEOA as string | undefined
    if (!ownerEOA) return res.status(400).json({ error: 'ownerEOA_missing' })
    const pk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}`
    if (!pk) return res.status(500).json({ error: 'Missing DELEGATE_PRIVATE_KEY' })
    const eoa = privateKeyToAccount(pk)
    const env = getDeleGatorEnvironment(monadTestnet.id)
    const delegateSA = await toMetaMaskSmartAccount({
      client: publicClient,
      implementation: Implementation.Hybrid,
      deployParams: [eoa.address, [], [], []],
      deploySalt: '0x',
      signer: { account: eoa },
      environment: env as any,
    })
    // Read WMON balance of delegator SA
    let wbal = 0n
    try {
      wbal = await publicClient.readContract({
        address: WMON as any,
        abi: [ { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [ { name: 'owner', type: 'address' } ], outputs: [ { name: '', type: 'uint256' } ] } ] as any,
        functionName: 'balanceOf',
        args: [delegatorSA],
      }) as bigint
    } catch {}
    if (wbal === 0n) return res.json({ ok: false, error: 'no_wmon_balance' })
    let wad: bigint
    if (amount != null) {
      try { wad = BigInt(String(amount)) } catch { wad = wbal }
      if (wad <= 0n || wad > wbal) wad = wbal
    } else {
      wad = wbal
    }
    // Build executions: withdraw(wad) on WMON then transfer native MON to ownerEOA (delegator SA already receives native, so we just need a native call?)
    // For native transfer from SA, we can use a zero calldata execution with value if the smart account supports direct value send via execution bundling.
    // Simpler: withdraw to SA (WMON withdraw sends MON to msg.sender), then flushToken path exists but here we compose direct withdraw only.
    const { encodeFunctionData } = await import('viem')
    const withdrawData = encodeFunctionData({
      abi: [ { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [ { name: 'wad', type: 'uint256' } ], outputs: [] } ] as any,
      functionName: 'withdraw',
      args: [wad],
    }) as `0x${string}`
    // After withdraw, we add a transfer of native MON (value) to ownerEOA with empty calldata
    const executions: { target: `0x${string}`; value: bigint; callData: `0x${string}` }[] = [
      { target: WMON as `0x${string}`, value: 0n, callData: withdrawData },
      { target: ownerEOA as `0x${string}`, value: wad, callData: '0x' as `0x${string}` },
    ]
    // Encode delegation redeem like in runner (reuse existing signedDelegation)
    const signed = json.signedDelegation
    const flat = {
      delegate: signed.delegation.delegate,
      delegator: signed.delegation.delegator,
      authority: signed.delegation.authority,
      caveats: (signed.delegation.caveats || []).map((c: any) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args })),
      salt: signed.delegation.salt,
      signature: signed.signature,
    }
    const { encodePermissionContextsFromDelegations, encodeExecutionCalldatasWithModes } = await import('./encoding')
    const ctxArr = encodePermissionContextsFromDelegations([[flat as any]])
    if (!Array.isArray(ctxArr) || ctxArr.length === 0) return res.status(500).json({ error: 'permission_ctx_failed' })
    const [ctx] = ctxArr
    const execGroups = executions.map((e) => [e])
    const { calldatas, modes } = encodeExecutionCalldatasWithModes(execGroups)
    const permissionContexts = execGroups.map(() => ctx)
    const { encodeFunctionData: encFD } = await import('viem')
    const DM_REDEEM_ABI = [ { type: 'function', name: 'redeemDelegations', stateMutability: 'nonpayable', inputs: [ { name: '_permissionContexts', type: 'bytes[]' }, { name: '_modes', type: 'bytes32[]' }, { name: '_executionCallDatas', type: 'bytes[]' } ], outputs: [] } ] as const
    const dmCalldata = encFD({ abi: DM_REDEEM_ABI as any, functionName: 'redeemDelegations', args: [permissionContexts as any, modes as any, calldatas as any] }) as `0x${string}`
    // Gas params basic
    let maxFeePerGas = await publicClient.getGasPrice().catch(() => 80n * 10n ** 9n)
    if (maxFeePerGas < 80n * 10n ** 9n) maxFeePerGas = 80n * 10n ** 9n
    const maxPriorityFeePerGas = maxFeePerGas / 2n
    const uoHash = await bundlerClient.sendUserOperation({
      account: delegateSA,
      calls: [{ to: env.DelegationManager as any, data: dmCalldata }],
      maxFeePerGas,
      maxPriorityFeePerGas,
    })
    return res.json({ ok: true, userOperationHash: uoHash, wad: String(wad) })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'withdraw_native_failed' })
  }
})

// Flush tokens from SA to EOA (ERC20 via transferFrom(from=SA, to=EOA) or native MON via value call)
app.post('/api/flush', async (req, res) => {
  try {
  let { delegatorSA, token, to, amount } = req.body || {}
  if (typeof delegatorSA === 'string') delegatorSA = delegatorSA.toLowerCase()
  if (!delegatorSA || !token || !to) return res.status(400).json({ error: 'Missing fields' })
    const file = join(process.cwd(), 'data', 'delegations', `${delegatorSA}.json`)
    if (!existsSync(file)) return res.status(404).json({ error: 'No delegation found' })
    const raw = readFileSync(file, 'utf8')
    const json = JSON.parse(raw)
    const signed = json.signedDelegation
    const pk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}`
    if (!pk) return res.status(500).json({ error: 'Missing DELEGATE_PRIVATE_KEY' })
    const eoa = privateKeyToAccount(pk)
    let env: any
    try { env = getDeleGatorEnvironment(monadTestnet.id) } catch {}
    const sa = await toMetaMaskSmartAccount({
      client: publicClient,
      implementation: Implementation.Hybrid,
      deployParams: [eoa.address, [], [], []],
      deploySalt: '0x',
      signer: { account: eoa },
      ...(env ? { environment: env } : {}),
    })
    let exec: { target: Address; value: bigint; callData: `0x${string}` }[] = []
    if (token === 'MON') {
      return res.status(400).json({ ok: false, error: 'MON native flush désactivé; utiliser WMON (unwrap puis flush WMON)' })
    } else {
      const tokenAddr = token === 'USDC' ? USDC : token === 'WMON' ? WMON : null
      if (!tokenAddr) return res.status(400).json({ error: 'Unsupported token' })
      let amt: bigint
      if (amount === 'all') {
        try {
          amt = await publicClient.readContract({
            address: tokenAddr as Address,
            abi: [ { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] } ] as any,
            functionName: 'balanceOf',
            args: [delegatorSA as Address],
          }) as bigint
        } catch { amt = 0n }
      } else {
        amt = BigInt(String(amount || 0))
      }
      // Use transferFrom(from=SA,to=EOA) since original delegation already allowed selector 23b872dd
      const callData = encodeFunctionData({
        abi: [ { name: 'transferFrom', type: 'function', stateMutability: 'nonpayable', inputs: [ { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' } ], outputs: [ { name: '', type: 'bool' } ] } ] as any,
        functionName: 'transferFrom',
        args: [delegatorSA as Address, to as Address, amt],
      })
      exec = [{ target: tokenAddr as Address, value: 0n, callData }]
    }
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
    try { const gp = await publicClient.getGasPrice(); if (gp > maxFeePerGas) { maxFeePerGas = gp; maxPriorityFeePerGas = gp/2n || 1n } } catch {}
    const uoHash = await bundlerClient.sendUserOperation({
      account: sa,
      calls: [{ to: env.DelegationManager as Address, data }],
      maxFeePerGas,
      maxPriorityFeePerGas,
    })
  return res.json({ ok: true, userOperationHash: uoHash })
  } catch (e: any) {
  console.error('[flush] error', e?.message)
  return res.status(500).json({ ok: false, error: e?.message || 'flush failed' })
  }
})

// Top-up USDC: prepend permit or transferWithAuthorization then transferFrom/implicit transfer
app.post('/api/topup', async (req, res) => {
  try {
  let { delegatorSA, amountUSDC, permit, auth3009 } = req.body || {}
  if (typeof delegatorSA === 'string') delegatorSA = delegatorSA.toLowerCase()
    if (!delegatorSA || !amountUSDC) return res.status(400).json({ error: 'Missing fields' })
    const file = join(process.cwd(), 'data', 'delegations', `${delegatorSA}.json`)
    if (!existsSync(file)) {
      console.warn('[topup] delegation missing for', delegatorSA)
      return res.status(404).json({ error: 'No delegation found', code: 'delegation_missing', delegatorSA })
    }
    const raw = readFileSync(file, 'utf8')
    const json = JSON.parse(raw)
  // fallback: si pas fourni dans body, utiliser ceux persistés dans job
  if (!permit && json?.job?.permit) permit = json.job.permit
  if (!auth3009 && json?.job?.auth3009) auth3009 = json.job.auth3009
    const signed = json.signedDelegation
    const pk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}`
    if (!pk) return res.status(500).json({ error: 'Missing DELEGATE_PRIVATE_KEY' })
    const eoa = privateKeyToAccount(pk)
    let env: any
    try { env = getDeleGatorEnvironment(monadTestnet.id) } catch {}
    const sa = await toMetaMaskSmartAccount({
      client: publicClient,
      implementation: Implementation.Hybrid,
      deployParams: [eoa.address, [], [], []],
      deploySalt: '0x',
      signer: { account: eoa },
      ...(env ? { environment: env } : {}),
    })
    const toPull = BigInt(amountUSDC) // already in 6 decimals
    const { encodeFunctionData } = await import('viem')
    const seq: { target: Address; value: bigint; callData: `0x${string}` }[] = []

    // --- Préflight diagnostics ---
    const ownerAddr: Address | undefined = permit?.owner || auth3009?.from
    if (!ownerAddr) {
      return res.status(400).json({ ok: false, error: 'Missing permit/auth owner', code: 'missing_owner' })
    }
    // Lire solde USDC owner
    let ownerBal: bigint = 0n
    try {
      ownerBal = await publicClient.readContract({
        address: USDC,
        abi: [ { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] } ] as any,
        functionName: 'balanceOf',
        args: [ownerAddr],
      }) as bigint
    } catch {}
    if (ownerBal < toPull) {
      console.warn('[topup] insufficient USDC balance owner', { owner: ownerAddr, ownerBal: ownerBal.toString(), requested: toPull.toString() })
      return res.status(400).json({ ok: false, error: 'Owner USDC balance insufficient', code: 'insufficient_owner_usdc', ownerBal: ownerBal.toString(), requested: toPull.toString() })
    }
    if (permit) {
      try {
        if (BigInt(permit.value) < toPull) {
          return res.status(400).json({ ok: false, error: 'Permit value lower than requested transfer', code: 'permit_value_too_low', permitValue: permit.value, requested: toPull.toString() })
        }
      } catch {}
    }
    // --- Fin préflight ---
  if (permit) {
      const permitCalldata = encodeFunctionData({
        abi: [ { name: 'permit', type: 'function', stateMutability: 'nonpayable', inputs: [ { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' } ], outputs: [] } ] as any,
        functionName: 'permit',
        args: [permit.owner, delegatorSA as Address, BigInt(permit.value), BigInt(permit.deadline), permit.v, permit.r, permit.s],
      }) as `0x${string}`
      seq.push({ target: USDC as Address, value: 0n, callData: permitCalldata })
  } else if (auth3009) {
      const twa = encodeFunctionData({
        abi: [ { name: 'transferWithAuthorization', type: 'function', stateMutability: 'nonpayable', inputs: [ { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' } ], outputs: [] } ] as any,
        functionName: 'transferWithAuthorization',
        args: [auth3009.from, delegatorSA as Address, BigInt(auth3009.value), BigInt(auth3009.validAfter), BigInt(auth3009.validBefore), auth3009.nonce, auth3009.v, auth3009.r, auth3009.s],
      }) as `0x${string}`
      seq.push({ target: USDC as Address, value: 0n, callData: twa })
    }
    // Always finish with transferFrom(ownerEOA -> SA) if using permit; for EIP-3009 direct transfer, maybe skip
  if (permit) {
      const transferFrom = encodeFunctionData({
        abi: [ { name: 'transferFrom', type: 'function', stateMutability: 'nonpayable', inputs: [ { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' } ], outputs: [ { name: '', type: 'bool' } ] } ] as any,
        functionName: 'transferFrom',
        args: [permit.owner as Address, delegatorSA as Address, toPull],
      }) as `0x${string}`
      seq.push({ target: USDC as Address, value: 0n, callData: transferFrom })
    }

    // Pré-simulation de chaque appel pour ressortir un éventuel revert reason avant l'op UserOp
    const simulated: any[] = []
    for (const [i, step] of seq.entries()) {
      try {
        await publicClient.call({ to: step.target, data: step.callData })
        simulated.push({ i, ok: true, selector: step.callData.slice(0,10) })
      } catch (err: any) {
        let reason: string | undefined
        try {
          const decoded = decodeErrorResult({ data: err?.data || err?.cause?.data || '0x', abi: [] })
          reason = JSON.stringify(decoded)
        } catch {}
        return res.status(400).json({ ok: false, error: 'pre-sim revert', code: 'pre_sim_revert', step: i, selector: step.callData.slice(0,10), raw: String(err?.message||err), decoded: reason, simulated })
      }
    }
    const flat = {
      delegate: signed.delegation.delegate,
      delegator: signed.delegation.delegator,
      authority: signed.delegation.authority,
      caveats: (signed.delegation.caveats || []).map((c: any) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args })),
      salt: signed.delegation.salt,
      signature: signed.signature,
    }
  const [ctx] = encodePermissionContextsFromDelegations([[flat as any]])
    // One mode per execution (SingleDefault), each execution array length=1
    const execGroups = seq.map((x) => [x])
    const { calldatas, modes } = encodeExecutionCalldatasWithModes(execGroups)
    const permissionContexts = execGroups.map(() => ctx)
    const DM_REDEEM_ABI = [ { type: 'function', name: 'redeemDelegations', stateMutability: 'nonpayable', inputs: [ { name: '_permissionContexts', type: 'bytes[]' }, { name: '_modes', type: 'bytes32[]' }, { name: '_executionCallDatas', type: 'bytes[]' } ], outputs: [] } ] as const
    const data = encodeFunctionData({ abi: DM_REDEEM_ABI as any, functionName: 'redeemDelegations', args: [permissionContexts as any, modes as any, calldatas as any] }) as `0x${string}`
    // gas basics
    let maxFeePerGas: bigint = 80n * 10n ** 9n
    let maxPriorityFeePerGas: bigint = maxFeePerGas / 2n
    try { const gp = await publicClient.getGasPrice(); if (gp > maxFeePerGas) { maxFeePerGas = gp; maxPriorityFeePerGas = gp/2n || 1n } } catch {}
  console.log('[topup] exec sequence', seq.map((s,i)=>({i,target:s.target,hasData:s.callData!== '0x', selector: s.callData?.slice(0,10)})))
  console.log('[topup] diagnostics', { owner: ownerAddr, ownerBal: ownerBal.toString(), toPull: toPull.toString(), steps: seq.length })
  const uoHash = await bundlerClient.sendUserOperation({
      account: sa,
      calls: [{ to: env.DelegationManager as Address, data }],
      maxFeePerGas,
      maxPriorityFeePerGas,
    })
    return res.json({ ok: true, userOperationHash: uoHash })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'topup failed' })
  }
})

// Wrap MON -> WMON (deposit) depuis le SA (utilise délégation)
app.post('/api/wrap', async (req, res) => {
  try {
    let { delegatorSA, amount } = req.body || {}
    if (typeof delegatorSA === 'string') delegatorSA = delegatorSA.toLowerCase()
    if (!delegatorSA) return res.status(400).json({ error: 'Missing delegatorSA' })
    const file = join(process.cwd(), 'data', 'delegations', `${delegatorSA}.json`)
  if (!existsSync(file)) return res.status(404).json({ error: 'No delegation found', code: 'delegation_missing', delegatorSA })
    const raw = readFileSync(file, 'utf8')
    const json = JSON.parse(raw)
    const signed = json.signedDelegation
    const pk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}`
    if (!pk) return res.status(500).json({ error: 'Missing DELEGATE_PRIVATE_KEY' })
    const eoa = privateKeyToAccount(pk)
    let env: any
    try { env = getDeleGatorEnvironment(monadTestnet.id) } catch {}
    const sa = await toMetaMaskSmartAccount({
      client: publicClient,
      implementation: Implementation.Hybrid,
      deployParams: [eoa.address, [], [], []],
      deploySalt: '0x',
      signer: { account: eoa },
      ...(env ? { environment: env } : {}),
    })
    // Amount: si non fourni -> full balance MON du SA
    let value: bigint
    if (amount == null) {
      try { value = await publicClient.getBalance({ address: delegatorSA as Address }) } catch { value = 0n }
    } else {
      value = BigInt(String(amount))
    }
    if (value === 0n) return res.status(400).json({ error: 'No MON to wrap' })
    // deposit() payable sans calldata paramètres
    const exec = [{ target: WMON as Address, value, callData: '0xd0e30db0' as `0x${string}` }]
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
    const DM_REDEEM_ABI = [ { type: 'function', name: 'redeemDelegations', stateMutability: 'nonpayable', inputs: [ { name: '_permissionContexts', type: 'bytes[]' }, { name: '_modes', type: 'bytes32[]' }, { name: '_executionCallDatas', type: 'bytes[]' } ], outputs: [] } ] as const
    const data = encodeFunctionData({ abi: DM_REDEEM_ABI as any, functionName: 'redeemDelegations', args: [[ctx] as any, modes as any, calldatas as any] }) as `0x${string}`
    let maxFeePerGas: bigint = 80n * 10n ** 9n
    let maxPriorityFeePerGas: bigint = maxFeePerGas / 2n
    try { const gp = await publicClient.getGasPrice(); if (gp > maxFeePerGas) { maxFeePerGas = gp; maxPriorityFeePerGas = gp/2n || 1n } } catch {}
    const uoHash = await bundlerClient.sendUserOperation({
      account: sa,
      calls: [{ to: env.DelegationManager as Address, data }],
      maxFeePerGas,
      maxPriorityFeePerGas,
    })
    return res.json({ ok: true, userOperationHash: uoHash })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'wrap failed' })
  }
})

// Status consolidé pour UI
app.get('/api/status/:delegator', async (req, res) => {
  try {
    const delegator = (req.params.delegator || '').toLowerCase()
    if (!delegator.startsWith('0x') || delegator.length !== 42) return res.status(400).json({ error: 'delegator invalide' })
    const file = join(process.cwd(), 'data', 'delegations', `${delegator}.json`)
    const exists = existsSync(file)
    let job: any = null
    let permit: any = null
    let auth3009: any = null
    if (exists) {
      try {
        const raw = readFileSync(file, 'utf8')
        const json = JSON.parse(raw)
        job = json.job || null
        permit = json.job?.permit || null
        auth3009 = json.job?.auth3009 || null
      } catch {}
    }
    // Balances
    let usdc = 0n, mon = 0n, wmon = 0n
    try { mon = await publicClient.getBalance({ address: delegator as Address }) } catch {}
    try {
      usdc = await publicClient.readContract({
        address: USDC,
        abi: [ { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] } ] as any,
        functionName: 'balanceOf',
        args: [delegator as Address],
      }) as bigint
    } catch {}
    try {
      wmon = await publicClient.readContract({
        address: WMON,
        abi: [ { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] } ] as any,
        functionName: 'balanceOf',
        args: [delegator as Address],
      }) as bigint
    } catch {}
    const needsTopup = usdc === 0n
    return res.json({ ok: true, hasDelegation: exists, balances: { usdc: usdc.toString(), mon: mon.toString(), wmon: wmon.toString() }, needsTopup, hasPermitAuth: Boolean(permit || auth3009) })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'status failed' })
  }
})

// List delegations for debugging
app.get('/api/delegations', async (_req, res) => {
  try {
    const dir = join(process.cwd(), 'data', 'delegations')
    if (!existsSync(dir)) return res.json({ ok: true, delegations: [] })
    const fs = require('node:fs') as typeof import('node:fs')
    const files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.json'))
    return res.json({ ok: true, delegations: files })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'list failed' })
  }
})

// Fallback 404 handler (always JSON)
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.path })
})

// Error handler (always JSON)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err)
  res.status(500).json({ error: err?.message || 'Internal Server Error' })
})

export function startServer(port = Number(process.env.PORT || 8787)) {
  // Default to 0.0.0.0 to avoid IPv4/IPv6 localhost pitfalls
  const host = process.env.HOST || '0.0.0.0'
  return app.listen(port, host as any, () => {
    console.log(`[boot] API listening on ${host}:${port}`)
    console.log(`[boot] RPC_URL=${process.env.RPC_URL}`)
    console.log(`[boot] BUNDLER=${process.env.ZERO_DEV_BUNDLER_RPC ? 'set' : 'missing'}`)
    console.log(`[boot] PAYMASTER=${process.env.ZERO_DEV_PAYMASTER_RPC ? 'set' : 'missing'}`)
  console.log('[boot] endpoints ready: /api/topup /api/wrap /api/unwrap /api/delegations /api/diag /api/status /api/version /api/routes')
  })
}
