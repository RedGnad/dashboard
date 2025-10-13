import { appendAudit, createAuditLock, releaseAuditLock, readRollingSnapshot } from './audit'
import express from 'express'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
import cors from 'cors'
import 'dotenv/config'
import { writeFileSync, mkdirSync, existsSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publicClient, monadTestnet, bundlerClient, paymasterClient, asToolkitClient as _asToolkitClient } from './clients'
// Fallback si l'export est renommé / non présent (sécurité runtime)
const asToolkitClient = (_asToolkitClient || (() => publicClient)) as () => any
import { startJob, stopJob, runNow, getJobs, startAutoAnchoring, stopAutoAnchoring } from './scheduler'
import { decodeErrorResult } from 'viem'
import { runOnceForDelegator } from './runner'
import { buildDebugBundle } from './utils/debug'
import { Implementation, toMetaMaskSmartAccount, getDeleGatorEnvironment } from '@metamask/delegation-toolkit'
import { privateKeyToAccount } from 'viem/accounts'
import { USDC, UNISWAP_V2_ROUTER02, WMON, ENTRY_POINT_V07 } from './constants'
import { encodePermissionContextsFromDelegations, encodeExecutionCalldatasWithModes } from './encoding'
import { buildLimitCaveats } from './caveat-builders'
import { computeDelegationHashes, computeWarnings } from './hashing'
import { computeCanonicalDelegationHashes, typehashes } from './eip712'
// Remove duplicate appendAudit import (caused TS duplicate identifier)
import { hasStructHash, readAuditTail, newRunId, readAuditStream, auditStatus } from './audit'
import { computeDelegatorCoverage, computeGlobalCoverage } from './coverage'
import { strategyEngine, hashRationale } from './strategy/engine'
import { initGlobalPriceInfra } from './pricing/globalProvider'
import { loadRegistry, computeDailyForAllRPC, type DailyProtocolMetrics } from './metrics/protocols'
import { fetchDailyMetricsEnvio, listEnvioProtocolIds } from './metrics/envioAdapter'
import { computeCoreFeatures, computeCoreFeaturesAsync, computeSyntheticPrice } from './features'
import { startUserOpResolver } from './userop-resolver'
import { Address, encodeFunctionData as viemEncodeFunctionData, keccak256 } from 'viem'
import { readRunHistory, summarizeRunHistory } from './utils/history'
import { loadGuardrails, getGuardrailsConfigHash } from './guardrails'
import { listAdapters, getAdapter } from './source-adapter'
import { TOKENS, getToken } from './tokens'
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
// Initialize price infrastructure (Surge) early
try { initGlobalPriceInfra() } catch (e:any) { console.warn('[price] init failed', e?.message || e) }

// -------------------- Donations (configuration de pourcentage) --------------------
// Stockage: fichier delegation JSON -> job.donation = { pct: number (1-100), to: address, updatedAt: epoch_ms }
// Le backend reste agnostique vis-à-vis des "5 organismes"; la liste peut vivre côté front.
function isAddressLike(a: string | undefined): a is `0x${string}` { return !!a && /^0x[0-9a-fA-F]{40}$/.test(a) }

// GET: lire config donation
app.get('/api/donations/config/:delegator', (req, res) => {
  try {
    const delegator = (req.params.delegator || '').toLowerCase()
    if (!isAddressLike(delegator)) return res.status(400).json({ ok: false, error: 'invalid_delegator' })
    const file = join(process.cwd(), 'data', 'delegations', `${delegator}.json`)
    if (!existsSync(file)) return res.json({ ok: true, hasDelegation: false })
    let json: any
    try { json = JSON.parse(readFileSync(file, 'utf8')) } catch { return res.status(500).json({ ok: false, error: 'parse_failed' }) }
    const donation = json?.job?.donation || null
    return res.json({ ok: true, hasDelegation: true, donation })
  } catch (e:any) {
    return res.status(500).json({ ok: false, error: e?.message || 'donation_config_failed' })
  }
})

// POST: définir / mettre à jour l'intention de donation
app.post('/api/donations/intent', (req, res) => {
  try {
    const { delegator, pct, to } = req.body || {}
    const delegatorSA = (delegator || '').toLowerCase()
    if (!isAddressLike(delegatorSA)) return res.status(400).json({ ok: false, error: 'invalid_delegator' })
    const nPct = Number(pct)
    if (!Number.isFinite(nPct) || nPct <= 0 || nPct > 100) return res.status(400).json({ ok: false, error: 'invalid_pct' })
    const dest = (to || '').toLowerCase()
    if (!isAddressLike(dest)) return res.status(400).json({ ok: false, error: 'invalid_destination' })
    const file = join(process.cwd(), 'data', 'delegations', `${delegatorSA}.json`)
    if (!existsSync(file)) return res.status(404).json({ ok: false, error: 'delegation_missing' })
    let json: any
    try { json = JSON.parse(readFileSync(file, 'utf8')) } catch { return res.status(500).json({ ok: false, error: 'parse_failed' }) }
    json.job = json.job || {}
    json.job.donation = { pct: nPct, to: dest, updatedAt: Date.now() }
    try { writeFileSync(file, JSON.stringify(json, null, 2)) } catch { return res.status(500).json({ ok: false, error: 'persist_failed' }) }
    // Audit chain: action donation_intent (role system pour configuration)
    appendAudit({ ts: Date.now(), action: 'donation_intent', delegator: delegatorSA, delegate: json?.signedDelegation?.delegation?.delegate || '0x', role: 'system', warnings: [], modelHash: json?.job?.modelHash, inferenceProvider: json?.job?.inferenceProvider })
    return res.json({ ok: true, donation: json.job.donation })
  } catch (e:any) {
    return res.status(500).json({ ok: false, error: e?.message || 'donation_intent_failed' })
  }
})

// In-memory tracker for latest guardrail evaluation (preview or force)
let _lastGuardrailEval: { at: number; delegator?: string; eval: any } | null = null

// Validate AUTO_REVOKE_ABNORMAL_STREAK env (must be >=1). Adjust if invalid and audit.
try {
  const raw = process.env.AUTO_REVOKE_ABNORMAL_STREAK
  if (raw !== undefined) {
    const v = Number(raw)
    if (!Number.isFinite(v) || v < 1) {
      process.env.AUTO_REVOKE_ABNORMAL_STREAK = '1'
      appendAudit({ action: 'ai_decision', role: 'system', delegator: '0x', delegate: '0x', ts: Date.now(), guardrailReason: 'auto_revoke_threshold_adjusted', warnings: ['auto_revoke_threshold_adjusted'] })
      console.warn('[auto-revoke] invalid AUTO_REVOKE_ABNORMAL_STREAK value; forced to 1')
    }
  }
} catch {}
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

