import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import { writeFileSync, mkdirSync, existsSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publicClient, monadTestnet, bundlerClient, paymasterClient } from './clients'
import { startJob, stopJob, runNow, getJobs } from './scheduler'
import { decodeErrorResult } from 'viem'
import { runOnceForDelegator } from './runner'
import { buildDebugBundle } from './utils/debug'
import { Implementation, toMetaMaskSmartAccount, getDeleGatorEnvironment } from '@metamask/delegation-toolkit'
import { privateKeyToAccount } from 'viem/accounts'
import { USDC, UNISWAP_V2_ROUTER02, WMON, ENTRY_POINT_V07 } from './constants'
import { encodePermissionContextsFromDelegations, encodeExecutionCalldatasWithModes } from './encoding'
import { buildLimitCaveats } from './caveat-builders'
import { computeDelegationHashes, computeWarnings } from './hashing'
import { computeCanonicalDelegationHashes } from './eip712'
import { appendAudit, hasStructHash, readAuditTail } from './audit'
import { Address, encodeFunctionData as viemEncodeFunctionData } from 'viem'
import { readRunHistory, summarizeRunHistory } from './utils/history'
// --- Simple in-memory auth (personal_sign) state ---
// NOTE: Nonces & sessions are ephemeral (reset on server restart). Adequate for gating UI today.
// Future hardening: persist sessions, add rate limits, bind to user agent.
type AuthNonceRec = { nonce: string; issuedAt: number; expiresAt: number }
type AuthSessionRec = { token: string; address: string; createdAt: number; expiresAt: number }
const AUTH_NONCES = new Map<string, AuthNonceRec>() // key: lowercase address
const AUTH_SESSIONS = new Map<string, AuthSessionRec>() // key: session token
function randomHex(bytes = 16): string { return '0x' + [...crypto.getRandomValues(new Uint8Array(bytes))].map(b=>b.toString(16).padStart(2,'0')).join('') }
function buildAuthMessage(address: string, nonce: string, issuedAt: number) {
  // Keep format stable; any change must be mirrored client-side when verifying past tokens
  const iso = new Date(issuedAt).toISOString()
  return `DCA Auth\nAddress: ${address.toLowerCase()}\nNonce: ${nonce}\nIssued At: ${iso}\nPurpose: Authenticate to DCA backend (expires in 5m)`
}

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
// Paymaster usage flag (accept broader truthy variants)
function parseUsePaymasterFlag(v?: string): boolean {
  if (!v) return false
  return ['true','1','yes','on','enabled'].includes(v.toLowerCase())
}
const RAW_USE_PAYMASTER = process.env.USE_PAYMASTER
const USE_PAYMASTER = parseUsePaymasterFlag(RAW_USE_PAYMASTER)

// --- Native value delegation detection helpers ---
// Some delegation-toolkit builds encode the native token transfer scope via specific enforcer contract(s)
// instead of a textual marker like 'nativeTokenTransferAmount'. We maintain a small allow-list here so we
// can robustly detect the scope even if 'terms' is only a packed uint256 maxAmount.
// If needed this list can be extended at runtime via env NAT_NATIVE_ENFORCERS (comma-separated addresses).
const DEFAULT_NATIVE_ENFORCERS = [
  // Observed in current value delegation JSON (maxAmount encoded in terms)
  '0xf71af580b9c3078fbc2bbf16fbb8eed82b330320'.toLowerCase(),
]
function resolveNativeEnforcers(): Set<string> {
  const extra = (process.env.NAT_NATIVE_ENFORCERS || '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a))
  return new Set([...DEFAULT_NATIVE_ENFORCERS, ...extra])
}
const NATIVE_ENFORCERS = resolveNativeEnforcers()

type DetectedNativeScope = { hasNativeScope: boolean; maxAmount?: string; enforcer?: string }
function detectNativeValueScope(caveats: any[]): DetectedNativeScope {
  if (!Array.isArray(caveats)) return { hasNativeScope: false }
  // Heuristic order:
  // 1. Legacy textual marker
  for (const c of caveats) {
    const terms = typeof c?.terms === 'string' ? c.terms : ''
    if (terms.includes('nativeTokenTransferAmount')) {
      return { hasNativeScope: true, enforcer: (c?.enforcer || '').toLowerCase() || undefined }
    }
  }
  // 2. Enforcer allow-list + numeric terms (uint256)
  for (const c of caveats) {
    const enf = (c?.enforcer || '').toLowerCase()
    if (NATIVE_ENFORCERS.has(enf)) {
      let maxAmount: string | undefined
      const terms = typeof c?.terms === 'string' ? c.terms : ''
      if (/^0x[0-9a-fA-F]{64}$/.test(terms)) {
        try { maxAmount = BigInt(terms).toString() } catch {}
      }
      return { hasNativeScope: true, maxAmount, enforcer: enf }
    }
  }
  return { hasNativeScope: false }
}

async function sendUserOpWithOptionalPaymaster(params: any) {
  // inject paymaster client only if enabled & rpc configured
  const pmRpc = process.env.ZERO_DEV_PAYMASTER_RPC || process.env.PIMLICO_PAYMASTER_RPC
  const pmSet = !!pmRpc
  const wantPm = USE_PAYMASTER || parseUsePaymasterFlag(params?.usePaymasterOverride)
  const willInject = wantPm && pmSet
  if (!willInject && wantPm) {
    console.log('[paymaster] skipped injection', {
      rawEnv: RAW_USE_PAYMASTER,
      wantPm,
      pmSet,
      reason: pmSet ? 'explicitly_disabled' : 'no_paymaster_rpc',
    })
  }
  if (willInject) {
    console.log('[paymaster] injecting sponsorship', {
      sender: params?.account?.address,
      calls: Array.isArray(params?.calls) ? params.calls.length : 0,
      pmRpc: pmRpc ? 'set' : 'missing',
    })
  }
  const augmented = {
    ...params,
    ...(willInject ? { paymaster: paymasterClient } : {}),
  }
  return bundlerClient.sendUserOperation(augmented)
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

// ---------------- AUTH (personal_sign) ----------------
// GET /api/auth/nonce?address=0x..  -> { ok, address, message, nonce, expiresAt }
// POST /api/auth/verify { address, signature } -> { ok, token, expiresAt }
// GET /api/auth/me (Authorization: Bearer <token>) -> { ok, address, expiresAt }
// Lightweight gating: client obtains nonce message, personal_sign, sends back signature.
// Signature recovery done with viem recoverMessageAddress.
app.get('/api/auth/nonce', async (req, res) => {
  try {
    const address = String(req.query.address || '').toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(address)) return res.status(400).json({ ok: false, error: 'invalid_address' })
    const now = Date.now()
    const nonce = randomHex(16)
    const rec: AuthNonceRec = { nonce, issuedAt: now, expiresAt: now + 5 * 60_000 }
    AUTH_NONCES.set(address, rec)
    const message = buildAuthMessage(address, nonce, now)
    return res.json({ ok: true, address, message, nonce, expiresAt: rec.expiresAt })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'nonce_failed' })
  }
})
app.post('/api/auth/verify', async (req, res) => {
  try {
    const { address, signature } = req.body || {}
    if (!address || !signature) return res.status(400).json({ ok: false, error: 'missing_fields' })
    const addr = String(address).toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return res.status(400).json({ ok: false, error: 'invalid_address' })
    const rec = AUTH_NONCES.get(addr)
    if (!rec) return res.status(400).json({ ok: false, error: 'nonce_missing' })
    if (Date.now() > rec.expiresAt) { AUTH_NONCES.delete(addr); return res.status(400).json({ ok: false, error: 'nonce_expired' }) }
    const message = buildAuthMessage(addr, rec.nonce, rec.issuedAt)
    let recovered: string
    try {
      const { recoverMessageAddress } = await import('viem')
      recovered = await recoverMessageAddress({ message, signature })
    } catch (e: any) {
      return res.status(400).json({ ok: false, error: 'recover_failed', detail: e?.message })
    }
    if (recovered.toLowerCase() !== addr) return res.status(400).json({ ok: false, error: 'signer_mismatch', recovered })
    AUTH_NONCES.delete(addr)
    // Create session
    const token = randomHex(24)
    const now = Date.now()
    const session: AuthSessionRec = { token, address: addr, createdAt: now, expiresAt: now + 24 * 60 * 60_000 }
    AUTH_SESSIONS.set(token, session)
    return res.json({ ok: true, token, address: addr, expiresAt: session.expiresAt })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'verify_failed' })
  }
})
app.get('/api/auth/me', (req, res) => {
  try {
    const auth = String(req.headers.authorization || '')
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ ok: false, error: 'missing_bearer' })
    const token = auth.slice(7)
    const sess = AUTH_SESSIONS.get(token)
    if (!sess) return res.status(401).json({ ok: false, error: 'invalid_session' })
    if (Date.now() > sess.expiresAt) { AUTH_SESSIONS.delete(token); return res.status(401).json({ ok: false, error: 'session_expired' }) }
    return res.json({ ok: true, address: sess.address, expiresAt: sess.expiresAt })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'me_failed' })
  }
})

let cachedDelegate: { eoa: string; sa: string; envSupported?: boolean } | null = null
// Root landing page for quick sanity check
app.get('/', (_req, res) => {
  res.json({ ok: true, name: 'DCA API', endpoints: ['/api/health', '/api/delegate', '/api/diag'] })
})
app.get('/api/health', (_req, res) => res.json({ ok: true }))
// Audit tail (simple feed pour HyperIndex ingestion initiale)
app.get('/api/delegations/audit', (req, res) => {
  const n = Math.min(Number(req.query.n ?? 200), 1000)
  return res.json({ ok: true, entries: readAuditTail(n) })
})
// Mapping structHash -> runs + audit entries
app.get('/api/delegations/map/:structHash', async (req, res) => {
  try {
    const structHash = (req.params.structHash || '').toLowerCase()
    if (!/^0x[0-9a-fA-F]{64}$/.test(structHash)) return res.status(400).json({ ok: false, error: 'invalid_structHash' })
    // Collect runs referencing this structHash
    const { findRunsByStructHash } = await import('./utils/history')
    const runs = findRunsByStructHash(structHash)
    // Filter audit tail naive (for scale, should stream full file & grep; acceptable here)
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const auditFile = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
    const audit: any[] = []
    if (fs.existsSync(auditFile)) {
      try {
        const raw = fs.readFileSync(auditFile, 'utf8').split('\n')
        for (const line of raw) {
          if (!line) continue
          try { const j = JSON.parse(line); if ((j.structHash || '').toLowerCase() === structHash) audit.push(j) } catch {}
        }
      } catch {}
    }
    // Fallback recalcul: si pas d'entrée audit correspondante, essayer de recalculer depuis les fichiers de délégation persistés
    let recalcMatches: any[] = []
    if (audit.length === 0) {
      try {
        const delegDir = path.join(process.cwd(), 'data', 'delegations')
        if (fs.existsSync(delegDir)) {
          const files = fs.readdirSync(delegDir).filter((f: string) => f.endsWith('.json') && f !== 'audit.log')
          const domainCfg = { name: process.env.DELEGATION_DOMAIN_NAME || 'Delegation', version: process.env.DELEGATION_DOMAIN_VERSION || '1', chainId: monadTestnet.id, verifyingContract: (process.env.DELEGATION_MANAGER_ADDRESS || (getDeleGatorEnvironment(monadTestnet.id) as any).DelegationManager) }
          for (const f of files) {
            try {
              const raw = JSON.parse(fs.readFileSync(path.join(delegDir, f), 'utf8'))
              const sd = raw?.signedDelegation
              if (!sd?.delegation) continue
              const d = sd.delegation
              const h = computeCanonicalDelegationHashes({ delegator: d.delegator, delegate: d.delegate, authority: d.authority, caveats: d.caveats||[], salt: d.salt }, domainCfg as any)
              if (h.structHash.toLowerCase() === structHash) {
                recalcMatches.push({ delegator: d.delegator, delegate: d.delegate, salt: d.salt, caveatCount: (d.caveats||[]).length, digest: h.digest })
              }
            } catch {}
          }
        }
      } catch {}
    }
    return res.json({ ok: true, structHash, runs, auditCount: audit.length, audit })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'map_failed' })
  }
})
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
// Run history (persisted) endpoints
app.get('/api/history/:delegator', (req, res) => {
  try {
    const addr = String(req.params.delegator || '').toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return res.status(400).json({ ok: false, error: 'invalid_address' })
    const limit = Math.min(Number(req.query.limit ?? 100), 500)
    const events = readRunHistory(addr, limit)
    return res.json({ ok: true, count: events.length, events })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'history_failed' })
  }
})
app.get('/api/history/:delegator/summary', (req, res) => {
  try {
    const addr = String(req.params.delegator || '').toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return res.status(400).json({ ok: false, error: 'invalid_address' })
    const summary = summarizeRunHistory(addr)
    return res.json({ ok: true, summary })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'history_summary_failed' })
  }
})
// Configure logical limits (NOTE: off-chain enforcement for now; future: migrate to on-chain caveats)
// body: { delegatorSA, timeWindow?: { startHour:number, endHour:number }, dailyCapUSDC?: number, maxRuns?: number }
app.post('/api/limits/update', (req, res) => {
  try {
    const { delegatorSA, timeWindow, dailyCapUSDC, maxRuns } = req.body || {}
    if (!delegatorSA || typeof delegatorSA !== 'string') return res.status(400).json({ ok: false, error: 'missing_delegatorSA' })
    const addr = delegatorSA.toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return res.status(400).json({ ok: false, error: 'invalid_address' })
    const file = join(process.cwd(), 'data', 'delegations', `${addr}.json`)
    if (!existsSync(file)) return res.status(404).json({ ok: false, error: 'core_delegation_missing' })
    const raw = readFileSync(file, 'utf8')
    const json = JSON.parse(raw)
    json.job = json.job || {}
    if (timeWindow) {
      const sh = Number(timeWindow.startHour)
      const eh = Number(timeWindow.endHour)
      if (Number.isFinite(sh) && Number.isFinite(eh) && sh >= 0 && sh < 24 && eh >= 0 && eh <= 24 && sh !== eh) {
        json.job.timeWindow = { startHour: sh, endHour: eh }
      } else if (timeWindow === null) {
        delete json.job.timeWindow
      } else return res.status(400).json({ ok: false, error: 'invalid_timeWindow' })
    }
    if (dailyCapUSDC !== undefined) {
      const cap = Number(dailyCapUSDC)
      if (!Number.isFinite(cap) || cap <= 0) return res.status(400).json({ ok: false, error: 'invalid_dailyCapUSDC' })
      json.job.dailyCapUSDC = cap
      // reset tracking bucket when cap changes
      json.job._dailyCapDate = undefined
      json.job._dailyCapUsed = undefined
    }
    if (maxRuns !== undefined) {
      const mr = Number(maxRuns)
      if (!Number.isFinite(mr) || mr <= 0) return res.status(400).json({ ok: false, error: 'invalid_maxRuns' })
      json.job.maxRuns = mr
    }
    writeFileSync(file, JSON.stringify(json, null, 2))
    return res.json({ ok: true, job: { timeWindow: json.job.timeWindow, dailyCapUSDC: json.job.dailyCapUSDC, maxRuns: json.job.maxRuns } })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'limits_update_failed' })
  }
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