// --- Minimal typed ABIs (centralize to reduce duplicate inline any casts) ------------------------
// Viem 2.x is stricter about parameter typing; providing a const-asserted ABI helps inference.
// Only includes what we actually call (balanceOf, getAmountsOut). Extend cautiously.
const MIN_ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [ { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' } ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const
const UNISWAP_V2_ROUTER_MIN_ABI = [
  {
    name: 'getAmountsOut',
    type: 'function',
    stateMutability: 'view',
    inputs: [ { name: 'amountIn', type: 'uint256' }, { name: 'path', type: 'address[]' } ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const

// Tiny retry helper for transient 429s / gateway issues
async function withRetry<T>(fn: () => Promise<T>, opts?: { retries?: number; delayMs?: number }): Promise<T> {
  const retries = Math.max(0, opts?.retries ?? 2)
  const delayMs = Math.max(0, opts?.delayMs ?? 200)
  let lastErr: any
  for (let i = 0; i <= retries; i++) {
    try { return await fn() } catch (e: any) {
      lastErr = e
      // simple backoff
      if (i < retries) await new Promise(r => setTimeout(r, delayMs * (i + 1)))
    }
  }
  throw lastErr
}

// Helper to read ERC20 balance with minimal typing friction (viem strict params variant simplified)
async function readErc20Balance(token: Address, owner: Address): Promise<bigint> {
  return publicClient.readContract({
    address: token,
    authorizationList: [] as any,
    abi: MIN_ERC20_ABI as any,
    functionName: 'balanceOf',
    args: [owner],
  }) as Promise<bigint>
}

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
    // (No enrichment here; keep endpoint minimal for auth)
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
// Cache last successful protocol metrics response to avoid UI flicker to zeros on transient failures
let lastMetricsCache: { data: DailyProtocolMetrics[]; source: 'envio'; status: 'direct' | 'patched' | 'cache' | 'fallback'; at: number } | null = null
// Persist cache on disk to survive restarts
const fs = require('node:fs') as typeof import('node:fs')
const path = require('node:path') as typeof import('node:path')
const cacheFile = path.join(process.cwd(), 'data', 'metrics-cache.json')
try {
  if (fs.existsSync(cacheFile)) {
    const raw = fs.readFileSync(cacheFile, 'utf8')
    if (raw) { lastMetricsCache = JSON.parse(raw) }
  }
} catch {}
// Merge helper: avoid decreases within the same day by taking maxima and recomputing avg
function mergeMonotonicDaily(prev: DailyProtocolMetrics[] | null, next: DailyProtocolMetrics[]): DailyProtocolMetrics[] {
  if (!prev || prev.length === 0) return next
  const mapPrev = new Map<string, DailyProtocolMetrics>() // key: id|dateISO
  for (const r of prev) mapPrev.set(`${r.id}|${r.dateISO}`, r)
  const out: DailyProtocolMetrics[] = []
  for (const n of next) {
    const key = `${n.id}|${n.dateISO}`
    const p = mapPrev.get(key)
    if (!p) { out.push(n); continue }
    const usersDaily = Math.max(Number(p.usersDaily||0), Number(n.usersDaily||0))
    const txDaily = Math.max(Number(p.txDaily||0), Number(n.txDaily||0))
    // txCumulative is monotonic if provided; take numeric max when both set
    const tcP = p.txCumulative == null ? null : Number(p.txCumulative)
    const tcN = n.txCumulative == null ? null : Number(n.txCumulative)
    const txCumulative = tcP == null ? (tcN == null ? null : tcN) : (tcN == null ? tcP : Math.max(tcP, tcN))
    const avgTxPerUser = usersDaily > 0 ? txDaily / usersDaily : 0
    const avgFeeNative = n.avgFeeNative != null ? n.avgFeeNative : (p.avgFeeNative != null ? p.avgFeeNative : null)
    const depositDaily = (p.depositDaily == null && n.depositDaily == null) ? null : Math.max(Number(p.depositDaily||0), Number(n.depositDaily||0))
    const withdrawDaily = (p.withdrawDaily == null && n.withdrawDaily == null) ? null : Math.max(Number(p.withdrawDaily||0), Number(n.withdrawDaily||0))
    out.push({ id: n.id, dateISO: n.dateISO, usersDaily, txDaily, txCumulative, avgTxPerUser, avgFeeNative, depositDaily, withdrawDaily })
  }
  return out
}

// Control whether Envio 'direct' results should be treated as authoritative (replace cache)
// Default: true (to prevent artificial inflation from past patched maxima)
function isDirectAuthoritative(): boolean {
  const raw = String(process.env.METRICS_DIRECT_AUTHORITATIVE || 'true').toLowerCase()
  return ['true','1','yes','on'].includes(raw)
}
// Root landing page for quick sanity check
app.get('/', (_req, res) => {
  res.json({ ok: true, name: 'DCA API', endpoints: ['/api/health', '/api/delegate', '/api/diag'] })
})
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// Quick native value scope check: returns whether the current stored delegation allows native msg.value transfers.
// Heuristic: match textual marker in terms, or known enforcer addresses (allow-list), and emit maxAmount if terms encodes a uint256.
// GET /api/delegations/native-scope/:delegator
app.get('/api/delegations/native-scope/:delegator', (req, res) => {
  try {
    const delegator = String(req.params.delegator || '').toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(delegator)) return res.status(400).json({ ok: false, error: 'invalid_delegator' })
    const file = join(process.cwd(), 'data', 'delegations', `${delegator}.json`)
    if (!existsSync(file)) return res.json({ ok: true, hasDelegation: false, hasNativeScope: false })
    let json: any
    try { json = JSON.parse(readFileSync(file, 'utf8')) } catch { return res.status(500).json({ ok: false, error: 'parse_failed' }) }
    const caveats: any[] = json?.signedDelegation?.delegation?.caveats || []
    const det = detectNativeValueScope(caveats)
    return res.json({ ok: true, hasDelegation: true, hasNativeScope: det.hasNativeScope, enforcer: det.enforcer, maxAmount: det.maxAmount })
  } catch (e:any) {
    return res.status(500).json({ ok: false, error: e?.message || 'native_scope_check_failed' })
  }
})
// Protocol metrics (registry + daily via RPC quick scan)
app.get('/api/metrics/protocols/registry', (_req, res) => {
  try { return res.json({ ok: true, registry: loadRegistry() }) } catch (e:any) { return res.status(500).json({ ok: false, error: e?.message || 'registry_failed' }) }
})
app.get('/api/metrics/protocols/daily', async (req, res) => {
  // Disable HTTP caching for dynamic metrics
  try { res.setHeader('Cache-Control', 'no-store') } catch {}
  // Fast-path: immediately return last cached data for snappy 1s polling
  if (String(req.query.fast || '').toLowerCase() === '1') {
  if (lastMetricsCache) return res.json({ ok: true, data: lastMetricsCache.data, source: 'envio', status: lastMetricsCache.status, at: lastMetricsCache.at })
    const regFast = loadRegistry()
    const dateISOFast = new Date().toISOString().slice(0,10)
    const zerosFast = regFast.map(p => ({ id: p.id, dateISO: dateISOFast, usersDaily: 0, txDaily: 0, txCumulative: null, avgTxPerUser: 0, avgFeeNative: null, depositDaily: null, withdrawDaily: null }))
  return res.json({ ok: true, data: zerosFast, source: 'envio', status: 'cache' })
  }
  const envioUrl = process.env.ENVIO_GRAPHQL_URL
  const forceRpc = String(process.env.METRICS_RPC_FALLBACK_ONLY || '').toLowerCase()
  const preferEnvio = !['true','1','yes','on'].includes(forceRpc)
  const registry = loadRegistry()
  const wantScan = ['true','1','yes','on'].includes(String(req.query.scan || '').toLowerCase())

  // Helper: RPC fallback with modest scan window to stay responsive
  async function fallbackRPC() {
    try {
      // Keep it snappy: very small window and block cap by default
      const hours = Number(req.query.hours || 0.25) // ~15 minutes
      const withFees = String(req.query.withFees || 'false').toLowerCase()
      const maxBlocksScan = Number(req.query.maxBlocks || 400)
      const task = computeDailyForAllRPC(registry, { hours, withFees: ['true','1','yes','on'].includes(withFees), maxBlocksScan })
      // Hard timeout so UI never hangs
      const timeoutMs = Number(req.query.timeoutMs || 8000)
      const data = await Promise.race([
        task,
        new Promise((_, rej) => setTimeout(() => rej(new Error('rpc_fallback_timeout')), timeoutMs)),
      ]) as Awaited<ReturnType<typeof computeDailyForAllRPC>>
      // update cache (monotonic merge to avoid visible decreases)
      try {
        const merged = mergeMonotonicDaily(lastMetricsCache?.data || null, data)
        lastMetricsCache = { data: merged, source: 'envio', status: 'fallback', at: Date.now() }
        try { fs.writeFileSync(cacheFile, JSON.stringify(lastMetricsCache)) } catch {}
      } catch {}
      return res.json({ ok: true, data: lastMetricsCache!.data, source: 'envio', status: 'fallback' })
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message || 'rpc_fallback_failed' })
    }
  }

  if (wantScan) {
    // Caller explicitly asked to scan via RPC (quick sample), even if Envio is available
    return await fallbackRPC()
  }
  if (preferEnvio && envioUrl) {
    try {
      let data = await fetchDailyMetricsEnvio(registry)
  // Optional hybrid mode: patch only missing-zero protocols with a quick RPC sample
      const wantPatch = ['true','1','yes','on'].includes(String(req.query.patch || '').toLowerCase())
      const withFeesFlag = ['true','1','yes','on'].includes(String((req.query.fees || req.query.withFees || '') as string).toLowerCase())
      let patchedIds: string[] = []
      if (wantPatch) {
        try {
          const zeroIds = data.filter(d => (Number(d.usersDaily||0) === 0 && Number(d.txDaily||0) === 0)).map(d => d.id)
          if (zeroIds.length > 0) {
            const sub = registry.filter(p => zeroIds.includes(p.id))
            const patched = await computeDailyForAllRPC(sub, { hours: 0.25, maxBlocksScan: 300, withFees: withFeesFlag })
            const mapP = new Map(patched.map(p => [p.id, p]))
            data = data.map(row => {
              const p = mapP.get(row.id)
              if (p) { patchedIds.push(row.id); return p }
              return row
            })
          }
        } catch (e) { console.warn('[metrics] patch via RPC failed', (e as any)?.message || e) }
      }
      // update cache
      try {
        const status: 'direct' | 'patched' = patchedIds.length > 0 ? 'patched' : 'direct'
        const merged = (status === 'direct' && isDirectAuthoritative())
          ? data
          : mergeMonotonicDaily(lastMetricsCache?.data || null, data)
        lastMetricsCache = { data: merged, source: 'envio', status, at: Date.now() }
        try { fs.writeFileSync(cacheFile, JSON.stringify(lastMetricsCache)) } catch {}
      } catch {}
      return res.json({ ok: true, data: lastMetricsCache!.data, source: 'envio', status: lastMetricsCache!.status, patchedIds: patchedIds.length ? patchedIds : undefined })
    } catch (e: any) {
      console.warn('[metrics] Envio fetch failed', e?.message || e)
      if (!wantScan) {
        // If we have a previous good dataset, serve it to avoid zeros flicker
        if (lastMetricsCache) {
          return res.json({ ok: true, data: lastMetricsCache.data, source: 'envio', status: lastMetricsCache.status })
        }
        const dateISO = new Date().toISOString().slice(0,10)
        const zeros = registry.map(p => ({ id: p.id, dateISO, usersDaily: 0, txDaily: 0, txCumulative: null, avgTxPerUser: 0, avgFeeNative: null, depositDaily: null, withdrawDaily: null }))
        return res.json({ ok: true, data: zeros, source: 'envio', status: 'cache' })
      }
      return await fallbackRPC()
    }
  }
  // No Envio configured or explicitly disabled.
  // Default: respond immediately with zero metrics to keep UI snappy.
  // Opt-in: add ?scan=1 to perform a lightweight RPC scan.
  if (!wantScan) {
    // Serve last good data if available to avoid zeros when scan is not requested
    if (lastMetricsCache) {
      return res.json({ ok: true, data: lastMetricsCache.data, source: 'envio', status: lastMetricsCache.status })
    }
    const dateISO = new Date().toISOString().slice(0,10)
    const zeros = registry.map(p => ({ id: p.id, dateISO, usersDaily: 0, txDaily: 0, txCumulative: null, avgTxPerUser: 0, avgFeeNative: null, depositDaily: null, withdrawDaily: null }))
    return res.json({ ok: true, data: zeros, source: 'envio', status: 'cache' })
  }
  return await fallbackRPC()
})

// Background refresher: refresh Envio periodically to keep cache hot
let _bgMetricsTimer: NodeJS.Timeout | null = null
function startBgMetricsRefresh() {
  if (_bgMetricsTimer) return
  const tick = async () => {
    try {
      const envioUrl = process.env.ENVIO_GRAPHQL_URL
      if (!envioUrl) return
      const registry = loadRegistry()
  let data = await fetchDailyMetricsEnvio(registry)
      // light patch without fees
      const zeroIds = data.filter(d => (Number(d.usersDaily||0) === 0 && Number(d.txDaily||0) === 0)).map(d => d.id)
      if (zeroIds.length > 0) {
        const sub = registry.filter(p => zeroIds.includes(p.id))
        const patched = await computeDailyForAllRPC(sub, { hours: 0.25, maxBlocksScan: 200, withFees: false })
        const mapP = new Map(patched.map(p => [p.id, p]))
        data = data.map(row => mapP.has(row.id) ? (mapP.get(row.id)!) : row)
        const merged = mergeMonotonicDaily(lastMetricsCache?.data || null, data)
        lastMetricsCache = { data: merged, source: 'envio', status: 'patched', at: Date.now() }
      } else {
        const merged = isDirectAuthoritative() ? data : mergeMonotonicDaily(lastMetricsCache?.data || null, data)
        lastMetricsCache = { data: merged, source: 'envio', status: 'direct', at: Date.now() }
      }
      try { fs.writeFileSync(cacheFile, JSON.stringify(lastMetricsCache)) } catch {}
    } catch (e) {
      // Keep previous cache on errors
    } finally {
     _bgMetricsTimer = setTimeout(tick, 1000)
    }
  }
  _bgMetricsTimer = setTimeout(tick, 10)
}
startBgMetricsRefresh()
// Debug: list distinct Envio protocolId values found in index (to align mappings)
app.get('/api/metrics/envio/ids', async (_req, res) => {
  try {
    const ids = await listEnvioProtocolIds()
    return res.json({ ok: true, ids })
  } catch (e:any) {
    return res.status(500).json({ ok: false, error: e?.message || 'envio_ids_failed' })
  }
})
// Consolidated state snapshot (for monitoring)
app.get('/api/strategy/state', (_req, res) => {
  try {
    const fsMod = require('node:fs') as typeof import('node:fs')
    const pathMod = require('node:path') as typeof import('node:path')
    const auditFile = pathMod.join(process.cwd(), 'data', 'delegations', 'audit.log')
    let finalRollingHash: string | null = null
    let lines = 0
    if (fsMod.existsSync(auditFile)) {
      const raw = fsMod.readFileSync(auditFile, 'utf8').trim()
      if (raw) {
        const arr = raw.split('\n')
        lines = arr.length
        for (let i = arr.length -1; i>=0; i--) {
          try { const j = JSON.parse(arr[i]); if (j.rollingHash) { finalRollingHash = j.rollingHash; break } } catch {}
        }
      }
    }
    // anchors count
    const anchorFile = pathMod.join(process.cwd(), 'data', 'anchors.log')
    let anchors = 0
    if (fsMod.existsSync(anchorFile)) {
      const raw = fsMod.readFileSync(anchorFile, 'utf8').trim()
      anchors = raw ? raw.split('\n').filter(Boolean).length : 0
    }
    const guardrailsHash = getGuardrailsConfigHash()
    // last proof pack hash (header extraction naive: scan anchors for last packKeccak256)
    let lastPackHash: string | null = null
    if (fsMod.existsSync(anchorFile)) {
      try {
        const linesA = fsMod.readFileSync(anchorFile, 'utf8').trim().split('\n').filter(Boolean)
        for (let i = linesA.length -1; i>=0; i--) {
          try { const j = JSON.parse(linesA[i]); if (j.packKeccak256) { lastPackHash = j.packKeccak256; break } } catch {}
        }
      } catch {}
    }
    return res.json({ ok: true, rolling: { finalRollingHash, lines }, anchors, lastPackHash, guardrailsConfigHash: guardrailsHash })
  } catch (e:any) {
    return res.status(500).json({ ok: false, error: e?.message || 'state_failed' })
  }
})
// List registered source adapters (multi-chain readiness)
app.get('/api/strategy/source-adapters', (_req, res) => {
  try {
    const adapters = listAdapters().map(a => ({ id: a.id, chainId: a.chainId, kind: a.kind() }))
    return res.json({ ok: true, adapters })
  } catch (e:any) { return res.status(500).json({ ok: false, error: e?.message || 'adapters_failed' }) }
})
// Simple market snapshot via adapter: /api/strategy/market?adapter=monad-testnet&symbols=USDC,WMON
app.get('/api/strategy/market', async (req, res) => {
  try {
    const adapterId = String(req.query.adapter || 'monad-testnet')
    const symbols = String(req.query.symbols || 'USDC,WMON').split(',').map(s=>s.trim()).filter(Boolean)
    const adapter = getAdapter(adapterId)
    if (!adapter) return res.status(404).json({ ok: false, error: 'adapter_not_found' })
    const snap = await adapter.fetchMarketSnapshot(symbols)
    return res.json({ ok: true, snapshot: snap })
  } catch (e:any) { return res.status(500).json({ ok: false, error: e?.message || 'market_failed' }) }
})
// Auto-anchoring control
app.post('/api/strategy/auto-anchor/start', (req, res) => {
  try {
    const intervalSec = Math.max(60, Number(req.body?.intervalSec || 300))
    const r = startAutoAnchoring(intervalSec)
  // Avoid duplicate 'ok' spread warning by constructing object explicitly
  return res.json(r)
  } catch (e:any) {
    return res.status(500).json({ ok: false, error: e?.message || 'auto_anchor_start_failed' })
  }
})
app.post('/api/strategy/auto-anchor/stop', (_req, res) => {
  try { const r = stopAutoAnchoring(); return res.json(r) } catch (e:any) { return res.status(500).json({ ok: false, error: e?.message || 'auto_anchor_stop_failed' }) }
})
// Audit tail (simple feed pour HyperIndex ingestion initiale)
app.get('/api/delegations/audit', (req, res) => {
  const n = Math.min(Number(req.query.n ?? 200), 1000)
  return res.json({ ok: true, entries: readAuditTail(n) })
})
// Cursor stream: /api/delegations/audit/stream?cursor=0&limit=200 -> { entries, nextCursor, eof, total }
app.get('/api/delegations/audit/stream', (req, res) => {
  try {
    const cursor = Number(req.query.cursor ?? 0)
    const limit = Math.min(Number(req.query.limit ?? 200), 1000)
    const data = readAuditStream(cursor, limit)
    return res.json({ ok: true, ...data })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'stream_failed' })
  }
})
// Audit status (for polling ingestion heads)
app.get('/api/delegations/audit/status', (_req, res) => {
  try { return res.json(auditStatus()) } catch (e: any) { return res.status(500).json({ ok: false, error: e?.message || 'status_failed' }) }
})
// Proof endpoint: returns finalRollingHash and lightweight recomputation meta (size & last line)
app.get('/api/delegations/audit/proof', (_req, res) => {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const file = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
    let finalRollingHash: string | null = null
    let lines = 0
    let lastActionId: string | null = null
    let lastTs: number | null = null
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8').trim()
      if (raw) {
        const arr = raw.split('\n')
        lines = arr.length
        for (let i = arr.length - 1; i >= 0; i--) {
          const l = arr[i]
          if (!l) continue
            try {
              const j = JSON.parse(l)
              finalRollingHash = j.rollingHash || null
              lastActionId = j.actionId || null
              lastTs = j.ts || null
              break
            } catch {}
        }
      }
    }
    return res.json({ ok: true, schemaVersion: 1, lines, finalRollingHash, lastActionId, lastTs })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'proof_failed' })
  }
})
// Coverage per delegator
app.get('/api/delegations/coverage/:addr', (req, res) => {
  try {
    const addr = String(req.params.addr || '').toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return res.status(400).json({ ok: false, error: 'invalid_address' })
    const stats = computeDelegatorCoverage(addr)
    return res.json({ ok: true, stats })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'coverage_failed' })
  }
})
// Global coverage
app.get('/api/delegations/coverage', (_req, res) => {
  try {
    const stats = computeGlobalCoverage()
    return res.json({ ok: true, stats })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'coverage_global_failed' })
  }
})
// Strategy preview (AI). Query params optional: delegator=0x..., profile, force, provider. Volatility is computed dynamically.
app.get('/api/strategy/preview', async (req, res) => {
  try {
    const delegator = String(req.query.delegator || '0x').toLowerCase()
  const profileQ = String(req.query.profile || '').toLowerCase()
  const forceQ = String(req.query.force || '').toLowerCase() // 'buy' | 'sell' for test only
  const providerQ = String(req.query.provider || '').toLowerCase() // e.g. 'openai' | 'opengradient'
    // New: optional tokens=SYMA,SYMB,... to preview multi-asset targets
    const tokensQ = String(req.query.tokens || '').trim()
    console.log('[strategy] preview request', { delegator })
  const feat = await computeCoreFeaturesAsync(delegator)
  const snapshotPrice = (feat as any).snapshotPrice ?? null
  const priceSource = (feat as any).priceSource || 'unknown'
  const snapshotPriceTs = (feat as any).snapshotPriceTs ?? null
  const momentumShortMinusLong = (feat as any).momentumShortMinusLong ?? null
    // Build targets: if tokensQ provided, map to targets (exclude stables); else default to WMON
    let targets: { symbol: string; weightBps: number }[] = [ { symbol: 'WMON', weightBps: 5000 } ]
    try {
      if (tokensQ) {
        const { getToken } = await import('./tokens')
        const syms = tokensQ.split(',').map(s => s.trim()).filter(Boolean)
        const tradables = syms
          .map(sym => getToken(sym))
          .filter((t: any) => t && !t.isStable)
          .map((t: any) => t.symbol.toUpperCase())
        if (tradables.length) {
          // Equal weights for preview; engine uses only the first primary for now
          const w = Math.floor(10_000 / tradables.length)
          targets = tradables.map(s => ({ symbol: s, weightBps: w }))
        }
      }
    } catch {}
    const ctx = {
      timestamp: Date.now(),
      delegator,
      balances: {},
      targets,
      prices: { USDC: '1', WMON: '0' },
      recentExecutions: [],
      riskParams: { maxSlippageBps: 80, maxSingleUsd: 100 },
  marketVolatilityScore: Number.isFinite(feat.features.volatilitySimple) ? Math.min(Math.max(Number(feat.features.volatilitySimple),0), 2) : 0.35,
  strategyProfile: profileQ === 'conservative' || profileQ === 'aggressive' ? (profileQ as any) : 'default',
    testForceAction: forceQ === 'buy' || forceQ === 'sell' ? (forceQ as any) : '',
    inferenceProviderOverride: providerQ || undefined,
    }
  const nowTs = Date.now()
  const staleMsCfg = process.env.SWITCHBOARD_STALE_MS ? Number(process.env.SWITCHBOARD_STALE_MS) : 15_000
  const ageMs = snapshotPriceTs ? Math.max(0, nowTs - snapshotPriceTs) : null
  const isSurge = priceSource === 'surge'
  const isFallback = priceSource !== 'surge'
  const stale = ageMs != null && isSurge ? ageMs > staleMsCfg : false
  const decision = await strategyEngine.decide(ctx as any)
  const meta = decision.meta || {}
    const aiRationaleHash = hashRationale(decision.rationale)
  const featureHash = feat.featureHash
  const featureHashV2 = feat.featureHashV2
    // Build canonical features serialization identical to featureHash input (minus variable asOfTs if needed)
    const canonicalParts: string[] = []
    canonicalParts.push(`v=${feat.schemaVersion}`)
    canonicalParts.push(`ts=${feat.asOfTs}`)
    for (const k of feat.order) {
      const v = (feat.features as any)[k]
      canonicalParts.push(`${k}=${v === null || v === undefined ? 'null' : v}`)
    }
    const featuresCanonical = canonicalParts.join('\n')
    // Inference subset (only features actually used by the model today)
    const inferenceFeatures = {
      allocationDeviation: feat.features.allocationDeviation ?? 0,
      executionsLast24h: feat.features.executionsLast24h ?? 0,
      volatilitySimple: feat.features.volatilitySimple ?? 0,
      momentumShortMinusLong: momentumShortMinusLong ?? null,
    }
    // Guardrails v2 evaluation (uses recent executions context via audit scan lightweight)
    let guardrailEval: any = null
    // Pré-calcul HyperIndex minimal pour guardrail (abnormalTransferFlag)
    let hyperAbnormalFlag: number | undefined
    try {
      const { aggregateHyperIndex } = require('./hyperindex/aggregator') as typeof import('./hyperindex/aggregator')
      const agg = aggregateHyperIndex({ includeCanonical: false })
      if (agg && typeof (agg.hyperMetrics as any).events_transfer_24h === 'number') {
        const transfers = (agg.hyperMetrics as any).events_transfer_24h
        hyperAbnormalFlag = transfers > 50 ? 1 : 0
  if (process.env.DEBUG_GUARDRAILS) console.log('[force] hyper metrics transfers', { transfers, hyperAbnormalFlag })
      } else {
  if (process.env.DEBUG_GUARDRAILS) console.log('[force] hyper metrics missing events_transfer_24h (agg null or metric absent)')
      }
    } catch {}
    try {
      const { evaluateGuardrailsV2, loadGuardrails } = await import('./guardrails')
      // Build execution summary (scan last 500 lines for executions & last decision)
      const fsMod = await import('node:fs')
      const pathMod = await import('node:path')
      const auditFile = pathMod.join(process.cwd(), 'data', 'delegations', 'audit.log')
      let lastExecutionTs: number | undefined
      let executions24h = 0
      let spentUsd24h = 0 // placeholder until dollar tracking
      let lastDecisionFeatureHash: string | undefined
      let lastDecisionFeatureHashV2: string | undefined
      let lastDecisionVolatilitySimple: number | undefined
      const since24h = Date.now() - 24*60*60*1000
      if (fsMod.existsSync(auditFile)) {
        try {
          const lines = fsMod.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean)
          for (let i = lines.length - 1; i >= 0 && i >= lines.length - 500; i--) {
            try {
              const j = JSON.parse(lines[i])
              if (j.action === 'execute') {
                if (!lastExecutionTs) lastExecutionTs = j.ts
                if (j.ts >= since24h) executions24h++
              } else if (j.action === 'ai_decision' && !lastDecisionFeatureHash) {
                lastDecisionFeatureHash = j.featureHash
                lastDecisionFeatureHashV2 = j.featureHashV2
                lastDecisionVolatilitySimple = j.inferenceFeatures?.volatilitySimple
              }
            } catch {}
          }
        } catch {}
      }
      const grCfg = loadGuardrails()
      guardrailEval = evaluateGuardrailsV2(grCfg, {
        ai: { risk: decision.riskScore, confidence: decision.confidence },
        ctx: { lastExecutionTs, executions24h, spentUsd24h, lastDecisionFeatureHash, lastDecisionFeatureHashV2, lastDecisionVolatilitySimple },
        features: { featureHash, featureHashV2, asOfTs: feat.asOfTs, volatilitySimple: feat.features.volatilitySimple ?? undefined },
        hyper: hyperAbnormalFlag !== undefined ? { abnormalTransferFlag: hyperAbnormalFlag } : undefined,
      })
  if (process.env.DEBUG_GUARDRAILS) console.log('[force] guardrailEval', guardrailEval)
  if (process.env.DEBUG_GUARDRAILS) console.log('[force] guardrailEval', guardrailEval)
  _lastGuardrailEval = { at: Date.now(), delegator, eval: guardrailEval }
  if (process.env.DEBUG_GUARDRAILS) console.log('[force] guardrailEval', guardrailEval)
  _lastGuardrailEval = { at: Date.now(), delegator, eval: guardrailEval }
      // --- Auto-revoke integration (streak abnormal hyperindex) ---
      try {
        const { recordGuardrailHit, maybeAutoRevoke, isRevoked } = require('./revocation') as typeof import('./revocation')
        const abnormalDetected = (guardrailEval?.warnings || []).includes('abnormal_hyperindex_activity') || guardrailEval?.reason === 'abnormal_hyperindex_activity' || hyperAbnormalFlag === 1
        if (abnormalDetected) {
          recordGuardrailHit(delegator, 'abnormal_hyperindex_activity')
          const rec = maybeAutoRevoke(delegator, { reason: 'auto_revoke_abnormal_hyperindex' })
          if (rec) console.warn('[auto-revoke] delegation revoked', rec)
        } else {
          recordGuardrailHit(delegator, 'clear')
        }
        const revoked = isRevoked(delegator)
        if (revoked) {
          // Override blocking if revoked
          guardrailEval = { blocked: true, reason: 'revoked', warnings: ['revoked'], info: { revokedAt: revoked.revokedAt } }
        }
      } catch (e) {
        console.warn('[auto-revoke] integration failed (non-blocking)', (e as any)?.message || e)
      }
    } catch (e:any) {
      console.warn('[guardrails] eval failed (non-blocking)', e?.message || e)
    }
    appendAudit({
      action: 'ai_decision',
      ts: ctx.timestamp,
      delegator: delegator,
      delegate: '0x',
      role: 'ai',
      structHash: '0x',
      digest: '0x',
      domainSeparator: '0x',
      caveatsRoot: '0x',
      salt: '0x',
      warnings: [],
      signatureModel: 'UNKNOWN',
    aiRationaleHash,
      aiRiskScore: decision.riskScore,
      aiConfidence: decision.confidence,
      strategyEngineVersion: strategyEngine.version(),
    aiActionType: decision.actionType,
    aiTargetSymbol: Array.isArray(decision.steps) && decision.steps[0]?.to ? decision.steps[0].to : undefined,
      featureHash,
      featureHashV2,
      featureSchemaVersion: feat.schemaVersion,
      modelHash: meta.modelHash,
      inferenceProvider: meta.inferenceProvider,
  inferenceVersion: meta.inferenceVersion,
      featuresCanonical,
      inferenceFeatures,
      rawScore: meta.rawScore,
      logitZ: meta.logitZ,
      mappingVersion: meta.mappingVersion,
      weightsUsedHash: meta.weightsUsedHash,
  inferenceProofHash: meta.inferenceProofHash,
  snapshotPrice: snapshotPrice ?? undefined,
  priceSource: priceSource,
  snapshotPriceTs: snapshotPriceTs ?? undefined,
  guardrailReason: guardrailEval?.reason,
  guardrailReasonsAll: guardrailEval?.reasonsAll,
    })
    console.log('[strategy] decision', { actionType: decision.actionType, risk: decision.riskScore, hash: aiRationaleHash, featureHash })
  return res.json({
    ok: true,
    decision,
    aiRationaleHash,
    version: strategyEngine.version(),
    featureHash,
    featureHashV2,
    features: feat,
  snapshotPrice,
  priceSource,
  snapshotPriceTs,
  momentumShortMinusLong,
    priceMeta: { source: priceSource, isSurge, isFallback, ageMs, stale, staleMs: staleMsCfg },
    usedEnvioBalances: !!(feat as any).usedEnvioBalances,
    usedEnvioPrices: !!(feat as any).usedEnvioPrices,
    donation: (() => {
      try {
        if (!delegator || !/^0x[0-9a-f]{40}$/.test(delegator)) return null
        const file = join(process.cwd(), 'data', 'delegations', `${delegator}.json`)
        if (!existsSync(file)) return null
        const j = JSON.parse(readFileSync(file, 'utf8'))
        const d = j?.job?.donation
        if (!d || typeof d.pct !== 'number' || d.pct <= 0) return null
        const baseUsd = Number(decision?.meta?.amountInUSDC || 0)
        const donationUsd = baseUsd * (d.pct / 100)
        return { pct: d.pct, to: d.to, amountInUSDC: baseUsd, donationUsd: Number.isFinite(donationUsd) ? donationUsd : 0 }
      } catch { return null }
    })(),
    provenance: {
      modelHash: meta.modelHash,
      inferenceProvider: meta.inferenceProvider,
      rawScore: meta.rawScore,
      logitZ: meta.logitZ,
      mappingVersion: meta.mappingVersion,
      weightsUsedHash: meta.weightsUsedHash,
      featureSchemaVersion: feat.schemaVersion,
      featuresCanonical,
      inferenceFeatures,
      guardrails: guardrailEval || null,
      snapshotPrice,
      // Expose passive HyperIndex context to caller (optional UI / debug)
      ...( (() => {
        try {
          const { aggregateHyperIndex } = require('./hyperindex/aggregator') as typeof import('./hyperindex/aggregator')
          const agg = aggregateHyperIndex({ includeCanonical: false })
          if (!agg) return {}
          // Experimental v3 candidates (passives): momentum, abnormal flag, quantized price reuse.
          const exp: Record<string, number | string | null> = {}
          const pc15 = (agg.hyperMetrics as any).priceChangePct_24h // placeholder reuse (we only have 24h now)
          // momentum faux: dérivé simple (placeholder) => on met null si pas de granularité courte disponible
          // Replace placeholder with real momentum if available
          exp['exp_momentum'] = momentumShortMinusLong == null ? null : momentumShortMinusLong
          // abnormalTransferFlag: heuristique si events_transfer_24h > 2 * médiane approximative (absente) => simplifié: > 50
          const transfers = (agg.hyperMetrics as any).events_transfer_24h || 0
          exp['exp_abnormalTransferFlag'] = transfers > 50 ? 1 : 0
          // quantized price: on réutilise snapshotPrice si présent sinon null
          exp['exp_quantizedPrice'] = snapshotPrice == null ? null : snapshotPrice
          // pnl placeholder (null pour l'instant)
          exp['exp_pnlRealized'] = null
          return { eventSetHash: agg.eventSetHash, hyperMetrics: agg.hyperMetrics, expFeatures: exp }
        } catch { return {} }
      })() ),
    },
  })
  } catch (e: any) {
    console.error('[strategy] preview failed', e)
    return res.status(500).json({ ok: false, error: e?.message || 'strategy_preview_failed' })
  }
})
// Force generation of a new ai_decision (manual trigger) for a delegator; returns the new rolling hash.
app.post('/api/strategy/decision/force', async (req,res) => {
  try {
    const delegator = (req.body && (req.body as any).delegator ? String((req.body as any).delegator) : '0x').toLowerCase()
    try {
      const { isRevoked } = require('./revocation') as typeof import('./revocation')
      const revoked = isRevoked(delegator)
      if (revoked) {
        return res.status(403).json({ ok: false, error: 'delegation_revoked', revoked })
      }
    } catch {}
  const profileBody = String(req.body?.profile || '').toLowerCase()
  const forceBody = String(req.body?.force || '').toLowerCase()
  const providerBody = String(req.body?.provider || '').toLowerCase()
  const feat = await computeCoreFeaturesAsync(delegator)
  const snapshotPrice = (feat as any).snapshotPrice ?? null
  const priceSource = (feat as any).priceSource || 'unknown'
  const snapshotPriceTs = (feat as any).snapshotPriceTs ?? null
  const momentumShortMinusLong = (feat as any).momentumShortMinusLong ?? null
    const ctx = {
      timestamp: Date.now(),
      delegator,
      balances: {},
      targets: [ { symbol: 'WMON', weightBps: 5000 } ],
      prices: { USDC: '1', WMON: '0' },
      recentExecutions: [],
      riskParams: { maxSlippageBps: 80, maxSingleUsd: 100 },
  marketVolatilityScore: Number.isFinite(feat.features.volatilitySimple) ? Math.min(Math.max(Number(feat.features.volatilitySimple),0), 2) : 0.35,
  strategyProfile: profileBody === 'conservative' || profileBody === 'aggressive' ? (profileBody as any) : 'default',
  testForceAction: forceBody === 'buy' || forceBody === 'sell' ? (forceBody as any) : '',
  inferenceProviderOverride: providerBody || undefined,
    }
    const nowTs = Date.now()
    const staleMsCfg = process.env.SWITCHBOARD_STALE_MS ? Number(process.env.SWITCHBOARD_STALE_MS) : 15_000
    const ageMs = snapshotPriceTs ? Math.max(0, nowTs - snapshotPriceTs) : null
    const isSurge = priceSource === 'surge'
    const isFallback = priceSource !== 'surge'
  const stale = ageMs != null && isSurge ? ageMs > staleMsCfg : false
    const decision = await strategyEngine.decide(ctx as any)
    const meta = decision.meta || {}
    const aiRationaleHash = hashRationale(decision.rationale)
    const featureHash = feat.featureHash
    const featureHashV2 = feat.featureHashV2
    const canonicalParts: string[] = []
    canonicalParts.push(`v=${feat.schemaVersion}`)
    canonicalParts.push(`ts=${feat.asOfTs}`)
    for (const k of feat.order) {
      const v = (feat.features as any)[k]
      canonicalParts.push(`${k}=${v === null || v === undefined ? 'null' : v}`)
    }
    const featuresCanonical = canonicalParts.join('\n')

    // --- Guardrails + auto-revoke integration (mirrors preview endpoint) ---
    let guardrailEval: any = null
    let hyperAbnormalFlag: number | undefined
    try {
      const { aggregateHyperIndex } = require('./hyperindex/aggregator') as typeof import('./hyperindex/aggregator')
      const agg = aggregateHyperIndex({ includeCanonical: false })
      if (agg && typeof (agg.hyperMetrics as any).events_transfer_24h === 'number') {
        const transfers = (agg.hyperMetrics as any).events_transfer_24h
        hyperAbnormalFlag = transfers > 50 ? 1 : 0
  if (process.env.DEBUG_GUARDRAILS) console.log('[force] hyper metrics', { transfers, hyperAbnormalFlag })
      } else {
  if (process.env.DEBUG_GUARDRAILS) console.log('[force] no hyper metrics events_transfer_24h found (agg null?)')
      }
    } catch {}
    try {
      const { evaluateGuardrailsV2, loadGuardrails } = await import('./guardrails')
      // Build execution summary (scan last 500 lines for executions & last decision)
      const fsMod = await import('node:fs')
      const pathMod = await import('node:path')
      const auditFile = pathMod.join(process.cwd(), 'data', 'delegations', 'audit.log')
      let lastExecutionTs: number | undefined
      let executions24h = 0
      let spentUsd24h = 0
      let lastDecisionFeatureHash: string | undefined
      let lastDecisionFeatureHashV2: string | undefined
      let lastDecisionVolatilitySimple: number | undefined
      const since24h = Date.now() - 24*60*60*1000
      if (fsMod.existsSync(auditFile)) {
        try {
          const lines = fsMod.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean)
          for (let i = lines.length - 1; i >= 0 && i >= lines.length - 500; i--) {
            try {
              const j = JSON.parse(lines[i])
              if (j.action === 'execute') {
                if (!lastExecutionTs) lastExecutionTs = j.ts
                if (j.ts >= since24h) executions24h++
              } else if (j.action === 'ai_decision' && !lastDecisionFeatureHash) {
                lastDecisionFeatureHash = j.featureHash
                lastDecisionFeatureHashV2 = j.featureHashV2
                lastDecisionVolatilitySimple = j.inferenceFeatures?.volatilitySimple
              }
            } catch {}
          }
        } catch {}
      }
      const grCfg = loadGuardrails()
  if (process.env.DEBUG_GUARDRAILS) console.log('[force] guardrails config', { blockOnAbnormalHyperIndex: grCfg.blockOnAbnormalHyperIndex })
      guardrailEval = evaluateGuardrailsV2(grCfg, {
        ai: { risk: decision.riskScore, confidence: decision.confidence },
        ctx: { lastExecutionTs, executions24h, spentUsd24h, lastDecisionFeatureHash, lastDecisionFeatureHashV2, lastDecisionVolatilitySimple },
        features: { featureHash, featureHashV2, asOfTs: feat.asOfTs, volatilitySimple: feat.features.volatilitySimple ?? undefined },
        hyper: hyperAbnormalFlag !== undefined ? { abnormalTransferFlag: hyperAbnormalFlag } : undefined,
      })
  if (process.env.DEBUG_GUARDRAILS) console.log('[force] guardrailEval', guardrailEval)
      // Auto-revoke streak update
      try {
        const { recordGuardrailHit, maybeAutoRevoke, isRevoked } = require('./revocation') as typeof import('./revocation')
        const abnormalDetectedForce = (guardrailEval?.warnings || []).includes('abnormal_hyperindex_activity') || guardrailEval?.reason === 'abnormal_hyperindex_activity' || hyperAbnormalFlag === 1
        if (abnormalDetectedForce) {
          recordGuardrailHit(delegator, 'abnormal_hyperindex_activity')
          const rec = maybeAutoRevoke(delegator, { reason: 'auto_revoke_abnormal_hyperindex' })
          if (rec) console.warn('[auto-revoke] delegation revoked', rec)
        } else {
          recordGuardrailHit(delegator, 'clear')
        }
        const revoked = isRevoked(delegator)
        if (revoked) {
          guardrailEval = { blocked: true, reason: 'revoked', warnings: ['revoked'], info: { revokedAt: revoked.revokedAt } }
        }
      } catch (e) {
        console.warn('[auto-revoke] integration (force) failed (non-blocking)', (e as any)?.message || e)
      }
    } catch (e:any) {
      console.warn('[guardrails] eval (force) failed (non-blocking)', e?.message || e)
    }

    appendAudit({
      action: 'ai_decision', ts: ctx.timestamp, delegator, delegate: '0x', role: 'ai', structHash:'0x', digest:'0x', domainSeparator:'0x', caveatsRoot:'0x', salt:'0x', warnings:[], signatureModel:'UNKNOWN',
      aiRationaleHash, aiRiskScore: decision.riskScore, aiConfidence: decision.confidence, strategyEngineVersion: strategyEngine.version(), aiActionType: decision.actionType,
      featureHash, featureHashV2, featureSchemaVersion: feat.schemaVersion, modelHash: meta.modelHash, inferenceProvider: meta.inferenceProvider, featuresCanonical,
  inferenceVersion: meta.inferenceVersion,
  inferenceFeatures: { allocationDeviation: feat.features.allocationDeviation ?? 0, executionsLast24h: feat.features.executionsLast24h ?? 0, volatilitySimple: feat.features.volatilitySimple ?? 0 }, rawScore: meta.rawScore, logitZ: meta.logitZ, mappingVersion: meta.mappingVersion, weightsUsedHash: meta.weightsUsedHash, inferenceProofHash: meta.inferenceProofHash,
      guardrailReason: guardrailEval?.reason,
      guardrailReasonsAll: guardrailEval?.reasonsAll,
    })
  return res.json({ ok: true, rollingHash: 'pending_readback', guardrails: guardrailEval || null, momentumShortMinusLong })
  } catch (e:any) {
    return res.status(500).json({ ok: false, error: e?.message || 'force_decision_failed' })
  }
})

// Dynamic volatility endpoint (source: backend features)
// GET /api/metrics/volatility?delegator=0x...
app.get('/api/metrics/volatility', (req, res) => {
  try {
    const delegator = String(req.query.delegator || '0x').toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(delegator)) return res.status(400).json({ ok: false, error: 'invalid_delegator' })
    const feat = computeCoreFeatures(delegator)
    const vol = typeof feat.features.volatilitySimple === 'number' ? feat.features.volatilitySimple : null
    return res.json({ ok: true, delegator, volatilitySimple: vol, source: 'features', asOfTs: feat.asOfTs })
  } catch (e:any) {
    return res.status(500).json({ ok: false, error: e?.message || 'volatility_failed' })
  }
})

// Debug: inference provider info
app.get('/api/inference/provider', (req, res) => {
  try {
    const { selectInferenceProvider } = require('./strategy/providers') as typeof import('./strategy/providers')
    const override = typeof req.query.provider === 'string' ? String(req.query.provider) : undefined
    const prov = selectInferenceProvider(override)
    return res.json({ ok: true, provider: prov.name(), env: process.env.INFERENCE_PROVIDER || 'local', effective: override || null })
  } catch (e:any) {
    return res.status(500).json({ ok: false, error: e?.message || 'provider_info_failed' })
  }
})