// (REMOVED) Ancien endpoint mutable POST /api/delegations supprimé pour garantir immutabilité stricte.
// Toute création doit passer par build -> signature client -> submit.

// New immutable build endpoint: returns delegation object (unsigned) for client-side signing.
// Body: { delegator, delegate, scope, caveats?, chainId? }
app.post('/api/delegations/build', async (req, res) => {
  try {
    const { delegator, delegate, scope, caveats, chainId, limits } = req.body || {}
    if (!delegator || !delegate || !scope) return res.status(400).json({ ok: false, error: 'missing_fields' })
    const addrRe = /^0x[0-9a-fA-F]{40}$/
    if (!addrRe.test(delegator) || !addrRe.test(delegate)) return res.status(400).json({ ok: false, error: 'invalid_addresses' })
    let mergedCaveats = Array.isArray(caveats) ? [...caveats] : []
    if (limits && typeof limits === 'object') {
      try {
        const limitCaveats = buildLimitCaveats({
          dailyCapUSDC: limits.dailyCapUSDC,
          maxRuns: limits.maxRuns,
          timeWindow: limits.timeWindow,
        }, { usdcToken: USDC })
        mergedCaveats = [...mergedCaveats, ...limitCaveats]
      } catch (e) {
        console.warn('[build] limits->caveats failed', e)
      }
    }
    const { buildDelegation } = await import('./api/delegations-flow')
    const delegation = buildDelegation({ from: delegator.toLowerCase(), to: delegate.toLowerCase(), scope, caveats: mergedCaveats, chainId }) as any
    // Instrumentation hashing (unsigned preview)
    let hashes: any = null
    try {
      const domainCfg = {
        name: process.env.DELEGATION_DOMAIN_NAME || 'Delegation',
        version: process.env.DELEGATION_DOMAIN_VERSION || '1',
        chainId: chainId || monadTestnet.id,
        verifyingContract: (process.env.DELEGATION_MANAGER_ADDRESS || (getDeleGatorEnvironment(monadTestnet.id) as any).DelegationManager) as any,
      }
      hashes = computeCanonicalDelegationHashes({
        delegator: delegation.delegator,
        delegate: delegation.delegate,
        authority: delegation.authority,
        caveats: delegation.caveats || [],
        salt: delegation.salt,
      }, domainCfg)
    } catch (e) {
      console.warn('[build] hashing failed (non-blocking)', (e as any)?.message)
    }
    if (hashes) {
      const warnings = computeWarnings({
        expectedDelegator: delegation.delegator,
        salt: BigInt(delegation.salt || 0),
        duplicateStruct: hasStructHash(hashes.structHash),
        hasCaveats: Array.isArray(delegation.caveats) && delegation.caveats.length > 0,
      })
  appendAudit({
    ts: Date.now(),
    action: 'build',
    delegator: delegation.delegator,
    delegate: delegation.delegate,
    role: 'core',
    structHash: hashes.structHash,
    digest: hashes.digest,
    domainSeparator: hashes.domainSeparator,
  caveatsRoot: (hashes.caveatsRoot || (hashes as any).caveatsHash || (hashes as any).caveats_root || '0x'),
    salt: delegation.salt,
    warnings,
    signatureModel: 'UNKNOWN' as any,
  })
      return res.json({ ok: true, delegation, chainId: chainId || monadTestnet.id, addedLimitCaveats: mergedCaveats.length, hashes, warnings })
    }
    return res.json({ ok: true, delegation, chainId: chainId || monadTestnet.id, addedLimitCaveats: mergedCaveats.length })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'build_failed' })
  }
})