// Latest AI decision with verification summary
app.get('/api/strategy/decision/latest', (req, res) => {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const file = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
    if (!fs.existsSync(file)) return res.json({ ok: true, empty: true, decision: null })
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (!raw) return res.json({ ok: true, empty: true, decision: null })
    const lines = raw.split('\n')
    let decision: any = null
    // Walk backwards to find last ai_decision
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]
      if (!l) continue
      try {
        const j = JSON.parse(l)
        if (j.action === 'ai_decision') { decision = j; break }
      } catch {}
    }
    if (!decision) return res.json({ ok: true, empty: true, decision: null })
    // Revocation status (if delegator present)
    let revoked: any = null
    try {
      if (decision.delegator && /^0x[0-9a-f]{40}$/.test(decision.delegator)) {
        const { isRevoked } = require('./revocation') as typeof import('./revocation')
        revoked = isRevoked(decision.delegator)
      }
    } catch {}
    // Build verification summary
    const verif: Record<string, { expected: any; actual: any; pass: boolean }> = {}
    function add(label: string, expected: any, actual: any) {
      verif[label] = { expected, actual, pass: expected === actual }
    }
    // Re-hash featuresCanonical if present
    if (decision.featuresCanonical) {
      try {
        const enc = new TextEncoder().encode(decision.featuresCanonical)
        let hex = '0x'; for (const b of enc) hex += b.toString(16).padStart(2,'0')
        const { keccak256 } = require('viem') as typeof import('viem')
        const fh = keccak256(hex as `0x${string}`)
        add('featureHash', decision.featureHash, fh)
        if (decision.featureHashV2) {
          // Reconstruct stable V2 serialization: exclude ts line and coarsen volatility to 4 decimals
          const lines = decision.featuresCanonical.split('\n')
          const kv: Record<string,string> = {}
          for (const l of lines) {
            const i = l.indexOf('='); if (i <= 0) continue
            const k = l.slice(0,i); const v = l.slice(i+1)
            kv[k] = v
          }
          const v = kv['v'] || '1'
          const keysStable = ['balanceStableRatio','balanceTargetRatio','allocationDeviation','executionsLast24h','volatilitySimple']
          const parts: string[] = []
          parts.push(`v=${v}`)
          for (const k of keysStable) {
            let val = kv[k]
            if (k === 'volatilitySimple' && val != null && val !== 'null') {
              const num = Number(val)
              val = Number.isFinite(num) ? Number(num.toFixed(4)).toString() : 'null'
            }
            parts.push(`${k}=${val == null || val === '' ? 'null' : val}`)
          }
          const enc2 = new TextEncoder().encode(parts.join('\n'))
          let hex2='0x'; for (const b of enc2) hex2+=b.toString(16).padStart(2,'0')
          const fh2 = keccak256(hex2 as `0x${string}`)
          add('featureHashV2', decision.featureHashV2, fh2)
        }
      } catch {}
    }
    // Model hash check (best effort)
    try {
      const modelPath = path.join(process.cwd(), 'strategy-model.json')
      if (fs.existsSync(modelPath)) {
        const { loadModel } = require('./strategy/model') as typeof import('./strategy/model')
        const model = loadModel()
        add('modelHash', decision.modelHash, model.modelHash)
      }
    } catch {}
    // Presence checks
    add('rawScore(present)', true, decision.rawScore !== undefined)
    add('mappingVersion(present)', true, decision.mappingVersion !== undefined)
    add('weightsUsedHash(present)', true, decision.weightsUsedHash !== undefined)
    const allPass = Object.values(verif).every(v => v.pass)
    return res.json({ ok: true, decision: { ...decision, revoked: !!revoked, guardrailReasonsAll: decision.guardrailReasonsAll || decision.warnings || [] }, verification: { pass: allPass, checks: verif } })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'latest_decision_failed' })
  }
})

// Revocation status
app.get('/api/delegations/revocation/status', (req,res) => {
  try {
    const delegator = String(req.query.delegator || '0x').toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(delegator)) return res.status(400).json({ ok: false, error: 'invalid_delegator' })
    const { isRevoked, getStreak } = require('./revocation') as typeof import('./revocation')
    const rec = isRevoked(delegator)
    return res.json({ ok: true, revoked: !!rec, record: rec || null, abnormalStreak: getStreak(delegator) })
  } catch (e:any) {
    return res.status(500).json({ ok: false, error: e?.message || 'revocation_status_failed' })
  }
})

// HyperIndex proof endpoint: expose canonical aggregation for external verification
app.get('/api/hyperindex/proof', (req, res) => {
  try {
    const { aggregateHyperIndex } = require('./hyperindex/aggregator') as typeof import('./hyperindex/aggregator')
    const includeCanonical = /^(1|true)$/i.test(String(req.query?.canonical || ''))
    const agg = aggregateHyperIndex({ includeCanonical })
    if (!agg) return res.json({ ok: true, empty: true })
    return res.json({ ok: true, proof: {
      asOfTs: agg.asOfTs,
      rangeMs: agg.rangeMs,
      eventCount: agg.eventCount,
      eventSetHash: agg.eventSetHash,
      hyperMetrics: agg.hyperMetrics,
      canonical: includeCanonical ? agg._canonical : undefined,
    } })
  } catch (e:any) {
    return res.status(500).json({ ok: false, error: e?.message || 'hyperindex_proof_failed' })
  }
})

// Replay an AI decision (latest or by rollingHash) with verification modes
// GET /api/strategy/decision/replay?rollingHash=0x..&mode=basic|strict|strict-snapshot
app.get('/api/strategy/decision/replay', (req, res) => {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const { keccak256 } = require('viem') as typeof import('viem')
    const file = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
    if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: 'no_audit_log' })
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (!raw) return res.status(404).json({ ok: false, error: 'empty_audit_log' })
    const lines = raw.split('\n')
    const rollingQ = String(req.query.rollingHash || '')
    const mode = String(req.query.mode || 'basic')
    let decision: any = null
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]
      if (!l) continue
      try {
        const j = JSON.parse(l)
        if (j.action === 'ai_decision') {
          if (!rollingQ || j.rollingHash === rollingQ) { decision = j; break }
        }
      } catch {}
    }
    if (!decision) return res.status(404).json({ ok: false, error: 'decision_not_found' })
    // Basic recomputation logic (reuse inline simplified version similar to replay-decision.ts)
    const { loadModel, computeScore, mapScoreToDecision } = require('./strategy/model') as typeof import('./strategy/model')
    // Re-hash featuresCanonical if available
    let reFeatureHash: string | undefined
    let reFeatureHashV2: string | undefined
    if (decision.featuresCanonical) {
      const enc = new TextEncoder().encode(decision.featuresCanonical)
      let hex = '0x'; for (const b of enc) hex += b.toString(16).padStart(2,'0')
      reFeatureHash = keccak256(hex as `0x${string}`)
      const linesF = decision.featuresCanonical.split('\n')
      const tsFiltered = linesF.filter((l: string) => !l.startsWith('ts=')).join('\n')
      const enc2 = new TextEncoder().encode(tsFiltered)
      let hex2='0x'; for (const b of enc2) hex2 += b.toString(16).padStart(2,'0')
      reFeatureHashV2 = keccak256(hex2 as `0x${string}`)
    }
    const model = loadModel()
    const featureInputs = decision.inferenceFeatures || {}
    const { score, z } = computeScore({
      allocationDeviation: featureInputs.allocationDeviation || 0,
      executionsLast24h: featureInputs.executionsLast24h || 0,
      volatilitySimple: featureInputs.volatilitySimple || 0,
    }, model)
    const mapped = mapScoreToDecision(score, {
      allocationDeviation: featureInputs.allocationDeviation || 0,
      executionsLast24h: featureInputs.executionsLast24h || 0,
      volatilitySimple: featureInputs.volatilitySimple || 0,
    })
    // Build checks depending on mode
    const checks: Record<string, { expected: any; actual: any; pass: boolean }> = {}
    function add(label: string, expected: any, actual: any) { checks[label] = { expected, actual, pass: expected === actual } }
    if (mode === 'basic' || mode === 'strict' || mode === 'strict-snapshot') {
      if (reFeatureHash) add('featureHash', decision.featureHash, reFeatureHash)
      add('modelHash', decision.modelHash, model.modelHash)
      add('actionType', decision.aiActionType, mapped.actionType === 'SELL' ? 'REBALANCE' : mapped.actionType)
      add('riskScore', decision.aiRiskScore, mapped.riskScore)
      add('confidence', decision.aiConfidence, mapped.confidence)
    }
    if (mode === 'strict' || mode === 'strict-snapshot') {
      if (reFeatureHashV2) add('featureHashV2', decision.featureHashV2, reFeatureHashV2)
      add('rawScore(present)', true, decision.rawScore !== undefined)
      add('mappingVersion(present)', true, decision.mappingVersion !== undefined)
      add('weightsUsedHash(present)', true, decision.weightsUsedHash !== undefined)
    }
    // strict-snapshot requires ALL snapshot related fields EXACT + presence
    const pass = Object.values(checks).every(c => c.pass)
    return res.json({ ok: true, pass, mode, rollingHash: decision.rollingHash, decisionTs: decision.ts, checks, recomputed: { featureHash: reFeatureHash, featureHashV2: reFeatureHashV2, modelHash: model.modelHash, score, z, mapped } })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'replay_failed' })
  }
})

// --- SSE Audit Stream ---
// Emits each new audit line appended after client connection.
// Lightweight tail-follow using file size polling.
app.get('/api/audit/stream', (req, res) => {
  // Headers for Server-Sent Events
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const file = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
  let position = 0
  let closed = false

  function send(event: string, data: any) {
    try { res.write(`event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`) } catch {}
  }

  // Initial state
  if (fs.existsSync(file)) {
    try {
      const stat = fs.statSync(file)
      position = stat.size
      send('init', { size: position })
    } catch {}
  } else {
    send('init', { size: 0 })
  }

  const interval = setInterval(() => {
    if (closed) return
    try {
      if (!fs.existsSync(file)) return
      const stat = fs.statSync(file)
      if (stat.size > position) {
        const fd = fs.openSync(file, 'r')
        const buf = Buffer.alloc(stat.size - position)
        fs.readSync(fd, buf, 0, buf.length, position)
        fs.closeSync(fd)
        position = stat.size
        const chunk = buf.toString('utf8')
        const lines = chunk.split('\n').filter(l => l.trim())
        for (const l of lines) {
          try {
            const j = JSON.parse(l)
            send('line', { line: j, rollingHash: j.rollingHash, action: j.action })
          } catch {}
        }
      }
    } catch (e:any) {
      send('error', { message: e?.message || 'poll_error' })
    }
  }, 1500) // 1.5s polling

  req.on('close', () => { closed = true; clearInterval(interval) })
})
// Ingestion endpoint (phase 1) - accepts array of events
// POST /api/strategy/events/ingest  body: { events: [{ id, ts, chainId, type, price?, amountQuote?, ... }] }
app.post('/api/strategy/events/ingest', (req, res) => {
  try {
    const { events } = req.body || {}
    if (!Array.isArray(events) || !events.length) return res.status(400).json({ ok: false, error: 'no_events' })
    const { appendEvents } = require('./hyperindex/eventStore') as typeof import('./hyperindex/eventStore')
    const ingested = events.map((e: any) => ({
      id: String(e.id),
      ts: Number(e.ts),
      chainId: Number(e.chainId || 0),
      type: String(e.type),
      baseToken: e.baseToken ? String(e.baseToken) : undefined,
      quoteToken: e.quoteToken ? String(e.quoteToken) : undefined,
      amountBase: e.amountBase != null ? String(e.amountBase) : undefined,
      amountQuote: e.amountQuote != null ? String(e.amountQuote) : undefined,
      price: e.price != null ? Number(e.price) : undefined,
      txHash: e.txHash ? String(e.txHash) : undefined,
      blockNumber: e.blockNumber != null ? Number(e.blockNumber) : undefined,
      meta: e.meta && typeof e.meta === 'object' ? e.meta : undefined,
    })).filter((e: any) => e.id && e.ts && e.type)
    if (!ingested.length) return res.status(400).json({ ok: false, error: 'invalid_events' })
    appendEvents(ingested as any)
    return res.json({ ok: true, ingested: ingested.length })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'ingest_failed' })
  }
})