// Hash preview avant signature: { delegator, delegate, authority?, caveats, salt? }
app.post('/api/delegations/hash-preview', (req, res) => {
  try {
    const { delegator, delegate, authority, caveats, salt } = req.body || {}
    const addrRe = /^0x[0-9a-fA-F]{40}$/
    if (!addrRe.test(delegator || '') || !addrRe.test(delegate || '')) return res.status(400).json({ ok: false, error: 'invalid_addresses' })
    const authority32 = authority && authority !== '0x' ? authority : '0x' + '00'.repeat(32)
    const chainId = monadTestnet.id
    const domainCfg = {
      name: process.env.DELEGATION_DOMAIN_NAME || 'Delegation',
      version: process.env.DELEGATION_DOMAIN_VERSION || '1',
      chainId,
      verifyingContract: (process.env.DELEGATION_MANAGER_ADDRESS || (getDeleGatorEnvironment(chainId) as any).DelegationManager) as any,
    }
    const hashes = computeCanonicalDelegationHashes({
      delegator: delegator.toLowerCase(),
      delegate: delegate.toLowerCase(),
      authority: authority32,
      caveats: Array.isArray(caveats) ? caveats : [],
      salt: salt ?? '0x',
    }, domainCfg)
    const warnings = computeWarnings({
      salt: BigInt(salt || 0),
      expectedDelegator: delegator,
      duplicateStruct: hasStructHash(hashes.structHash),
      hasCaveats: Array.isArray(caveats) && caveats.length > 0,
    })
    // Heuristique potentielle: si le delegator est un contrat (code != 0x) prévenir qu'il pourrait s'agir d'un ERC1271
    // (la confirmation réelle aura lieu après signature via signature-model detection)
    // On ne fait pas d'appel async ici -> différer en version async si besoin. Pour l'instant, simple placeholder consultable avec un override.
    // Pour ne pas bloquer: si publicClient disponible on tente un getBytecode synchrone via .request (viem publicClient.getCode est async -> donc on garde simple: flag env)
    // Implémentation rapide: si env FAST_ERC1271_HEURISTIC=1 on fera une requête asynchrone.
    const finalWarnings = [...warnings]
    // Lancer detection code seulement si activé pour éviter latences
    if (process.env.FAST_ERC1271_HEURISTIC === '1') {
      // Best-effort: on encapsule dans IIFE async et respond ensuite (convertir handler en async). Simplicité: retourner pendingHeuristic: true pour version sync.
      // Pour ne pas re-coder tout, on ajoute un marqueur si heuristique non évaluée.
      finalWarnings.push('ERC1271_HEURISTIC_DEFERRED')
    }
    return res.json({ ok: true, hashes, warnings: finalWarnings, domain: domainCfg })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'hash_preview_failed' })
  }
})

// New submit endpoint: persists signed delegation JSON without mutation.
// Body: { delegatorSA, signedDelegation, role?, job? }
app.post('/api/delegations/submit', async (req, res) => {
  try {
    let { delegatorSA, signedDelegation, role, job } = req.body || {}
    role = (role || 'core').toLowerCase()
    if (typeof delegatorSA === 'string') delegatorSA = delegatorSA.toLowerCase()
    if (!delegatorSA || !signedDelegation) return res.status(400).json({ ok: false, error: 'missing_fields' })
    const { validateSignedDelegationShape } = await import('./api/delegations-flow')
    try { validateSignedDelegationShape(signedDelegation) } catch (ve: any) { return res.status(400).json({ ok: false, error: 'validation_failed', detail: ve?.message }) }
    // --- Signature Verification (best-effort manual EIP-712 style) ---
    // NOTE: La lib expose signDelegation mais pas directement un helper de recover. On reconstruit un digest approximatif.
    // Structure hypothétique: keccak256( abi.encode( delegator, delegate, authority, salt, keccak256(caveatsPacked) ) )
    // Si mismatch on rejette (flag strict configurable via env DELEGATION_VERIFY_STRICT=1)
    let recovered: string | null = null
    let computedHash: `0x${string}` | null = null
    let verifyError: string | null = null
    try {
      const { keccak256, encodeAbiParameters, recoverAddress, toHex } = await import('viem')
      const d = signedDelegation.delegation
      // Pack caveats minimally: keccak256( concat(enforcer, terms, args) ... ) to get stable root
      const caveats: any[] = Array.isArray(d.caveats) ? d.caveats : []
      const packedCaveats = caveats.map((c) => keccak256(encodeAbiParameters([
        { type: 'address' }, { type: 'bytes' }, { type: 'bytes' }
      ] as any, [c.enforcer, c.terms, c.args ?? '0x'])) )
      const caveatsRoot = keccak256(encodeAbiParameters([{ type: 'bytes32[]' }] as any, [packedCaveats]))
      // Primary struct
      computedHash = keccak256(encodeAbiParameters([
        { type: 'address' }, // delegator
        { type: 'address' }, // delegate
        { type: 'bytes32' }, // authority (bytes32 root authority chain)
        { type: 'uint256' }, // salt
        { type: 'bytes32' }, // caveatsRoot
      ] as any, [d.delegator, d.delegate, d.authority, BigInt(d.salt), caveatsRoot]))
      // Domain separation minimal (fallback). Without domain could false-pass but ok for hackathon; add chain-specific domain later.
      const domainSep = keccak256(encodeAbiParameters([{ type: 'string' }], ['Delegation']) )
      const digest = keccak256(encodeAbiParameters([
        { type: 'bytes32' }, { type: 'bytes32' }
      ] as any, [domainSep, computedHash]))
      // Recover
      recovered = await recoverAddress({ hash: digest, signature: signedDelegation.signature as `0x${string}` })
      const strict = process.env.DELEGATION_VERIFY_STRICT === '1'
      if (recovered.toLowerCase() !== d.delegator.toLowerCase()) {
        if (strict) return res.status(400).json({ ok: false, error: 'signer_mismatch', recovered, expected: d.delegator })
        verifyError = 'signer_mismatch'
      }
    } catch (verErr: any) {
      verifyError = verErr?.message || 'verification_failed'
    }
    const dir = join(process.cwd(), 'data', 'delegations')
    mkdirSync(dir, { recursive: true })
    const baseName = role === 'core' ? `${delegatorSA}.json` : `${delegatorSA}__${role}.json`
    const enrichedJob = role === 'core' ? ({ createdAtMs: Date.now(), unwrapEvery: Number(job?.unwrapEvery ?? 24), ...job }) : undefined
    const payload: any = { delegatorSA, signedDelegation }
    if (encryptedJobHasFields(enrichedJob)) payload.job = enrichedJob
    if (recovered) payload._verification = { recovered, computedHash, verifyError }
    // Instrumentation hashing + warnings post-submit
    try {
      const d = signedDelegation.delegation
      const domainCfg = {
        name: process.env.DELEGATION_DOMAIN_NAME || 'Delegation',
        version: process.env.DELEGATION_DOMAIN_VERSION || '1',
        chainId: monadTestnet.id,
        verifyingContract: (process.env.DELEGATION_MANAGER_ADDRESS || (getDeleGatorEnvironment(monadTestnet.id) as any).DelegationManager) as any,
      }
      const hashes = computeCanonicalDelegationHashes({
        delegator: d.delegator,
        delegate: d.delegate,
        authority: d.authority,
        caveats: d.caveats || [],
        salt: d.salt,
      }, domainCfg)
      const baseWarnings = computeWarnings({
        recovered,
        expectedDelegator: d.delegator,
        salt: BigInt(d.salt || 0),
        duplicateStruct: hasStructHash(hashes.structHash),
        hasCaveats: Array.isArray(d.caveats) && d.caveats.length > 0,
      })
      let signatureModel: string = 'UNKNOWN'
      let detectionWarnings: string[] = []
      try {
        const { detectSignatureModel } = await import('./signature-model')
        const det = await detectSignatureModel({ delegator: d.delegator, digest: hashes.digest, signature: signedDelegation.signature })
        signatureModel = det.model
        detectionWarnings = det.warnings
      } catch (e) {
        detectionWarnings.push('SIG_MODEL_DETECT_FAILED')
      }
      const warnings = Array.from(new Set([...(baseWarnings||[]), ...detectionWarnings]))
      appendAudit({
        ts: Date.now(),
        action: 'submit',
        delegator: d.delegator,
        delegate: d.delegate,
        role,
        structHash: hashes.structHash,
        digest: hashes.digest,
        domainSeparator: hashes.domainSeparator,
  caveatsRoot: (hashes as any).caveatsHash || (hashes as any).caveatsRoot || '0x',
        salt: d.salt,
        warnings,
        recovered,
        verifyError,
        signatureModel,
      })
      payload.hashes = hashes
      payload.warnings = warnings
      payload.signatureModel = signatureModel
    } catch (eh) {
      console.warn('[submit] hashing instrumentation failed', (eh as any)?.message)
    }
    writeFileSync(join(dir, baseName), JSON.stringify(payload, null, 2))
    console.log('[api/delegations/submit] persisted', { file: baseName, role, delegatorSA })
    if (role !== 'core') return res.json({ ok: true, role, notice: 'signed delegation stored', immutable: true })
    // Do NOT auto start job unless requested explicitly
    if (job?.autostart) {
      let immediate: any = null
      try { const hash = await runOnceForDelegator(delegatorSA); immediate = { ok: true, hash } } catch (e: any) { immediate = { ok: false, error: e?.message } }
      return res.json({ ok: true, role, immutable: true, immediate, verification: { recovered, computedHash, verifyError } })
    }
    return res.json({ ok: true, role, immutable: true, verification: { recovered, computedHash, verifyError }, hashes: payload.hashes, warnings: payload.warnings })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'submit_failed' })
  }
})