// Features head (real computation using ingested events)
app.get('/api/strategy/features/head', (_req, res) => {
  try {
    const { computeFeatureSet } = require('./hyperindex/features') as typeof import('./hyperindex/features')
    const feat = computeFeatureSet({})
    if (!feat) return res.json({ ok: true, empty: true, features: null })
    return res.json({ ok: true, features: feat })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'features_head_failed' })
  }
})

// Proof pack latest (lightweight bundle). Returns gzipped JSON with files array.
app.get('/api/strategy/proof-pack/latest', async (_req, res) => {
  try {
    const fsMod = await import('node:fs')
    const pathMod = await import('node:path')
  const { keccak256 } = await import('viem')
  const zlib = await import('node:zlib')
    const { computeFeatureSet } = await import('./hyperindex/features')
    const { loadAllEvents } = await import('./hyperindex/eventStore')
    const auditFile = pathMod.join(process.cwd(), 'data', 'delegations', 'audit.log')
    let decisionLine: any = null
    let rollingHash: string | undefined
    let rollingHeight = 0
    if (fsMod.existsSync(auditFile)) {
      const lines = fsMod.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean)
      rollingHeight = lines.length
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const j = JSON.parse(lines[i])
          if (!rollingHash && j.rollingHash) rollingHash = j.rollingHash
          if (!decisionLine && j.action === 'ai_decision') {
            decisionLine = j
            if (rollingHash) break
          }
        } catch {}
      }
    }
    const features = computeFeatureSet({})
    const all = loadAllEvents()
    let events: any[] = []
    let eventsWindow: any
    if (features) {
      const to = features.asOfTs
      const from = Math.min(...features.windowSpecs.map((w: any) => w.fromTs))
      events = all.filter(e => e.ts >= from && e.ts <= to)
      eventsWindow = { from, to, count: events.length }
    } else {
      events = all.slice(-200)
      if (events.length) eventsWindow = { from: events[0].ts, to: events[events.length - 1].ts, count: events.length }
    }
    function stringToHex(str: string): `0x${string}` {
      const enc = new TextEncoder().encode(str)
      let hex = '0x'
      for (const b of enc) hex += b.toString(16).padStart(2, '0')
      return hex as `0x${string}`
    }
    const buildTs = Date.now()
    const chainId = Number(process.env.CHAIN_ID || (decisionLine?.chainId ?? features?.chainId ?? 0))
    const files: { name: string; content: string }[] = []
    if (decisionLine) files.push({ name: 'decision.json', content: JSON.stringify(decisionLine, null, 2) })
    if (features) files.push({ name: 'features.json', content: JSON.stringify(features, null, 2) })
    if (events.length) files.push({ name: 'events.jsonl', content: events.map(e => JSON.stringify(e)).join('\n') + '\n' })
    if (rollingHash) files.push({ name: 'rolling.txt', content: `${rollingHash}\nheight=${rollingHeight}\n` })
    // Inference canonical blob (if present)
    if (decisionLine && (decisionLine.featureHashV2 || decisionLine.inferenceProofHash)) {
      const canonicalInf = {
        provider: decisionLine.inferenceProvider || 'unknown',
        version: decisionLine.inferenceVersion || decisionLine.version || 'unknown',
        modelId: decisionLine.meta?.modelId || undefined,
        modelHash: decisionLine.modelHash || undefined,
        featureHashV2: decisionLine.featureHashV2 || null,
        delegator: decisionLine.delegator,
        ts: decisionLine.ts,
      }
      files.push({ name: 'inference.json', content: JSON.stringify(canonicalInf, null, 2) })
    }
    const manifestProvisional: any = {
      schemaVersion: '1.0.0',
      buildTs,
      chainId,
      decision: decisionLine ? { actionId: decisionLine.actionId, ts: decisionLine.ts, aiActionType: decisionLine.aiActionType } : undefined,
      decisionRollingHash: decisionLine?.rollingHash,
      featureHash: features?.featureHash,
      modelHash: decisionLine?.modelHash,
      weightsUsedHash: decisionLine?.weightsUsedHash,
      aiRationaleHash: decisionLine?.aiRationaleHash,
      rollingHash,
      rollingHashHeight: rollingHeight,
      inferenceProofHash: decisionLine?.inferenceProofHash,
      eventsWindow,
      files: [] as any[],
    }
    for (const f of files) {
      const hex = stringToHex(f.content)
      const k = keccak256(hex)
      manifestProvisional.files.push({ name: f.name, keccak256: k, size: Buffer.byteLength(f.content) })
    }
    // First bundle WITHOUT packKeccak field
    const provisionalFiles = [...files, { name: 'manifest.json', content: JSON.stringify(manifestProvisional, null, 2) }]
    const bundleSansPack = { files: provisionalFiles.map(f => ({ name: f.name, content: f.content })) }
    const bundleSansPackJson = JSON.stringify(bundleSansPack)
    const packKeccak256 = keccak256(stringToHex(bundleSansPackJson))
    // Optional anchoring (off-chain lightweight). If query anchor=1, append anchor line to data/anchors.log and attach anchorRef ONLY in final manifest (not hashed in packKeccak256 pre-image).
    let anchorRef: string | undefined
    const wantAnchor = typeof (_req.query as any)?.anchor !== 'undefined'
    if (wantAnchor) {
      const anchorTs = Date.now()
      anchorRef = `anc_${anchorTs}`
      try {
        const anchorsDir = pathMod.join(process.cwd(), 'data')
        const anchorsFile = pathMod.join(anchorsDir, 'anchors.log')
        if (!fsMod.existsSync(anchorsDir)) fsMod.mkdirSync(anchorsDir, { recursive: true })
        const anchorLine = {
          ts: anchorTs,
            anchorRef,
            packKeccak256,
            rollingHash,
            rollingHashHeight: rollingHeight,
            featureHash: features?.featureHash,
            decisionRollingHash: decisionLine?.rollingHash
        }
        fsMod.appendFileSync(anchorsFile, JSON.stringify(anchorLine) + '\n')
      } catch (e:any) {
        console.warn('[anchor] failed to append', e?.message || e)
      }
    }
    const manifestFinal = { ...manifestProvisional, packKeccak256, ...(anchorRef ? { anchorRef } : {}) }
    const finalFiles = [...files, { name: 'manifest.json', content: JSON.stringify(manifestFinal, null, 2) }]
    const finalBundle = { files: finalFiles.map(f => ({ name: f.name, content: f.content })) }
    const finalJson = JSON.stringify(finalBundle)
  const gz = zlib.gzipSync(Buffer.from(finalJson))
    res.setHeader('Content-Type', 'application/gzip')
    res.setHeader('X-Pack-Keccak256', packKeccak256)
    res.setHeader('Content-Disposition', `attachment; filename="proof-pack-${buildTs}.json.gz"`)
    return res.send(gz)
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'proof_pack_failed' })
  }
})

// Anchors listing (last 50)
app.get('/api/strategy/anchors', (req, res) => {
  try {
    const fsMod = require('node:fs') as typeof import('node:fs')
    const pathMod = require('node:path') as typeof import('node:path')
    const anchorsFile = pathMod.join(process.cwd(), 'data', 'anchors.log')
    if (!fsMod.existsSync(anchorsFile)) return res.json({ ok: true, anchors: [] })
    const raw = fsMod.readFileSync(anchorsFile, 'utf8').trim().split('\n').filter(Boolean)
    const lines = raw.slice(-50).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    return res.json({ ok: true, anchors: lines })
  } catch (e:any) {
    return res.status(500).json({ ok: false, error: e?.message || 'anchors_failed' })
  }
})

// Manual anchor append (optional) POST /api/strategy/anchors  { packKeccak256, rollingHash }
app.post('/api/strategy/anchors', (req, res) => {
  try {
    const fsMod = require('node:fs') as typeof import('node:fs')
    const pathMod = require('node:path') as typeof import('node:path')
    const { packKeccak256, rollingHash } = req.body || {}
    if (!packKeccak256 || !rollingHash) return res.status(400).json({ ok: false, error: 'missing_fields' })
    const anchorsFile = pathMod.join(process.cwd(), 'data', 'anchors.log')
    const anchorRef = 'anc_' + Date.now()
    const line = { ts: Date.now(), anchorRef, packKeccak256, rollingHash }
    fsMod.appendFileSync(anchorsFile, JSON.stringify(line) + '\n')
    return res.json({ ok: true, anchorRef })
  } catch (e:any) {
    return res.status(500).json({ ok: false, error: e?.message || 'anchor_append_failed' })
  }
})

// ---------------- HyperIndex style namespace (phase 1) ----------------
// GET /api/hyperindex/features/head  -> alias to strategy features head
app.get('/api/hyperindex/features/head', (_req, res) => {
  try {
    const { computeFeatureSet } = require('./hyperindex/features') as typeof import('./hyperindex/features')
    const feat = computeFeatureSet({})
    if (!feat) return res.json({ ok: true, empty: true, features: null })
    return res.json({ ok: true, features: feat })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'hyperindex_features_failed' })
  }
})

// GET /api/hyperindex/events?limit=100&sinceTs=...&types=swap,transfer
app.get('/api/hyperindex/events', (req, res) => {
  try {
    const { queryEvents, countEvents } = require('./hyperindex/eventStore') as typeof import('./hyperindex/eventStore')
    const limit = Math.min(Number(req.query.limit ?? 100), 500)
    const sinceTs = req.query.sinceTs ? Number(req.query.sinceTs) : undefined
    const typesParam = String(req.query.types || '')
    const typeIn = typesParam ? typesParam.split(',').filter(Boolean) : undefined
    const events = queryEvents({ limit, sinceTs, typeIn })
    return res.json({ ok: true, events, limit, totalApprox: countEvents() })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'hyperindex_events_failed' })
  }
})

// GET /api/hyperindex/_meta  -> mimic subset of HyperIndex _meta semantics
// Returns progress style info based on local event log only (single chain simulation)
app.get('/api/hyperindex/_meta', (_req, res) => {
  try {
    const { loadAllEvents } = require('./hyperindex/eventStore') as typeof import('./hyperindex/eventStore')
    const all = loadAllEvents()
    if (!all.length) return res.json({ ok: true, chains: [], eventsProcessed: 0 })
    const first = all[0]
    const last = all[all.length - 1]
    const chainIds = Array.from(new Set(all.map(e => e.chainId))).sort()
    const typeCounts: Record<string, number> = {}
    for (const e of all) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1
    return res.json({
      ok: true,
      eventsProcessed: all.length,
      firstEventTs: first.ts,
      lastEventTs: last.ts,
      chains: chainIds.map(id => ({ chainId: id, firstEventTs: all.find(e => e.chainId === id)?.ts || first.ts, lastEventTs: [...all].reverse().find(e => e.chainId === id)?.ts || last.ts })),
      types: typeCounts,
    })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'hyperindex_meta_failed' })
  }
})

// GET /api/hyperindex/routes -> proxy /api/_routes (helpful discovery)
app.get('/api/hyperindex/routes', async (_req, res) => {
  try {
    // Reuse internal route listing function by invoking the handler indirectly would be complex; simpler: replicate logic here quickly.
    const out: { method: string; path: string }[] = []
    // @ts-ignore internal express
    const stack = app._router && app._router.stack ? app._router.stack : []
    for (const layer of stack) {
      if (!layer) continue
      if (layer.route && layer.route.path) {
        const methods = Object.keys(layer.route.methods || {})
        for (const m of methods) out.push({ method: m.toUpperCase(), path: layer.route.path })
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        for (const s of layer.handle.stack) {
          if (s.route && s.route.path) {
            const methods = Object.keys(s.route.methods || {})
            for (const m of methods) out.push({ method: m.toUpperCase(), path: s.route.path })
          }
        }
      }
    }
    out.sort((a,b) => a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path))
    return res.json({ ok: true, routes: out.filter(r => r.path.startsWith('/api/hyperindex') || r.path.startsWith('/api/strategy') || r.path.startsWith('/api/delegations') || r.path.startsWith('/api/audit') ) })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'hyperindex_routes_failed' })
  }
})

// Execute endpoint: trigger execution from last or specific ai_decision
app.post('/api/strategy/execute', async (req, res) => {
  try {
    const { rollingHash, force, delegator } = req.body || {}
    let delegLower: string | undefined
    if (delegator) {
      const d = String(delegator).toLowerCase()
      if (!/^0x[0-9a-f]{40}$/.test(d)) return res.status(400).json({ ok: false, error: 'invalid_delegator' })
      delegLower = d
    }
    const { executeFromDecision } = await import('./execution/orchestrator')
    const result = await executeFromDecision({ rollingHash, force, delegator: delegLower })
    return res.json(result)
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'execute_failed' })
  }
})
// Strategy history: paginated ai_decision audit entries
// GET /api/strategy/history?limit=50&cursor=<rollingHash>&delegator=0x..
// Cursor = rollingHash of last seen entry (exclusive). Returns chronological order.
app.get('/api/strategy/history', (req, res) => {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
  const limit = Math.min(Number(req.query.limit ?? 50), 200)
  const tail = Math.max(0, Number(req.query.tail ?? 0)) // if >0, fetch only last N matching entries
    const cursor = String(req.query.cursor || '') // rollingHash
    const delegatorQ = String(req.query.delegator || '').toLowerCase()
    const file = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
    if (!fs.existsSync(file)) return res.json({ ok: true, entries: [], nextCursor: null, eof: true, total: 0 })
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (!raw) return res.json({ ok: true, entries: [], nextCursor: null, eof: true, total: 0 })
    const lines = raw.split('\n')
    const entries: any[] = []
    if (tail > 0) {
      // scan from end, collect last N matching ai_decision, then reverse to chronological
      for (let i = lines.length - 1; i >= 0 && entries.length < tail; i--) {
        const line = lines[i]
        if (!line) continue
        try {
          const j = JSON.parse(line)
          if (j.action === 'ai_decision') {
            if (delegatorQ && j.delegator?.toLowerCase() !== delegatorQ) continue
            entries.push(j)
          }
        } catch {}
      }
      entries.reverse()
    } else {
      for (const line of lines) {
        if (!line) continue
        try {
          const j = JSON.parse(line)
          if (j.action === 'ai_decision') {
            if (delegatorQ && j.delegator?.toLowerCase() !== delegatorQ) continue
            entries.push(j)
          }
        } catch {}
      }
    }
    // Chronological order already (file append order). Find start index after cursor
    let start = 0
    if (cursor) {
      const idx = entries.findIndex((e) => e.rollingHash === cursor)
      if (idx >= 0) start = idx + 1
    }
    const slice = entries.slice(start, start + limit)
    const nextCursor = slice.length ? slice[slice.length - 1].rollingHash : null
    const eof = start + slice.length >= entries.length
    return res.json({ ok: true, entries: slice, nextCursor: eof ? null : nextCursor, eof, total: entries.length })
  } catch (e: any) {
    console.error('[strategy-history] failed', e)
    return res.status(500).json({ ok: false, error: e?.message || 'history_failed' })
  }
})
// Effectiveness & guardrail metrics
app.get('/api/strategy/effectiveness', (_req, res) => {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const file = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
    const guardrails = loadGuardrails()
    const now = Date.now()
    const since24h = now - 24 * 60 * 60 * 1000
    let decisions = 0, decisions24h = 0, lastDecision: any = null
    let executions = 0, execSubmitted = 0, execBlocked = 0, execBlockedGuardrail = 0, execFailed = 0
    let execSubmitted24h = 0, execBlocked24h = 0, lastExecution: any = null
  const guardrailReasons: Record<string, number> = {}
    const GUARDRAIL_CODES = new Set(['risk_score_exceeds_max','confidence_below_min','max_exec_24h_reached','daily_cap_reached','min_spacing_not_elapsed'])
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8').trim()
      if (raw) for (const line of raw.split('\n')) {
        if (!line) continue
        try {
          const j = JSON.parse(line)
          if (j.action === 'ai_decision') {
            decisions++; if (j.ts >= since24h) decisions24h++; lastDecision = j
          } else if (j.action === 'execute') {
            executions++; const submitted = !!j.userOperationHash
            const warnings: string[] = Array.isArray(j.warnings) ? j.warnings : []
            const execFailedFlag = !submitted && warnings.includes('execution_failed')
            let guardrail: string | undefined = j.guardrailReason
            if (!guardrail && !submitted) {
              for (const w of warnings) { if (GUARDRAIL_CODES.has(w)) { guardrail = w; break } }
            }
            if (submitted) { execSubmitted++; if (j.ts >= since24h) execSubmitted24h++ }
            else if (guardrail) { execBlocked++; execBlockedGuardrail++; if (j.ts >= since24h) execBlocked24h++; guardrailReasons[guardrail] = (guardrailReasons[guardrail] || 0)+1 }
            else if (execFailedFlag) { execFailed++ }
            else { execBlocked++; if (j.ts >= since24h) execBlocked24h++ }
            lastExecution = j
          }
        } catch {}
      }
    }
  return res.json({ ok: true, totals: { decisions, executions: { total: executions, submitted: execSubmitted, blocked: execBlocked, blockedGuardrail: execBlockedGuardrail, failed: execFailed } }, window24h: { decisions: decisions24h, submittedExecutions: execSubmitted24h, blockedExecutions: execBlocked24h }, lastDecision: lastDecision && { ts: lastDecision.ts, rollingHash: lastDecision.rollingHash, risk: lastDecision.aiRiskScore, confidence: lastDecision.aiConfidence, actionType: lastDecision.aiActionType }, lastExecution: lastExecution && { ts: lastExecution.ts, userOperationHash: lastExecution.userOperationHash || null, warnings: lastExecution.warnings || [], guardrailReason: lastExecution.guardrailReason || null }, guardrailReasons, guardrails })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'effectiveness_failed' })
  }
})