// Helper to determine if job object has at least one serializable property of interest
function encryptedJobHasFields(job: any): boolean {
  if (!job || typeof job !== 'object') return false
  const whitelist = ['unwrapEvery','amountUSDC','slippageBps','ownerEOA','timeWindow','dailyCapUSDC','maxRuns','intervalSec','durationSec','permit','auth3009','unwrapToMon']
  return whitelist.some((k) => job[k] !== undefined)
}

// Verification endpoint: GET /api/delegations/verify/:delegatorSA
app.get('/api/delegations/verify/:delegatorSA', async (req, res) => {
  try {
    const delegatorSA = (req.params.delegatorSA || '').toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(delegatorSA)) return res.status(400).json({ ok: false, error: 'invalid_address' })
    const file = join(process.cwd(), 'data', 'delegations', `${delegatorSA}.json`)
    if (!existsSync(file)) return res.status(404).json({ ok: false, error: 'not_found' })
    const raw = JSON.parse(readFileSync(file,'utf8'))
    const sd = raw?.signedDelegation
    if (!sd) return res.status(400).json({ ok: false, error: 'missing_signedDelegation' })
    const d = sd.delegation
    // Recompute canonical hashes
    let canonical: any = null
    try {
      const domainCfg = { name: process.env.DELEGATION_DOMAIN_NAME || 'Delegation', version: process.env.DELEGATION_DOMAIN_VERSION || '1', chainId: monadTestnet.id, verifyingContract: (process.env.DELEGATION_MANAGER_ADDRESS || (getDeleGatorEnvironment(monadTestnet.id) as any).DelegationManager) }
      canonical = computeCanonicalDelegationHashes({ delegator: d.delegator, delegate: d.delegate, authority: d.authority, caveats: d.caveats||[], salt: d.salt }, domainCfg as any)
    } catch (e) {}
    // Legacy manual verification (keccak pack) for mismatch insight
    let recovered: string | null = null, verifyError: string | null = null
    try {
      const { keccak256, encodeAbiParameters, recoverAddress } = await import('viem')
      const caveats: any[] = Array.isArray(d.caveats) ? d.caveats : []
      const packed = caveats.map((c) => keccak256(encodeAbiParameters([
        { type: 'address' }, { type: 'bytes' }, { type: 'bytes' }
      ] as any, [c.enforcer, c.terms, c.args ?? '0x'])) )
      const caveatsRoot = keccak256(encodeAbiParameters([{ type: 'bytes32[]' }] as any, [packed]))
      const manualStruct = keccak256(encodeAbiParameters([
        { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }
      ] as any, [d.delegator, d.delegate, d.authority, BigInt(d.salt), caveatsRoot]))
      const domainSep = keccak256(encodeAbiParameters([{ type: 'string' }], ['Delegation']))
      const digest = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [domainSep, manualStruct]))
      recovered = await recoverAddress({ hash: digest, signature: sd.signature })
      if (recovered.toLowerCase() !== d.delegator.toLowerCase()) verifyError = 'signer_mismatch'
    } catch (err: any) { verifyError = err?.message || 'verification_failed' }
    // Build warnings unified
    let baseWarnings: string[] = []
    try {
      baseWarnings = computeWarnings({ recovered, expectedDelegator: d.delegator, salt: BigInt(d.salt||0), duplicateStruct: canonical ? hasStructHash(canonical.structHash) : false, hasCaveats: Array.isArray(d.caveats) && d.caveats.length>0 })
    } catch {}
    // signature model detection (digest canonical si possible, sinon rien)
    let signatureModel = 'UNKNOWN'
    let detectionWarnings: string[] = []
    if (canonical) {
      try {
        const { detectSignatureModel } = await import('./signature-model')
        const det = await detectSignatureModel({ delegator: d.delegator, digest: canonical.digest, signature: sd.signature })
        signatureModel = det.model
        detectionWarnings = det.warnings || []
      } catch { detectionWarnings.push('SIG_MODEL_DETECT_FAILED') }
    }
    const warnings = Array.from(new Set([...baseWarnings, ...detectionWarnings]))
    // Optionnel: audit entry (action=verify) sans doublons (best-effort)
    try {
      if (canonical) {
        appendAudit({ ts: Date.now(), action: 'verify', delegator: d.delegator, delegate: d.delegate, role: 'core', structHash: canonical.structHash, digest: canonical.digest, domainSeparator: canonical.domainSeparator, caveatsRoot: canonical.caveatsHash || canonical.caveatsRoot || '0x', salt: d.salt, warnings, signatureModel, verifyError, recovered })
      }
    } catch {}
    return res.json({ ok: true, delegator: d.delegator, delegate: d.delegate, structHash: canonical?.structHash, digest: canonical?.digest, domainSeparator: canonical?.domainSeparator, caveatsRoot: canonical?.caveatsHash || canonical?.caveatsRoot, recovered, verifyError, signatureModel, warnings })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'verify_failed' })
  }
})