// Per-delegator run history for UI mini-chart
// GET /api/strategy/run-history?delegator=0x..&limit=100
app.get('/api/strategy/run-history', (req, res) => {
  try {
    const delegator = String(req.query.delegator || '').toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(delegator)) return res.status(400).json({ ok: false, error: 'invalid_delegator' })
    const limit = Math.min(Number(req.query.limit ?? 100), 500)
    const events = readRunHistory(delegator, limit)
    // Also include AI decision ticks as synthetic points to advance the chart
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      const path = require('node:path') as typeof import('node:path')
      const file = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
      // Load job config (for baseline policy) and current USDC balance once
      let jobCfg: any = null
      try {
        const jf = path.join(process.cwd(), 'data', 'delegations', `${delegator}.json`)
        if (fs.existsSync(jf)) {
          const jraw = fs.readFileSync(jf, 'utf8')
          const j = JSON.parse(jraw)
          jobCfg = j?.job || null
        }
      } catch {}
      // Capture last known balance from prior run events (avoids async on-chain read here)
      let lastBalanceUSDC: bigint | null = null
      try {
        for (const e of events) {
          if (e && e.balanceAtRunUSDC) {
            try { lastBalanceUSDC = BigInt(String(e.balanceAtRunUSDC)) } catch {}
          }
        }
      } catch {}
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8').trim()
        if (raw) {
          const lines = raw.split('\n')
          const dec: Array<{ ts: number; aiActionType?: string }> = []
          for (let i = lines.length - 1; i >= 0 && dec.length < limit * 2; i--) {
            const l = lines[i]
            if (!l) continue
            try {
              const j = JSON.parse(l)
              if (j && j.action === 'ai_decision' && String(j.delegator || '').toLowerCase() === delegator) {
                dec.push({ ts: Number(j.ts) || Date.now(), aiActionType: j.aiActionType })
              }
            } catch {}
          }
          // Merge synthetic events where we don't already have a run event at the same timestamp
          const existingTs = new Set(events.map((e: any) => Number(e.ts)))
          // Track last known baseline to carry forward
          let lastBaseline: string | undefined = undefined
          for (const e of events) {
            if (e && e.baselineManualUSDC) lastBaseline = String(e.baselineManualUSDC)
          }
          const synthetics = dec
            .map((d) => {
              // Compute baseline from jobCfg
              let baseline: bigint = 0n
              try {
                const policy = String(jobCfg?.amountPolicy || '').toLowerCase()
                if ((policy === 'fixed' || !policy) && typeof jobCfg?.amountUSDC === 'number') {
                  baseline = BigInt(Math.floor(jobCfg.amountUSDC * 1_000_000))
                } else if (policy === 'pctbalance' && typeof jobCfg?.sizePct === 'number' && lastBalanceUSDC != null) {
                  const p = Math.max(0, Math.min(1, Number(jobCfg.sizePct)))
                  let base = (lastBalanceUSDC * BigInt(Math.floor(p * 1_000_000))) / 1_000_000n
                  if (typeof jobCfg.minUSDC === 'number') {
                    const minU = BigInt(Math.floor(jobCfg.minUSDC * 1_000_000))
                    if (base < minU) base = minU
                  }
                  if (typeof jobCfg.maxUSDC === 'number') {
                    const maxU = BigInt(Math.floor(jobCfg.maxUSDC * 1_000_000))
                    if (base > maxU) base = maxU
                  }
                  baseline = base
                } else if (lastBaseline) {
                  // Fallback to carried baseline
                  baseline = BigInt(lastBaseline)
                }
              } catch {}
              return {
                ts: d.ts,
                delegator, // ensure required field for DcaRunEvent
                amountInUSDC: '0',
                amountIntendedUSDC: undefined,
                skipped: true,
                skipReason: 'ai_decision',
                baselineManualUSDC: baseline ? String(baseline) : lastBaseline,
                balanceAtRunUSDC: lastBalanceUSDC != null ? String(lastBalanceUSDC) : undefined,
              }
            })
            .filter((e) => !existingTs.has(Number(e.ts)))
          // Merge, sort by ts, then trim to limit most recent
          const merged = [...events, ...synthetics].sort((a: any, b: any) => Number(a.ts) - Number(b.ts))
          while (merged.length > limit) merged.shift()
          // Replace events array
          events.splice(0, events.length, ...merged)
        }
      }
    } catch {}
    const summary = summarizeRunHistory(delegator)
    // For convenience, compute minimal dual-series arrays for UI (actual vs manual baseline)
    const series = (() => {
      // Load current job config to recompute "manual" baseline if it wasn't persisted per event
      let job: any = null
      try {
        const fs = require('node:fs') as typeof import('node:fs')
        const path = require('node:path') as typeof import('node:path')
        const f = path.join(process.cwd(), 'data', 'delegations', `${delegator}.json`)
        if (fs.existsSync(f)) {
          const js = JSON.parse(fs.readFileSync(f, 'utf8'))
          job = js?.job || null
        }
      } catch {}
      const actual: number[] = []
      const manual: number[] = []
      // For pctBalance baseline, use a constant base = first known balanceAtRunUSDC
      let firstBalanceUSDC: number | null = null
      for (const e of events) {
        if (firstBalanceUSDC == null && e.balanceAtRunUSDC) {
          try { firstBalanceUSDC = Number(e.balanceAtRunUSDC) / 1_000_000 } catch {}
        }
      }
      for (const e of events) {
        try { actual.push(e.skipped ? 0 : (e.amountInUSDC ? Number(e.amountInUSDC) / 1_000_000 : 0)) } catch { actual.push(0) }
        try {
          if (e.baselineManualUSDC) {
            manual.push(Number(e.baselineManualUSDC) / 1_000_000)
          } else if (job) {
            const policy = String(job.amountPolicy || '').toLowerCase()
            if ((policy === 'fixed' || !policy) && typeof job.amountUSDC === 'number') {
              manual.push(Number(job.amountUSDC))
            } else if (policy === 'pctbalance' && typeof job.sizePct === 'number' && e.balanceAtRunUSDC) {
              const balConst = firstBalanceUSDC != null ? firstBalanceUSDC : (Number(e.balanceAtRunUSDC) / 1_000_000)
              const p = Math.max(0, Math.min(1, Number(job.sizePct)))
              let base = balConst * p
              if (typeof job.minUSDC === 'number') base = Math.max(base, Number(job.minUSDC))
              if (typeof job.maxUSDC === 'number') base = Math.min(base, Number(job.maxUSDC))
              manual.push(base)
            } else {
              manual.push(0)
            }
          } else {
            manual.push(0)
          }
        } catch { manual.push(0) }
      }
      return { actual, manual }
    })()
    return res.json({ ok: true, events, summary, series })
  } catch (e:any) {
    return res.status(500).json({ ok: false, error: e?.message || 'run_history_failed' })
  }
})

// Dynamic route listing for discovery
app.get('/api/_routes', (req, res) => {
  try {
    const out: { method: string; path: string }[] = []
    // @ts-ignore accessing private Express internals acceptable here
    const stack = app._router && app._router.stack ? app._router.stack : []
    for (const layer of stack) {
      if (!layer) continue
      if (layer.route && layer.route.path) {
        const methods = Object.keys(layer.route.methods || {})
        for (const m of methods) out.push({ method: m.toUpperCase(), path: layer.route.path })
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        for (const s of layer.handle.stack) {
          if (s.route && s.route.path) {
            const methods = Object.keys(s.route.methods || {})
            for (const m of methods) out.push({ method: m.toUpperCase(), path: s.route.path })
          }
        }
      }
    }
    // Sort for determinism
    out.sort((a,b) => a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path))
    return res.json({ ok: true, routes: out })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'routes_failed' })
  }
})

// Anchor rollingHash stub (simulated on-chain anchor persistence)
// POST /api/audit/anchor  { note?: string }
// Reads last line rollingHash and appends anchor record to anchors.jsonl
app.post('/api/audit/anchor', (req, res) => {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const auditFile = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
    if (!fs.existsSync(auditFile)) return res.status(400).json({ ok: false, error: 'no_audit_log' })
    const raw = fs.readFileSync(auditFile, 'utf8').trim()
    if (!raw) return res.status(400).json({ ok: false, error: 'empty_audit_log' })
    const lines = raw.split('\n')
    let lastRolling: string | undefined
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]
      if (!l) continue
      try { const j = JSON.parse(l); if (j.rollingHash) { lastRolling = j.rollingHash; break } } catch {}
    }
    if (!lastRolling) return res.status(400).json({ ok: false, error: 'no_rolling_hash_found' })
    const anchorsFile = path.join(process.cwd(), 'data', 'delegations', 'anchors.jsonl')
    const rec = { ts: Date.now(), rollingHash: lastRolling, note: req.body?.note || null }
    fs.appendFileSync(anchorsFile, JSON.stringify(rec) + '\n')
    return res.json({ ok: true, anchored: rec })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'anchor_failed' })
  }
})

// List anchors
app.get('/api/audit/anchors', (_req, res) => {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const anchorsFile = path.join(process.cwd(), 'data', 'delegations', 'anchors.jsonl')
    if (!fs.existsSync(anchorsFile)) return res.json({ ok: true, anchors: [] })
    const raw = fs.readFileSync(anchorsFile, 'utf8').trim()
    if (!raw) return res.json({ ok: true, anchors: [] })
    const anchors = raw.split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    return res.json({ ok: true, anchors })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'anchors_failed' })
  }
})

// --- Scheduler control (AI autopilot) ---
// POST /api/scheduler/start { delegator: 0x.., intervalSec?: number, durationSec?: number, immediate?: boolean }
app.post('/api/scheduler/start', (req, res) => {
  try {
    const delegator = String(req.body?.delegator || '').toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(delegator)) return res.status(400).json({ ok: false, error: 'invalid_delegator' })
  const intervalSec = Math.max(5, Number(req.body?.intervalSec ?? 60))
  const jobType = (req.body?.jobType === 'dca_schedule' ? 'dca_schedule' : 'dca_ai') as 'dca_ai' | 'dca_schedule'
    const durationSec = req.body?.durationSec != null ? Number(req.body.durationSec) : undefined
    const immediate = !!req.body?.immediate
    // Optional job config patching: unwrap + sizing policy
    try {
      const fs = require('node:fs') as typeof import('node:fs')
      const path = require('node:path') as typeof import('node:path')
      const file = path.join(process.cwd(), 'data', 'delegations', `${delegator}.json`)
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8')
        const json = JSON.parse(raw)
        json.job = json.job || {}
        // unwrapToMon support
        if (typeof req.body?.unwrapToMon === 'boolean') {
          json.job.unwrapToMon = !!req.body.unwrapToMon
          json.job.unwrapEvery = json.job.unwrapToMon ? 1 : (json.job.unwrapEvery || 24)
          // Clear cached executions so runner rebuilds with unwrap if needed
          delete json.job.executions
        }
        // AI integration toggles
        if (typeof req.body?.dynamicByAI === 'boolean') {
          json.job.dynamicByAI = !!req.body.dynamicByAI
        }
        if (typeof req.body?.respectAiAction === 'boolean') {
          json.job.respectAiAction = !!req.body.respectAiAction
        }
        if (typeof req.body?.provider === 'string' && req.body.provider) {
          json.job.inferenceProvider = String(req.body.provider)
        }
        if (typeof req.body?.allowSellExecution === 'boolean') {
          json.job.allowSellExecution = !!req.body.allowSellExecution
        } else if (json.job.allowSellExecution === undefined) {
          // Default SELL enabled unless explicitly disabled
          json.job.allowSellExecution = true
        }
        // optional target token override (symbol)
        if (typeof req.body?.targetSymbol === 'string' && req.body.targetSymbol) {
          json.job.targetSymbol = String(req.body.targetSymbol).toUpperCase()
        }
        // source token for scheduled DCA: 'USDC' (default) or 'MON'
        if (typeof req.body?.source === 'string') {
          const s = String(req.body.source).toUpperCase()
          json.job.source = s === 'MON' ? 'MON' : 'USDC'
        }
        // amount policy: 'pctBalance' or fixed amount in chosen source
        const policy = String(req.body?.amountPolicy || '').toLowerCase()
        if (policy === 'pctbalance') {
          json.job.amountPolicy = 'pctBalance'
          const sp = Number(req.body?.sizePct)
          if (Number.isFinite(sp)) json.job.sizePct = Math.max(0, Math.min(1, sp))
          if (typeof req.body?.minUSDC === 'number') json.job.minUSDC = Number(req.body.minUSDC)
          if (typeof req.body?.maxUSDC === 'number') json.job.maxUSDC = Number(req.body.maxUSDC)
          // Ignore fixed amount when pctBalance selected
          delete json.job.amountUSDC
          delete json.job.amountMON
        } else if (policy === 'fixed') {
          delete json.job.amountPolicy
          const src = (json.job.source || 'USDC').toUpperCase()
          if (src === 'MON') {
            const amtMon = Number(req.body?.amountMON)
            if (Number.isFinite(amtMon) && amtMon > 0) {
              json.job.amountMON = amtMon
              delete json.job.amountUSDC
            }
          } else {
            const amt = Number(req.body?.amountUSDC)
            if (Number.isFinite(amt) && amt > 0) json.job.amountUSDC = amt
          }
        }
        // Optional slippageBps passthrough
        if (typeof req.body?.slippageBps === 'number') json.job.slippageBps = Math.max(0, Math.min(5000, Number(req.body.slippageBps)))
        fs.writeFileSync(file, JSON.stringify(json, null, 2))
      }
    } catch (e) {
      console.warn('[scheduler/start] job patch failed', e)
    }
  const st = startJob(delegator as any, intervalSec, { durationSec, immediate, jobType })
    return res.json({ ok: true, job: st })
  } catch (e:any) {
    return res.status(500).json({ ok: false, error: e?.message || 'scheduler_start_failed' })
  }
})
// POST /api/scheduler/stop { delegator: 0x.. }
app.post('/api/scheduler/stop', (req, res) => {
  try {
    const delegator = String(req.body?.delegator || '').toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(delegator)) return res.status(400).json({ ok: false, error: 'invalid_delegator' })
    const st = stopJob(delegator as any)
    return res.json({ ok: true, job: st })
  } catch (e:any) {
    return res.status(500).json({ ok: false, error: e?.message || 'scheduler_stop_failed' })
  }
})
// GET /api/scheduler/status
app.get('/api/scheduler/status', (_req, res) => {
  try { return res.json({ ok: true, jobs: getJobs() }) } catch (e:any) { return res.status(500).json({ ok: false, error: e?.message || 'scheduler_status_failed' }) }
})

// Export latest decision snapshot (features + provenance) for offline verification
// GET /api/strategy/decision/export/latest
app.get('/api/strategy/decision/export/latest', (req, res) => {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const file = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
    if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: 'no_audit_log' })
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (!raw) return res.status(404).json({ ok: false, error: 'empty_audit_log' })
    const lines = raw.split('\n')
    let decision: any = null
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]; if (!l) continue
      try { const j = JSON.parse(l); if (j.action === 'ai_decision') { decision = j; break } } catch {}
    }
    if (!decision) return res.status(404).json({ ok: false, error: 'no_decision_found' })
    const snapshot = {
      exportedAt: Date.now(),
      rollingHash: decision.rollingHash,
      featureHash: decision.featureHash,
      featureHashV2: decision.featureHashV2 || null,
      modelHash: decision.modelHash || null,
      weightsUsedHash: decision.weightsUsedHash || null,
      mappingVersion: decision.mappingVersion || null,
      rawScore: decision.rawScore,
      logitZ: decision.logitZ,
      aiActionType: decision.aiActionType,
      aiRiskScore: decision.aiRiskScore,
      aiConfidence: decision.aiConfidence,
      aiRationaleHash: decision.aiRationaleHash,
      featuresCanonical: decision.featuresCanonical || null,
      inferenceFeatures: decision.inferenceFeatures || null,
      provenance: {
        schemaVersion: decision.featureSchemaVersion || null,
        inferenceProvider: decision.inferenceProvider || null,
      }
    }
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Disposition', 'attachment; filename="decision-snapshot.json"')
    return res.send(JSON.stringify({ ok: true, snapshot }, null, 2))
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'export_failed' })
  }
})
// Guardrails inspect & reload
app.get('/api/strategy/guardrails', (_req, res) => {
  try { return res.json({ ok: true, guardrails: loadGuardrails(true) }) } catch (e: any) { return res.status(500).json({ ok: false, error: e?.message || 'guardrails_failed' }) }
})
app.post('/api/strategy/guardrails/reload', (_req, res) => {
  try { const gr = loadGuardrails(true); return res.json({ ok: true, reloaded: true, guardrails: gr }) } catch (e: any) { return res.status(500).json({ ok: false, error: e?.message || 'guardrails_reload_failed' }) }
})
// Guardrails head evaluation (replays minimal context to show what would block now)
app.get('/api/strategy/guardrails/head', async (_req, res) => {
  try {
    const { evaluateGuardrailsV2, loadGuardrails } = await import('./guardrails')
    const gr = loadGuardrails()
    const fsMod = await import('node:fs')
    const pathMod = await import('node:path')
    const auditFile = pathMod.join(process.cwd(), 'data', 'delegations', 'audit.log')
    let lastExecutionTs: number | undefined
    let executions24h = 0
    let spentUsd24h = 0
    let lastDecisionFeatureHash: string | undefined
    let lastDecisionFeatureHashV2: string | undefined
    let lastDecisionVolatilitySimple: number | undefined
    let lastDecisionTs: number | undefined
    const since24h = Date.now() - 24*60*60*1000
    if (fsMod.existsSync(auditFile)) {
      try {
        const lines = fsMod.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean)
        for (let i = lines.length - 1; i >= 0 && i >= lines.length - 1000; i--) {
          try {
            const j = JSON.parse(lines[i])
            if (j.action === 'execute') {
              if (!lastExecutionTs) lastExecutionTs = j.ts
              if (j.ts >= since24h) executions24h++
            } else if (j.action === 'ai_decision' && !lastDecisionFeatureHash) {
              lastDecisionFeatureHash = j.featureHash
              lastDecisionFeatureHashV2 = j.featureHashV2
              lastDecisionVolatilitySimple = j.inferenceFeatures?.volatilitySimple
              lastDecisionTs = j.ts
            }
          } catch {}
        }
      } catch {}
    }
    // Load current feature head
    let featureHead: any = null
    try {
      const { computeFeatureSet } = await import('./hyperindex/features')
      featureHead = computeFeatureSet({})
    } catch {}
    // Safeguard: computeFeatureSet may return a structure without .features nested object if schema changes
    let volatilitySimple: number | undefined
    try { volatilitySimple = featureHead && featureHead.features ? featureHead.features.volatilitySimple : undefined } catch {}
    const evalRes = evaluateGuardrailsV2(gr, {
      ai: { risk: undefined, confidence: undefined },
      ctx: { lastExecutionTs, executions24h, spentUsd24h, lastDecisionFeatureHash, lastDecisionFeatureHashV2, lastDecisionVolatilitySimple },
      features: featureHead ? { featureHash: featureHead.featureHash, featureHashV2: featureHead.featureHashV2, asOfTs: featureHead.asOfTs, volatilitySimple } : undefined,
    })
    const diff = {
      lastDecisionFeatureHash,
      currentFeatureHash: featureHead?.featureHash || null,
      lastDecisionFeatureHashV2,
      currentFeatureHashV2: featureHead?.featureHashV2 || null
    }
    return res.json({ ok: true, evaluation: evalRes, lastDecisionTs, featureAsOfTs: featureHead?.asOfTs || null, diff })
  } catch (e:any) {
    return res.status(500).json({ ok: false, error: e?.message || 'guardrails_head_failed' })
  }
})
// Return last guardrail evaluation (preview or force) for observability
app.get('/api/strategy/guardrails/last', (_req,res) => {
  try {
    if (!_lastGuardrailEval) return res.json({ ok: true, empty: true })
    const delegator = _lastGuardrailEval.delegator || process.env.DELEGATOR || undefined
    let streak: number | undefined
    let revoked: any = undefined
    if (delegator) {
      try {
        const rev = require('./revocation') as any
        streak = typeof rev.getStreak === 'function' ? rev.getStreak(delegator) : undefined
        const rec = typeof rev.isRevoked === 'function' ? rev.isRevoked(delegator) : null
        revoked = rec ? { revoked: true, record: rec, streak } : { revoked: false, streak }
      } catch {}
    }
    return res.json({ ok: true, last: _lastGuardrailEval, revocation: revoked })
  } catch (e:any) { return res.status(500).json({ ok: false, error: e?.message || 'guardrails_last_failed' }) }
})
// Domain metadata (typehashes + configured domain separator components) for external indexers
// NOTE: stray opener removed; proper handler defined below near the try/catch block
// app.get('/api/delegations/domain-meta', async (_req, res) => {
// Rolling hash snapshot
app.get('/api/audit/rolling-hash/snapshot', (_req,res) => {
  try { return res.json({ ok: true, snapshot: readRollingSnapshot() }) } catch { return res.status(500).json({ ok: false, error: 'snapshot_failed' }) }
})
// Audit lock (migration safety)
app.post('/api/audit/lock', (req,res) => {
  try { const note = (req.body && (req.body as any).note) || undefined; const r = createAuditLock(note); return res.json({ ok: true, ...r }) } catch (e:any) { return res.status(500).json({ ok: false, error: e?.message || 'lock_failed' }) }
})
app.post('/api/audit/unlock', (req,res) => {
  try { const flush = !req.body || (req.body as any).flush !== false; const r = releaseAuditLock(flush); return res.json({ ok: true, ...r }) } catch (e:any) { return res.status(500).json({ ok: false, error: e?.message || 'unlock_failed' }) }
})
// Proof pack debug: expose provisional manifest pre-image & final manifest recomputed live (not compressed) for auditors
app.get('/api/proof-pack/debug', async (_req,res) => {
  try {
    const fsMod = await import('node:fs')
    const pathMod = await import('node:path')
    const { keccak256 } = await import('viem')
    const auditFile = pathMod.join(process.cwd(), 'data', 'delegations', 'audit.log')
    let decisionLine: any = null; let rollingHash: string | undefined; let rollingHeight = 0
    if (fsMod.existsSync(auditFile)) {
      const lines = fsMod.readFileSync(auditFile,'utf8').trim().split('\n').filter(Boolean)
      rollingHeight = lines.length
      for (let i = lines.length -1; i>=0; i--) { try { const j = JSON.parse(lines[i]); if (!rollingHash && j.rollingHash) rollingHash = j.rollingHash; if (!decisionLine && j.action==='ai_decision') { decisionLine = j; if (rollingHash) break } } catch {} }
    }
    let features: any = null
    try { const { computeFeatureSet } = await import('./hyperindex/features'); features = computeFeatureSet({}) } catch {}
    const files: { name: string; content: string }[] = []
    if (decisionLine) files.push({ name:'decision.json', content: JSON.stringify(decisionLine,null,2) })
    if (features) files.push({ name:'features.json', content: JSON.stringify(features,null,2) })
    if (rollingHash) files.push({ name:'rolling.txt', content: `${rollingHash}\nheight=${rollingHeight}\n` })
    function sToHex(str:string){ const enc=new TextEncoder().encode(str); let h='0x'; for (const b of enc) h+=b.toString(16).padStart(2,'0'); return h as `0x${string}` }
    const manifestProv = { schemaVersion:'1.0.0', buildTs: Date.now(), decisionRollingHash: decisionLine?.rollingHash, featureHash: features?.featureHash, modelHash: decisionLine?.modelHash, files: files.map(f=>({ name:f.name, keccak256: keccak256(sToHex(f.content)) })) }
    const preImage = JSON.stringify({ files: [...files, { name:'manifest.json', content: JSON.stringify(manifestProv,null,2) }] })
    const packKeccak256 = keccak256(sToHex(preImage))
    return res.json({ ok: true, manifestProvisional: manifestProv, packKeccak256, preImageLength: preImage.length })
  } catch (e:any) {
    return res.status(500).json({ ok: false, error: e?.message || 'proof_pack_debug_failed' })
  }
})
// Proper domain-meta handler (fixed)
app.get('/api/delegations/domain-meta', async (_req, res) => {
  try {
    const domain = {
      name: process.env.DELEGATION_DOMAIN_NAME || 'Delegation',
      version: process.env.DELEGATION_DOMAIN_VERSION || '1',
      chainId: monadTestnet.id,
      verifyingContract: (process.env.DELEGATION_MANAGER_ADDRESS || (getDeleGatorEnvironment(monadTestnet.id) as any).DelegationManager),
    }
    // Sanity: ensure typehashes object shape
    const shape = Object.keys(typehashes || {})
    console.log('[domain-meta] resolved', { shape })
    return res.json({ ok: true, domain, typehashes })
  } catch (e: any) {
    console.error('[domain-meta] error', e)
    return res.status(500).json({ ok: false, error: 'domain_meta_failed:' + (e?.message || e) })
  }
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
        client: asToolkitClient(),
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
          client: asToolkitClient(),
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
          withRetry(() => publicClient.getBalance({ address: cachedDelegate.sa as `0x${string}` })),
          withRetry(() => readErc20Balance(USDC as Address, cachedDelegate.sa as Address)),
          withRetry(() => readErc20Balance(WMON as Address, cachedDelegate.sa as Address)),
        ])
        out.delegateBalances = { mon: balMon.toString(), usdc: (balToken as bigint).toString(), wmon: (balWmon as bigint).toString() }
      }
    } catch (e: any) {
      out.delegateBalancesError = String(e?.message || e)
    }
    // Also expose if Envio balances are used in feature computation (for UI LED)
    try {
      if (delegator) {
        const feat = await computeCoreFeaturesAsync(delegator)
        out.usedEnvioBalances = !!(feat as any).usedEnvioBalances
        out.usedEnvioPrices = !!(feat as any).usedEnvioPrices
      }
    } catch {}
    if (delegator) {
      out.delegator = delegator
      try {
        const [balMon, balToken, balWmon] = await Promise.all([
          withRetry(() => publicClient.getBalance({ address: delegator })),
          withRetry(() => readErc20Balance(USDC as Address, delegator as Address)),
          withRetry(() => readErc20Balance(WMON as Address, delegator as Address)),
        ])
        out.delegatorBalances = { mon: balMon.toString(), usdc: (balToken as bigint).toString(), wmon: (balWmon as bigint).toString() }
      } catch (e: any) {
        out.delegatorBalancesError = String(e?.message || e)
      }
    }
    // Paymaster-independent router quote (if pool exists)
    try {
      const amounts = await withRetry(() => publicClient.readContract({
        address: UNISWAP_V2_ROUTER02,
        authorizationList: [] as any,
        abi: UNISWAP_V2_ROUTER_MIN_ABI as any,
        functionName: 'getAmountsOut',
        args: [amount, [USDC as Address, WMON as Address]],
      }) as Promise<bigint[]>)
      out.quote = { in: amount.toString(), out: (amounts?.[1] as bigint | undefined)?.toString() }
    } catch (e: any) {
      out.quoteError = String(e?.message || e)
    }
  return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'diag failed' })
  }
})

// List known tokens (symbol, address, decimals, isStable)
app.get('/api/tokens', (_req, res) => {
  try {
    return res.json({ ok: true, tokens: TOKENS })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'tokens_failed' })
  }
})

// Get balances for a given address across native MON and all registered tokens
// GET /api/balances?address=0x...
app.get('/api/balances', async (req, res) => {
  try {
    const address = String(req.query.address || '').toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(address)) return res.status(400).json({ ok: false, error: 'invalid_address' })
    const out: any = { ok: true, address }
    // Native MON
    let mon = '0'
    try { mon = (await publicClient.getBalance({ address: address as Address })).toString() } catch {}
    out.MON = mon
    // ERC20 balances for each token in registry
    const entries = Object.entries(TOKENS)
    const balances: Record<string, string> = {}
    for (const [sym, meta] of entries) {
      try {
        const bal = await readErc20Balance(meta.address as Address, address as Address)
        balances[sym] = bal.toString()
      } catch {
        balances[sym] = '0'
      }
    }
    out.tokens = balances
    return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'balances_failed' })
  }
})