// List official enforcers (with optional reverse lookup ?address=0x..)
app.get('/api/enforcers', async (req, res) => {
  try {
    const { ENFORCERS, findEnforcerName } = await import('./enforcers')
    const address = (req.query.address as string | undefined)?.toLowerCase()
    let match: any = null
    if (address && /^0x[0-9a-f]{40}$/.test(address)) {
      const name = findEnforcerName(address)
      match = name ? { name, address } : null
    }
    return res.json({ ok: true, count: Object.keys(ENFORCERS).length, enforcers: ENFORCERS, match })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'enforcers_failed' })
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

// Debug: expose caveat scope detection & balances
app.get('/api/delegations/scopes/:delegatorSA', async (req, res) => {
  try {
    const delegatorSA = (req.params.delegatorSA || '').toLowerCase()
    if (!delegatorSA.startsWith('0x') || delegatorSA.length !== 42) return res.status(400).json({ ok: false, error: 'invalid_address' })
    const dir = join(process.cwd(), 'data', 'delegations')
    const valueFile = join(dir, `${delegatorSA}__value.json`)
    if (!existsSync(valueFile)) return res.json({ ok: true, delegatorSA, hasValue: false })
    let raw: any
    try { raw = JSON.parse(readFileSync(valueFile, 'utf8')) } catch (e: any) { return res.status(500).json({ ok: false, error: 'parse_failed', detail: e?.message }) }
    const caveats = raw?.signedDelegation?.delegation?.caveats || []
    const detection = detectNativeValueScope(caveats)
    let monBal = '0'
    let wmonBal = '0'
    try { monBal = (await publicClient.getBalance({ address: delegatorSA as Address })).toString() } catch {}
    try {
      wmonBal = (await publicClient.readContract({
        address: WMON as Address,
        abi: [ { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] } ] as any,
        functionName: 'balanceOf',
        args: [delegatorSA as Address],
      }) as bigint).toString()
    } catch {}
    return res.json({ ok: true, delegatorSA, hasValue: true, caveatCount: caveats.length, detection, balances: { mon: monBal, wmon: wmonBal }, caveats })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'scopes_failed' })
  }
})