// Manual DCA: swap native MON -> selected token(s) directly using UniswapV2 router
// Body: { delegatorSA, targets: string[] (symbols), amountMon?: string (wei), slippageBps?: number }
// Flow: split native MON equally across targets and perform swapExactETHForTokens for each, with fallback paths;
// Only when target is WMON do we wrap (deposit) instead of swapping.
app.post('/api/manual/dca', async (req, res) => {
  try {
    let { delegatorSA, targets, amountMon, slippageBps } = req.body || {}
    if (typeof delegatorSA === 'string') delegatorSA = delegatorSA.toLowerCase()
    if (!delegatorSA || !/^0x[0-9a-f]{40}$/.test(delegatorSA)) return res.status(400).json({ ok: false, error: 'invalid_delegator' })
    if (!Array.isArray(targets) || targets.length === 0) return res.status(400).json({ ok: false, error: 'targets_required' })
    const symbols: string[] = Array.from(new Set(targets.map((t: any) => String(t).toUpperCase()).filter(Boolean)))
    // Resolve target addresses (filter out USDC as target since we're swapping from MON; allow WMON)
    const resolved = symbols.map((s) => ({ sym: s, meta: getToken(s) }))
    const bad = resolved.filter((r) => !r.meta)
    if (bad.length) return res.status(400).json({ ok: false, error: 'unknown_tokens', symbols: bad.map((b) => b.sym) })
    const dests = resolved.map((r) => r.meta!.address as Address)
    const pk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}`
    if (!pk) return res.status(500).json({ ok: false, error: 'missing_delegate_key' })
    const eoa = privateKeyToAccount(pk)
    const env = getDeleGatorEnvironment(monadTestnet.id)
    const sa = await toMetaMaskSmartAccount({
      client: asToolkitClient(),
      implementation: Implementation.Hybrid,
      deployParams: [eoa.address, [], [], []],
      deploySalt: '0x',
      signer: { account: eoa },
      environment: env as any,
    })
    const { encodeFunctionData } = await import('viem')
    // Determine amount to use: default = full MON balance
    let monBal: bigint = 0n
    try { monBal = await publicClient.getBalance({ address: delegatorSA as Address }) } catch {}
    let toUse = amountMon != null ? BigInt(String(amountMon)) : monBal
    if (toUse <= 0n) return res.status(400).json({ ok: false, error: 'no_mon_to_swap' })
    // Build execution sequence (scope-aware)
    const execs: { target: Address; value: bigint; callData: `0x${string}` }[] = []
    // Determine if delegation allows native value transfers; if not, we'll first wrap then route via tokens
    let hasNative = false
    try {
      const file = join(process.cwd(), 'data', 'delegations', `${delegatorSA}.json`)
      if (existsSync(file)) {
        const json = JSON.parse(readFileSync(file, 'utf8'))
        const caveats: any[] = json?.signedDelegation?.delegation?.caveats || []
        hasNative = detectNativeValueScope(caveats).hasNativeScope
      }
    } catch {}
    // Split amount equally and swap/deposit for each target
    const n = dests.length
    const part = toUse / BigInt(n)
    const slip = BigInt(Number.isFinite(Number(slippageBps)) ? Number(slippageBps) : 100)
    if (hasNative) {
      for (const dest of dests) {
        // If destination is WMON: perform a native deposit (wrap) of the split value
        if (String(dest).toLowerCase() === String(WMON).toLowerCase()) {
          const depositData = encodeFunctionData({
            abi: [ { name: 'deposit', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] } ] as any,
            functionName: 'deposit',
            args: [],
          }) as `0x${string}`
          execs.push({ target: WMON as Address, value: part, callData: depositData })
          continue
        }
        // Else: quote best route from MON via WMON hub
        const candidates: Address[][] = []
        const isUsdc = String(dest).toLowerCase() === String(USDC).toLowerCase()
        if (isUsdc) {
          candidates.push([WMON as Address, USDC as Address])
        } else {
          candidates.push([WMON as Address, dest])
          candidates.push([WMON as Address, USDC as Address, dest])
        }
        let chosen: Address[] | null = null
        let bestOut: bigint = 0n
        for (const path of candidates) {
          try {
            const out = await publicClient.readContract({
              address: UNISWAP_V2_ROUTER02 as Address,
              abi: UNISWAP_V2_ROUTER_MIN_ABI as any,
              functionName: 'getAmountsOut',
              authorizationList: [] as any,
              args: [part, path],
            }) as bigint[]
            if (Array.isArray(out) && out.length >= 2) {
              const last = out[out.length - 1]
              if (last > bestOut) { bestOut = last; chosen = path }
            }
          } catch {}
        }
        const path = chosen || candidates[0]
        let minOut: bigint = 0n
        if (bestOut > 0n) {
          minOut = bestOut - (bestOut * slip / 10_000n)
          if (minOut < 0n) minOut = 0n
        }
        // swapExactETHForTokens(amountOutMin, path, to, deadline) with msg.value=part
        const swapData = encodeFunctionData({
          abi: [ { name: 'swapExactETHForTokens', type: 'function', stateMutability: 'payable', inputs: [ { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' } ], outputs: [ { name: 'amounts', type: 'uint256[]' } ] } ] as any,
          functionName: 'swapExactETHForTokens',
          args: [minOut, path, delegatorSA as Address, BigInt(Math.floor(Date.now()/1000) + 1200)],
        }) as `0x${string}`
        execs.push({ target: UNISWAP_V2_ROUTER02 as Address, value: part, callData: swapData })
      }
    } else {
      // Fallback: no native scope → wrap once then token swaps (approve+swapExactTokensForTokens)
      // 1) Wrap total MON to WMON
      const depositData = encodeFunctionData({
        abi: [ { name: 'deposit', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] } ] as any,
        functionName: 'deposit',
        args: [],
      }) as `0x${string}`
      execs.push({ target: WMON as Address, value: toUse, callData: depositData })
      // 2) Approve router for total WMON if needed
      try {
        const allowance = await publicClient.readContract({
          address: WMON as Address,
          abi: MIN_ERC20_ABI as any,
          functionName: 'allowance',
          authorizationList: [] as any,
          args: [delegatorSA as Address, UNISWAP_V2_ROUTER02 as Address],
        }) as bigint
        if (allowance < toUse) {
          const approveData = encodeFunctionData({
            abi: [ { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [ { name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' } ], outputs: [ { name: '', type: 'bool' } ] } ] as any,
            functionName: 'approve',
            args: [UNISWAP_V2_ROUTER02 as Address, toUse],
          }) as `0x${string}`
          execs.push({ target: WMON as Address, value: 0n, callData: approveData })
        }
      } catch {}
      // 3) Perform per-target token swaps from WMON
      for (const dest of dests) {
        if (String(dest).toLowerCase() === String(WMON).toLowerCase()) {
          // Already wrapped; skip
          continue
        }
        const candidates: Address[][] = []
        const isUsdc = String(dest).toLowerCase() === String(USDC).toLowerCase()
        if (isUsdc) {
          candidates.push([WMON as Address, USDC as Address])
        } else {
          candidates.push([WMON as Address, dest])
          candidates.push([WMON as Address, USDC as Address, dest])
        }
        let chosen: Address[] | null = null
        let bestOut: bigint = 0n
        for (const path of candidates) {
          try {
            const out = await publicClient.readContract({
              address: UNISWAP_V2_ROUTER02 as Address,
              abi: UNISWAP_V2_ROUTER_MIN_ABI as any,
              functionName: 'getAmountsOut',
              authorizationList: [] as any,
              args: [part, path],
            }) as bigint[]
            if (Array.isArray(out) && out.length >= 2) {
              const last = out[out.length - 1]
              if (last > bestOut) { bestOut = last; chosen = path }
            }
          } catch {}
        }
        const path = chosen || candidates[0]
        let minOut: bigint = 0n
        if (bestOut > 0n) {
          minOut = bestOut - (bestOut * slip / 10_000n)
          if (minOut < 0n) minOut = 0n
        }
        const swapData = encodeFunctionData({
          abi: [ { name: 'swapExactTokensForTokens', type: 'function', stateMutability: 'nonpayable', inputs: [ { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' } ], outputs: [ { name: 'amounts', type: 'uint256[]' } ] } ] as any,
          functionName: 'swapExactTokensForTokens',
          args: [part, minOut, path, delegatorSA as Address, BigInt(Math.floor(Date.now()/1000) + 1200)],
        }) as `0x${string}`
        execs.push({ target: UNISWAP_V2_ROUTER02 as Address, value: 0n, callData: swapData })
      }
    }
    // Encode DelegationManager call
    const file = join(process.cwd(), 'data', 'delegations', `${delegatorSA}.json`)
    if (!existsSync(file)) return res.status(404).json({ ok: false, error: 'delegation_missing' })
    const json = JSON.parse(readFileSync(file, 'utf8'))
    const signed = json.signedDelegation
    const flat = {
      delegate: signed.delegation.delegate,
      delegator: signed.delegation.delegator,
      authority: signed.delegation.authority,
      caveats: (signed.delegation.caveats || []).map((c: any) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args })),
      salt: signed.delegation.salt,
      signature: signed.signature,
    }
    const [ctx] = encodePermissionContextsFromDelegations([[flat as any]])
    const { calldatas, modes } = encodeExecutionCalldatasWithModes(execs.map((e) => [e]))
    const permissionContexts = execs.map(() => ctx)
    const DM_REDEEM_ABI = [ { type: 'function', name: 'redeemDelegations', stateMutability: 'nonpayable', inputs: [ { name: '_permissionContexts', type: 'bytes[]' }, { name: '_modes', type: 'bytes32[]' }, { name: '_executionCallDatas', type: 'bytes[]' } ], outputs: [] } ] as const
    const data = viemEncodeFunctionData({ abi: DM_REDEEM_ABI as any, functionName: 'redeemDelegations', args: [permissionContexts as any, modes as any, calldatas as any] }) as `0x${string}`
    // Send user operation (paymaster optional)
    let maxFeePerGas: bigint = 80n * 10n ** 9n
    let maxPriorityFeePerGas: bigint = maxFeePerGas / 2n
    try { const gp = await publicClient.getGasPrice(); if (gp > maxFeePerGas) { maxFeePerGas = gp; maxPriorityFeePerGas = gp/2n || 1n } } catch {}
    const uoHash = await sendUserOpWithOptionalPaymaster({ account: sa, calls: [{ to: env.DelegationManager as Address, data }], maxFeePerGas, maxPriorityFeePerGas })
    return res.json({ ok: true, userOperationHash: uoHash, steps: execs.length, targets: symbols })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'manual_dca_failed' })
  }
})

// Lightweight Envio health: verifies balances and price-series availability using configured ENVIO_GRAPHQL_URL
// GET /api/envio/health?owner=0x...&minutes=60
app.get('/api/envio/health', async (req, res) => {
  try {
    const owner = String(req.query.owner || '').toLowerCase()
    const minutes = Math.max(1, Math.min(24*60, Number(req.query.minutes || 60)))
    const url = process.env.ENVIO_GRAPHQL_URL || ''
    if (!url) return res.status(400).json({ ok: false, error: 'ENVIO_GRAPHQL_URL not set' })
    const { USDC, WMON } = await import('./constants')
    let balances: any = null
    let balancesSource: string | null = null
    try {
      const { fetchAccountBalancesEnvio } = await import('./metrics/envioAccount')
      const b = await fetchAccountBalancesEnvio(owner, { usdc: USDC, wmon: WMON })
      if (b) { balances = b; balancesSource = 'TokenBalances|ERC20Balance' }
    } catch (e: any) {
      // swallow; return null balances
    }
    let pricesPoints = 0
    let pricesFrom: number | null = null
    let pricesTo: number | null = null
    let pricesSource: string | null = null
    try {
      const { fetchPriceSeriesEnvio } = await import('./metrics/envioPrices')
      const ps = await fetchPriceSeriesEnvio({ baseToken: WMON, quoteToken: USDC, windowMinutes: minutes, maxPoints: 400 })
      if (ps && ps.length) {
        pricesPoints = ps.length
        pricesFrom = ps[0]?.ts ?? null
        pricesTo = ps[ps.length - 1]?.ts ?? null
        pricesSource = 'Swaps|V2Swap'
      }
    } catch (e: any) {
      // swallow
    }
    return res.json({ ok: true, env: { urlSet: !!url }, balances: balances ? { source: balancesSource, usdc: balances.usdc, wmon: balances.wmon } : null, prices: { source: pricesSource, points: pricesPoints, from: pricesFrom, to: pricesTo } })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'envio_health_failed' })
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
      wmonBal = (await readErc20Balance(WMON as Address, delegatorSA as Address)).toString()
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
        client: asToolkitClient(),
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
  appendAudit({ ts: Date.now(), action: 'execute', delegator: delegatorSA, delegate: d.delegate, role: 'value', structHash: h.structHash, digest: h.digest, domainSeparator: h.domainSeparator, caveatsRoot: h.caveatsHash, salt: d.salt, warnings: [], userOperationHash: uoHash, runId: newRunId() })
      } catch {}
      return res.json({ ok: true, userOperationHash: uoHash, transferred: wad.toString(), mode: 'native-scope', detected: nativeDetect })
    }

    // Fallback historique (WMON withdraw + transfert) si pas de caveat natif
    // Lire balance WMON pour withdraw
    let wbal = 0n
    try {
      wbal = await readErc20Balance(WMON as Address, delegatorSA as Address)
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
      client: asToolkitClient(),
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
  const runId = newRunId()
  appendAudit({ ts: Date.now(), action: 'execute', delegator: delegatorSA, delegate: coreD.delegate, role: 'core+value', structHash: hCore.structHash, digest: hCore.digest, domainSeparator: hCore.domainSeparator, caveatsRoot: hCore.caveatsHash, salt: coreD.salt, warnings: [], userOperationHash: uoHash, runId })
  appendAudit({ ts: Date.now(), action: 'execute', delegator: delegatorSA, delegate: valD.delegate, role: 'core+value', structHash: hVal.structHash, digest: hVal.digest, domainSeparator: hVal.domainSeparator, caveatsRoot: hVal.caveatsHash, salt: valD.salt, warnings: [], userOperationHash: uoHash, runId })
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
  const { delegatorSA, intervalSec, durationSec, immediate, expiresAtMs, unwrapToMon, jobType } = req.body || {}
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
      jobType: jobType === 'dca_ai' || jobType === 'dca_schedule' ? jobType : 'dca_schedule',
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
      client: asToolkitClient(),
      implementation: Implementation.Hybrid,
      deployParams: [eoa.address, [], [], []],
      deploySalt: (keccak256(`0x${(delegatorSA as string).slice(2).padStart(64,'0')}`) as `0x${string}`),
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
        bal = await readErc20Balance(WMON as Address, delegatorSA as Address)
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
      client: asToolkitClient(),
      implementation: Implementation.Hybrid,
      deployParams: [eoa.address, [], [], []],
      deploySalt: '0x',
      signer: { account: eoa },
      environment: env as any,
    })
    // Read WMON balance of delegator SA
    let wbal = 0n
    try {
      wbal = await readErc20Balance(WMON as Address, delegatorSA as Address)
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
      client: asToolkitClient(),
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
      client: asToolkitClient(),
      implementation: Implementation.Hybrid,
      deployParams: [eoa.address, [], [], []],
      deploySalt: (keccak256(`0x${(delegatorSA as string).slice(2).padStart(64,'0')}`) as `0x${string}`),
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
          amt = await readErc20Balance(tokenAddr as Address, delegatorSA as Address)
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
      client: asToolkitClient(),
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
      ownerBal = await readErc20Balance(USDC as Address, ownerAddr)
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
      client: asToolkitClient(),
      implementation: Implementation.Hybrid,
      deployParams: [eoa.address, [], [], []],
      deploySalt: (keccak256(`0x${(delegatorSA as string).slice(2).padStart(64,'0')}`) as `0x${string}`),
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
      usdc = await readErc20Balance(USDC as Address, delegator as Address)
    } catch {}
    try {
      wmon = await readErc20Balance(WMON as Address, delegator as Address)
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
            authorizationList: [] as any,
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
        client: asToolkitClient(),
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
  console.log('[boot] endpoints ready: /api/topup /api/wrap /api/unwrap /api/delegations /api/diag /api/status /api/version /api/routes /api/paymaster/status /api/paymaster/test /api/delegations/audit/* /api/delegations/coverage /api/strategy/preview /api/strategy/execute')
    // Start userOperation resolver loop
    try { startUserOpResolver() } catch (e: any) { console.warn('[boot] failed to start userOp resolver', e?.message || e) }
  })
}