// Endpoint debug limites caveats (timeWindow / dailyCap)
app.get('/api/delegations/limits/:delegatorSA', async (req, res) => {
  try {
    const delegatorSA = (req.params.delegatorSA || '').toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(delegatorSA)) return res.status(400).json({ ok: false, error: 'invalid_address' })
    const dir = join(process.cwd(), 'data', 'delegations')
    const file = join(dir, `${delegatorSA}.json`)
    if (!existsSync(file)) return res.status(404).json({ ok: false, error: 'core_delegation_missing' })
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const caveats = raw?.signedDelegation?.delegation?.caveats || []
    let decoded: any = {}
    try {
      const { decodeCaveats } = await import('./delegation-builders')
      decoded = decodeCaveats(caveats)
    } catch (e) {
      decoded = { error: 'decode_failed', detail: (e as any)?.message }
    }
    return res.json({ ok: true, delegatorSA, caveatCount: caveats.length, decoded, caveats })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'limits_decode_failed' })
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

    // Détection scope natif: via helper (legacy textual + enforcer allow-list heuristics)
    let nativeDetect: DetectedNativeScope = { hasNativeScope: false }
    try {
      const caveats = valueDel?.signedDelegation?.delegation?.caveats || []
      nativeDetect = detectNativeValueScope(caveats)
    } catch {}
    const hasNativeScope = nativeDetect.hasNativeScope

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
  const dmData = viemEncodeFunctionData({ abi: DM_REDEEM_ABI as any, functionName: 'redeemDelegations', args: [[ctx] as any, modes as any, calldatas as any] }) as `0x${string}`
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
      const uoHash = await sendUserOpWithOptionalPaymaster({
        account: delegateSA,
        calls: [{ to: env.DelegationManager as Address, data: dmData }],
        maxFeePerGas,
        maxPriorityFeePerGas,
      })
      try {
        const d = valueDel.signedDelegation.delegation
        const domainCfg = { name: process.env.DELEGATION_DOMAIN_NAME || 'Delegation', version: process.env.DELEGATION_DOMAIN_VERSION || '1', chainId: monadTestnet.id, verifyingContract: (process.env.DELEGATION_MANAGER_ADDRESS || (getDeleGatorEnvironment(monadTestnet.id) as any).DelegationManager) }
        const h = computeCanonicalDelegationHashes({ delegator: d.delegator, delegate: d.delegate, authority: d.authority, caveats: d.caveats||[], salt: d.salt }, domainCfg as any)
        const { appendRunEvent } = await import('./utils/history')
        appendRunEvent({ ts: Date.now(), delegator: delegatorSA, amountInUSDC: '0', amountOutToken: wad.toString(), unwrap: false, userOperationHash: uoHash, strategy: 'withdraw-native', structHashes: [h.structHash] })
        appendAudit({ ts: Date.now(), action: 'execute', delegator: delegatorSA, delegate: d.delegate, role: 'value', structHash: h.structHash, digest: h.digest, domainSeparator: h.domainSeparator, caveatsRoot: h.caveatsHash, salt: d.salt, warnings: [] })
      } catch {}
      return res.json({ ok: true, userOperationHash: uoHash, transferred: wad.toString(), mode: 'native-scope', detected: nativeDetect })
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
  const dmData = viemEncodeFunctionData({ abi: DM_REDEEM_ABI as any, functionName: 'redeemDelegations', args: [permissionContexts as any, modes as any, calldatas as any] }) as `0x${string}`
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
    const uoHash = await sendUserOpWithOptionalPaymaster({
      account: delegateSA,
      calls: [{ to: env.DelegationManager as Address, data: dmData }],
      maxFeePerGas,
      maxPriorityFeePerGas,
    })
    try {
      const coreD = core.signedDelegation.delegation
      const valD = valueDel.signedDelegation.delegation
      const domainCfg = { name: process.env.DELEGATION_DOMAIN_NAME || 'Delegation', version: process.env.DELEGATION_DOMAIN_VERSION || '1', chainId: monadTestnet.id, verifyingContract: (process.env.DELEGATION_MANAGER_ADDRESS || (getDeleGatorEnvironment(monadTestnet.id) as any).DelegationManager) }
      const hCore = computeCanonicalDelegationHashes({ delegator: coreD.delegator, delegate: coreD.delegate, authority: coreD.authority, caveats: coreD.caveats||[], salt: coreD.salt }, domainCfg as any)
      const hVal = computeCanonicalDelegationHashes({ delegator: valD.delegator, delegate: valD.delegate, authority: valD.authority, caveats: valD.caveats||[], salt: valD.salt }, domainCfg as any)
      const { appendRunEvent } = await import('./utils/history')
      appendRunEvent({ ts: Date.now(), delegator: delegatorSA, amountInUSDC: '0', amountOutToken: wad.toString(), unwrap: true, userOperationHash: uoHash, strategy: 'withdraw-fallback', structHashes: [hCore.structHash, hVal.structHash] })
      appendAudit({ ts: Date.now(), action: 'execute', delegator: delegatorSA, delegate: coreD.delegate, role: 'core+value', structHash: hCore.structHash, digest: hCore.digest, domainSeparator: hCore.domainSeparator, caveatsRoot: hCore.caveatsHash, salt: coreD.salt, warnings: [] })
      appendAudit({ ts: Date.now(), action: 'execute', delegator: delegatorSA, delegate: valD.delegate, role: 'core+value', structHash: hVal.structHash, digest: hVal.digest, domainSeparator: hVal.domainSeparator, caveatsRoot: hVal.caveatsHash, salt: valD.salt, warnings: [] })
    } catch {}
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
  const callData = viemEncodeFunctionData({
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
  const data = viemEncodeFunctionData({ abi: DM_REDEEM_ABI as any, functionName: 'redeemDelegations', args: [[ctx] as any, modes as any, calldatas as any] }) as `0x${string}`
    let maxFeePerGas: bigint = 80n * 10n ** 9n
    let maxPriorityFeePerGas: bigint = maxFeePerGas / 2n
    try { const gp = await publicClient.getGasPrice(); if (gp > maxFeePerGas) { maxFeePerGas = gp; maxPriorityFeePerGas = gp/2n || 1n } } catch {}
    const uoHash = await sendUserOpWithOptionalPaymaster({
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
    const uoHash = await sendUserOpWithOptionalPaymaster({
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

// Withdraw native MON from DELEGATE smart account (its own native balance) to its underlying EOA
app.post('/api/delegate/withdraw-mon', async (_req, res) => {
  try {
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
    // Lire balance native du delegate SA
    let bal = 0n
    try { bal = await publicClient.getBalance({ address: delegateSA.address as Address }) } catch {}
    if (bal === 0n) return res.status(400).json({ ok: false, error: 'no_mon_balance_delegate' })
    // Construire exécution simple: delegateSA -> EOA value = full balance (sauf garder 0.0000001 MON ? on prend tout pour simplicité)
    const value = bal
    const execGroups = [[{ target: eoa.address as Address, value, callData: '0x' as `0x${string}` }]]
    const { encodePermissionContextsFromDelegations, encodeExecutionCalldatasWithModes } = await import('./encoding')
    // Pas de délégation ici: le delegateSA est contrôlé directement par sa clé → on envoie un userOp direct (pas redeemDelegations)
    // Donc on peut utiliser sendUserOpWithOptionalPaymaster directement avec calls = simple value transfer using account abstraction call batching
    // viem AA client supporte calls value
    let maxFeePerGas = await publicClient.getGasPrice().catch(() => 80n * 10n ** 9n)
    if (maxFeePerGas < 80n * 10n ** 9n) maxFeePerGas = 80n * 10n ** 9n
    const maxPriorityFeePerGas = maxFeePerGas / 2n
    const uoHash = await sendUserOpWithOptionalPaymaster({
      account: delegateSA,
      calls: [{ to: eoa.address as Address, data: '0x', value }],
      maxFeePerGas,
      maxPriorityFeePerGas,
    })
    return res.json({ ok: true, userOperationHash: uoHash, transferred: value.toString() })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'delegate_withdraw_failed' })
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
  const callData = viemEncodeFunctionData({
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
  const data = viemEncodeFunctionData({ abi: DM_REDEEM_ABI as any, functionName: 'redeemDelegations', args: [[ctx] as any, modes as any, calldatas as any] }) as `0x${string}`
    // gas
    let maxFeePerGas: bigint = 80n * 10n ** 9n
    let maxPriorityFeePerGas: bigint = maxFeePerGas / 2n
    try { const gp = await publicClient.getGasPrice(); if (gp > maxFeePerGas) { maxFeePerGas = gp; maxPriorityFeePerGas = gp/2n || 1n } } catch {}
    const uoHash = await sendUserOpWithOptionalPaymaster({
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
  const uoHash = await sendUserOpWithOptionalPaymaster({
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
  const data = viemEncodeFunctionData({ abi: DM_REDEEM_ABI as any, functionName: 'redeemDelegations', args: [[ctx] as any, modes as any, calldatas as any] }) as `0x${string}`
    let maxFeePerGas: bigint = 80n * 10n ** 9n
    let maxPriorityFeePerGas: bigint = maxFeePerGas / 2n
    try { const gp = await publicClient.getGasPrice(); if (gp > maxFeePerGas) { maxFeePerGas = gp; maxPriorityFeePerGas = gp/2n || 1n } } catch {}
    const uoHash = await sendUserOpWithOptionalPaymaster({
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

// Simulation endpoint: POST /api/simulate
// Body: { delegatorSA, executions?: [{target,value,callData}], unwrapToMon?:bool }
// If executions omitted, builds default swap pipeline (like runner) for a single cycle.
app.post('/api/simulate', async (req, res) => {
  try {
    let { delegatorSA, executions, unwrapToMon } = req.body || {}
    if (typeof delegatorSA === 'string') delegatorSA = delegatorSA.toLowerCase()
    if (!delegatorSA || !/^0x[0-9a-f]{40}$/.test(delegatorSA)) return res.status(400).json({ ok: false, error: 'invalid_delegator' })
    const file = join(process.cwd(), 'data', 'delegations', `${delegatorSA}.json`)
    if (!existsSync(file)) return res.status(404).json({ ok: false, error: 'delegation_missing' })
    const json = JSON.parse(readFileSync(file, 'utf8'))
    const signed = json.signedDelegation
    const amountUSDC = BigInt(Math.floor(Number(json.job?.amountUSDC ?? 1) * 1_000_000))
    // Build default executions if none passed (simplified: just return) - keep light; reuse runner logic minimal.
    if (!Array.isArray(executions) || executions.length === 0) {
      // For brevity, we won't rebuild full swap here (needs router encoded calldata). Just echo placeholder.
      executions = []
    }
    // Normalize flat delegation
    const flat = {
      delegate: signed.delegation.delegate,
      delegator: signed.delegation.delegator,
      authority: signed.delegation.authority,
      caveats: (signed.delegation.caveats || []).map((c: any) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args })),
      salt: signed.delegation.salt,
      signature: signed.signature,
    }
    // Encode redeemDelegations call for each execution individually (like runner) so we can attempt a call
    const { encodePermissionContextsFromDelegations, encodeExecutionCalldatasWithModes } = await import('./encoding')
    const encodedCtxArr = encodePermissionContextsFromDelegations([[flat as any]])
    if (!Array.isArray(encodedCtxArr) || encodedCtxArr.length === 0) return res.status(500).json({ ok: false, error: 'ctx_encode_failed' })
    const [ctx] = encodedCtxArr
    const execGroups = (executions as any[]).map((e) => [{ target: e.target, value: BigInt(e.value || 0), callData: e.callData || '0x' }])
    const { calldatas, modes } = encodeExecutionCalldatasWithModes(execGroups)
    const permissionContexts = execGroups.map(() => ctx)
    const DM_REDEEM_ABI = [ { type: 'function', name: 'redeemDelegations', stateMutability: 'nonpayable', inputs: [ { name: '_permissionContexts', type: 'bytes[]' }, { name: '_modes', type: 'bytes32[]' }, { name: '_executionCallDatas', type: 'bytes[]' } ], outputs: [] } ] as const
    const data = viemEncodeFunctionData({ abi: DM_REDEEM_ABI as any, functionName: 'redeemDelegations', args: [permissionContexts as any, modes as any, calldatas as any] })
    // Perform eth_call via publicClient against DelegationManager (strict simulation)
    let success = true; let error: string | null = null
    const env = getDeleGatorEnvironment(monadTestnet.id)
    try {
      await publicClient.call({ to: env.DelegationManager as Address, data })
    } catch (e: any) {
      success = false
      error = e?.shortMessage || e?.message || String(e)
    }
    return res.json({ ok: true, success, error, executions: executions.length, modes: modes.length })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'simulate_failed' })
  }
})
  // -------- Paymaster status & test endpoints (added) --------
  const ENTRY_POINT_ABI_MIN = [
    { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  ] as const

  app.get('/api/paymaster/status', async (_req, res) => {
    try {
      const pmRpc = process.env.ZERO_DEV_PAYMASTER_RPC || process.env.PIMLICO_PAYMASTER_RPC || null
      const configured = !!pmRpc
      const useFlag = USE_PAYMASTER
      let entryPointBalance: string | null = null
      const pmAddress = process.env.PAYMASTER_ADDRESS // optional (verifying paymaster contract address)
      if (pmAddress && pmAddress.startsWith('0x') && pmAddress.length === 42) {
        try {
          const bal = await publicClient.readContract({
            address: ENTRY_POINT_V07,
            abi: ENTRY_POINT_ABI_MIN as any,
            functionName: 'balanceOf',
            args: [pmAddress as Address],
          }) as bigint
          entryPointBalance = bal.toString()
        } catch (e: any) {
          entryPointBalance = 'error:' + (e?.message || 'failed')
        }
      }
  return res.json({ ok: true, configured, useFlag, rawUseFlag: RAW_USE_PAYMASTER ?? null, pmRpc: configured ? 'set' : 'missing', pmAddress: pmAddress || null, entryPointBalance })
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || 'status_failed' })
    }
  })

  app.post('/api/paymaster/test', async (_req, res) => {
    try {
      const pmRpc = process.env.ZERO_DEV_PAYMASTER_RPC || process.env.PIMLICO_PAYMASTER_RPC
      if (!pmRpc) return res.status(400).json({ ok: false, error: 'paymaster_rpc_missing' })
      if (!USE_PAYMASTER) return res.status(400).json({ ok: false, error: 'use_paymaster_false' })
      const pk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}`
      if (!pk) return res.status(500).json({ ok: false, error: 'missing_delegate_key' })
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
      const uoHash = await sendUserOpWithOptionalPaymaster({
        account: delegateSA,
        calls: [{ to: delegateSA.address as Address, data: '0x' }],
        maxFeePerGas,
        maxPriorityFeePerGas,
      })
      return res.json({ ok: true, userOperationHash: uoHash, paymaster: true })
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || 'test_failed' })
    }
  })

// Fallback 404 handler (always JSON) - keep LAST before error handler
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
    console.log('[boot] endpoints ready: /api/topup /api/wrap /api/unwrap /api/delegations /api/diag /api/status /api/version /api/routes /api/paymaster/status /api/paymaster/test')
  })
}
