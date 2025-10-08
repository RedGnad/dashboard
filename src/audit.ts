import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { keccak256 } from 'viem'

export type AuditAction = 'build' | 'submit' | 'execute' | 'verify' | 'userop_settled' | 'ai_decision' | 'revoke'

export interface DelegationAuditEntryV1 {
  schemaVersion: 1
  ts: number               // epoch ms (original emission time)
  emittedAt: number         // duplicate for explicitness / future transformations
  action: AuditAction
  actionId: string          // unique id (uuid v4)
  chainId: number
  delegator: string
  delegate: string
  role: string
  structHash: string
  digest: string
  domainSeparator: string
  caveatsRoot: string
  salt: string
  warnings: string[]
  signatureModel: string
  runId?: string            // present for execute / userop_settled
  userOperationHash?: string
  txHash?: string
  blockNumber?: string
  recovered?: string | null
  verifyError?: string | null
  // --- Integrity chain fields (appended Phase7) ---
  prevEntryHash?: string    // keccak256(JSON string of previous full line w/ chain fields) or '0x' for first
  rollingHash?: string      // if first line: lineHash. else keccak256(prevRollingHash || lineHash) (see implementation)
  // --- AI / Strategy enrichment (optional) ---
  aiRationaleHash?: string
  aiRiskScore?: number
  aiConfidence?: number
  strategyEngineVersion?: string
  aiActionType?: string
  // Feature hashing (strategy context fingerprint)
  featureHash?: string
  featureSchemaVersion?: number
  // Link an execution back to its originating ai_decision (rollingHash of the decision line)
  decisionRollingHash?: string
  // Explicit guardrail reason when an execution is blocked (instead of inferring from warnings)
  guardrailReason?: string
  // All guardrail reasons (primary + warnings) for observability
  guardrailReasonsAll?: string[]
  // Deterministic model provenance
  modelHash?: string
  inferenceProvider?: string
  // Canonical serialized features (pre-hash) and pared-down inference subset for replay
  featuresCanonical?: string
  inferenceFeatures?: Record<string, any>
  featureHashV2?: string
  rawScore?: number
  logitZ?: number
  mappingVersion?: string
  weightsUsedHash?: string
}

const DIR = join(process.cwd(), 'data', 'delegations')
const FILE = join(DIR, 'audit.log')
const LOCK_FILE = join(DIR, 'audit.lock')
const LOCK_BUFFER = join(DIR, 'audit.lock.buffer')
const SNAP_FILE = join(DIR, 'finalRollingHash.json')
let _structHashIndex: Set<string> | null = null
// Cache of last chain state to avoid re-reading entire file on every append
let _lastLineRaw: string | null = null
let _lastRollingHash: string | null = null
let _lastLineHash: string | null = null

function ensure() { mkdirSync(DIR, { recursive: true }); if (!existsSync(FILE)) writeFileSync(FILE, '') }

export function buildAuditEntry(base: Partial<DelegationAuditEntryV1>): DelegationAuditEntryV1 {
  const now = Date.now()
  return {
    schemaVersion: 1,
    ts: base.ts ?? now,
    emittedAt: now,
    action: (base.action ?? 'build') as AuditAction,
    actionId: base.actionId || randomUUID(),
    // Resolve chainId safely (avoid mixing ?? and || without parentheses)
    chainId: (() => {
      if (typeof base.chainId === 'number') return base.chainId
      const envVal = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : undefined
      if (typeof envVal === 'number' && Number.isFinite(envVal)) return envVal
      return 0
    })(),
    delegator: (base.delegator || '0x').toLowerCase(),
    delegate: (base.delegate || '0x').toLowerCase(),
    role: base.role || 'core',
    structHash: base.structHash || '0x',
    digest: base.digest || '0x',
    domainSeparator: base.domainSeparator || '0x',
    caveatsRoot: base.caveatsRoot || '0x',
    salt: base.salt || '0x',
    warnings: Array.isArray(base.warnings) ? base.warnings : [],
    signatureModel: base.signatureModel || 'UNKNOWN',
    runId: base.runId,
    userOperationHash: base.userOperationHash,
    txHash: base.txHash,
    blockNumber: base.blockNumber,
    recovered: base.recovered ?? null,
    verifyError: base.verifyError ?? null,
    // Chain fields filled later in appendAudit
    prevEntryHash: base.prevEntryHash,
    rollingHash: base.rollingHash,
    // AI optional fields (pass-through if provided)
    aiRationaleHash: base.aiRationaleHash,
    aiRiskScore: base.aiRiskScore,
    aiConfidence: base.aiConfidence,
    strategyEngineVersion: base.strategyEngineVersion,
    aiActionType: base.aiActionType,
    featureHash: base.featureHash,
    featureSchemaVersion: base.featureSchemaVersion,
    decisionRollingHash: base.decisionRollingHash,
    guardrailReason: base.guardrailReason,
  guardrailReasonsAll: Array.isArray((base as any).guardrailReasonsAll) ? (base as any).guardrailReasonsAll : undefined,
    modelHash: base.modelHash,
    inferenceProvider: base.inferenceProvider,
    featuresCanonical: base.featuresCanonical,
    inferenceFeatures: base.inferenceFeatures,
    featureHashV2: base.featureHashV2,
    rawScore: base.rawScore,
    logitZ: base.logitZ,
    mappingVersion: base.mappingVersion,
    weightsUsedHash: base.weightsUsedHash,
  }
}

export function appendAudit(entry: Partial<DelegationAuditEntryV1>) {
  try {
    ensure()
    // If migration lock active: buffer raw entry (without chain fields) and return early.
    if (existsSync(LOCK_FILE)) {
      const buf = { ...entry, _locked: true, bufferedAt: Date.now() }
      appendFileSync(LOCK_BUFFER, JSON.stringify(buf) + '\n')
      console.log('[audit-lock] buffered entry while lock active', { action: entry.action })
      return
    }
    // Lazy-load last chain state if unknown
    if (_lastLineRaw === null) {
      try {
        if (existsSync(FILE)) {
          const raw = readFileSync(FILE, 'utf8')
          const lines = raw.trim() ? raw.split('\n') : []
            // find last non-empty
          for (let i = lines.length - 1; i >= 0; i--) {
            const l = lines[i]
            if (!l) continue
            _lastLineRaw = l
            try {
              const j = JSON.parse(l)
              if (j.rollingHash && typeof j.rollingHash === 'string') {
                _lastRollingHash = j.rollingHash
              }
              // Canonical prevEntryHash hashing rule: hash of previous line WITHOUT its rollingHash field.
              const clone: any = { ...j }
              delete clone.rollingHash
              const cloneStr = JSON.stringify(clone)
              _lastLineHash = keccak256(stringToHexSafe(cloneStr))
            } catch {
              // Fallback to raw line hash if JSON parse fails (should not happen)
              _lastLineHash = keccak256(stringToHexSafe(l))
            }
            break
          }
        }
      } catch {}
    }

    const base = buildAuditEntry(entry)
    // Defensive: if caller provided prevEntryHash/rollingHash (legacy behavior), drop them.
    if (base.prevEntryHash || base.rollingHash) {
      if (process.env.AUDIT_STRICT_CHAIN_SANITY === '1') {
        console.warn('[audit] dropping caller-supplied chain fields (enforced canonical)')
      }
      delete (base as any).prevEntryHash
      delete (base as any).rollingHash
    }

    const prevEntryHash = _lastLineRaw ? (_lastLineHash as string) : '0x'
    // If the user passed an outdated prevEntryHash (in the original entry) we already dropped it above.
    // Additional sanity: if process.env.AUDIT_REFUSE_STALE=1 and a stale hint was present, we can abort.
    if ((entry as any).prevEntryHash && (entry as any).prevEntryHash !== prevEntryHash) {
      const msg = `[audit] stale prevEntryHash supplied (${(entry as any).prevEntryHash} != ${prevEntryHash})`
      if (process.env.AUDIT_REFUSE_STALE === '1') {
        console.error(msg + ' -> REFUSED')
        return
      } else {
        console.warn(msg + ' -> REWRITTEN')
      }
    }
    // Build an interim object including prevEntryHash to hash current line content deterministically
    const interim = { ...base, prevEntryHash }
    const interimStr = JSON.stringify(interim)
    const lineHash = keccak256(stringToHexSafe(interimStr))
    const rollingHash = (!_lastRollingHash || _lastRollingHash === '0x') ? lineHash : keccak256(concatHex(_lastRollingHash, lineHash))
  // Preserve AI fields if present on base (interim already has them if provided in entry)
  const finalObj: any = { ...interim, rollingHash }
  if (base.aiRationaleHash !== undefined) finalObj.aiRationaleHash = base.aiRationaleHash
  if (base.aiRiskScore !== undefined) finalObj.aiRiskScore = base.aiRiskScore
  if (base.aiConfidence !== undefined) finalObj.aiConfidence = base.aiConfidence
  if (base.strategyEngineVersion !== undefined) finalObj.strategyEngineVersion = base.strategyEngineVersion
  if (base.aiActionType !== undefined) finalObj.aiActionType = base.aiActionType
  if (base.featureHash !== undefined) finalObj.featureHash = base.featureHash
  if (base.featureSchemaVersion !== undefined) finalObj.featureSchemaVersion = base.featureSchemaVersion
  if (base.decisionRollingHash !== undefined) finalObj.decisionRollingHash = base.decisionRollingHash
  if (base.guardrailReason !== undefined) finalObj.guardrailReason = base.guardrailReason
  if (base.modelHash !== undefined) finalObj.modelHash = base.modelHash
  if (base.inferenceProvider !== undefined) finalObj.inferenceProvider = base.inferenceProvider
  if (base.featuresCanonical !== undefined) finalObj.featuresCanonical = base.featuresCanonical
  if (base.inferenceFeatures !== undefined) finalObj.inferenceFeatures = base.inferenceFeatures
  if (base.featureHashV2 !== undefined) finalObj.featureHashV2 = base.featureHashV2
  if (base.rawScore !== undefined) finalObj.rawScore = base.rawScore
  if (base.logitZ !== undefined) finalObj.logitZ = base.logitZ
  if (base.mappingVersion !== undefined) finalObj.mappingVersion = base.mappingVersion
  if (base.weightsUsedHash !== undefined) finalObj.weightsUsedHash = base.weightsUsedHash
    try {
      // Debug one-line log (avoid huge noise): show action + presence of AI fields
      const dbg = {
        action: finalObj.action,
        aiRationaleHash: !!finalObj.aiRationaleHash,
        aiRiskScore: finalObj.aiRiskScore,
        aiConfidence: finalObj.aiConfidence,
        aiActionType: finalObj.aiActionType,
        strategyEngineVersion: finalObj.strategyEngineVersion,
      }
      console.log('[audit-append]', dbg)
    } catch {}
  appendFileSync(FILE, JSON.stringify(finalObj) + '\n')
    // Update caches
    _lastLineRaw = JSON.stringify(finalObj)
    _lastRollingHash = rollingHash
    // For future prevEntryHash: we need the canonical hash of this just-appended line WITHOUT its rollingHash
    try {
      const clone: any = { ...finalObj }
      delete clone.rollingHash
      _lastLineHash = keccak256(stringToHexSafe(JSON.stringify(clone)))
    } catch {
      _lastLineHash = lineHash // fallback
    }
    // Optional vérification immédiate (léger) après append pour détecter corruption précoce.
    // Active si AUDIT_VERIFY_ON_APPEND=1 (ou 'true'). On ne relit que les deux dernières lignes pour valider le chainage.
    try {
      if (/^(1|true)$/i.test(String(process.env.AUDIT_VERIFY_ON_APPEND || ''))) {
        const rawFile = readFileSync(FILE,'utf8').trim()
        const parts = rawFile ? rawFile.split('\n') : []
        if (parts.length >= 1) {
          // Vérifier dernière ligne versus cache (cohérence interne)
          const lastRaw = parts[parts.length - 1]
          const obj = JSON.parse(lastRaw)
          // Recompute canonical line hash: remove rollingHash
            const interimClone: any = { ...obj }
            delete interimClone.rollingHash
            const recomputedLineHash = keccak256(stringToHexSafe(JSON.stringify(interimClone)))
            // prevEntryHash doit être soit '0x' (si c'était la première), soit lineHash de l'avant-dernière
            if (parts.length > 1) {
              const prevRaw = parts[parts.length - 2]
              const prevObj = JSON.parse(prevRaw)
              const prevInterim = { ...prevObj }; delete (prevInterim as any).rollingHash
              const prevLineHash = keccak256(stringToHexSafe(JSON.stringify(prevInterim)))
              if (obj.prevEntryHash !== prevLineHash) {
                console.error('[audit-guard] prevEntryHash mismatch post-append', { expected: prevLineHash, got: obj.prevEntryHash })
              }
              // Validate rolling hash chaining
              const expectedRolling = keccak256(concatHex(prevObj.rollingHash, recomputedLineHash))
              if (obj.rollingHash !== expectedRolling) {
                console.error('[audit-guard] rollingHash mismatch post-append', { expected: expectedRolling, got: obj.rollingHash })
              }
            } else {
              // Single line genesis: rollingHash doit égaler lineHash
              if (obj.rollingHash !== recomputedLineHash) {
                console.error('[audit-guard] genesis rollingHash mismatch', { expected: recomputedLineHash, got: obj.rollingHash })
              }
            }
        }
      }
    } catch (gErr) {
      console.warn('[audit-guard] verification error', gErr)
    }
    // Write / update rolling hash snapshot for external monitors
    try {
      let lines = 0
      // Fast path: read existing snapshot lines count and increment
      if (existsSync(SNAP_FILE)) {
        try {
          const snap = JSON.parse(readFileSync(SNAP_FILE,'utf8'))
          if (typeof snap.lines === 'number') lines = snap.lines + 1
        } catch {}
      } else {
        // Fallback approximate: count lines in file (could be expensive only first time)
        try {
          const rawAll = readFileSync(FILE,'utf8')
          lines = rawAll.trim() ? rawAll.trim().split('\n').length : 1
        } catch { lines = 1 }
      }
      const snapshot = { rollingHash, ts: Date.now(), lines }
      writeFileSync(SNAP_FILE, JSON.stringify(snapshot, null, 2))
    } catch {}
    if (_structHashIndex) _structHashIndex.add(base.structHash.toLowerCase())
  } catch (e) {
    console.warn('[audit] append failed', e)
  }
}

// Generate a runId (UUID v4) to correlate multiple audit lines for a single execution batch
export function newRunId(): string { return 'run_' + randomUUID() }

export function hasStructHash(h: string): boolean {
  if (!_structHashIndex) {
    _structHashIndex = new Set<string>()
    try {
      if (existsSync(FILE)) {
        const raw = readFileSync(FILE, 'utf8')
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue
          try {
            const j = JSON.parse(line)
            if (j.structHash) _structHashIndex.add(String(j.structHash).toLowerCase())
          } catch {}
        }
      }
    } catch {}
  }
  return _structHashIndex.has(h.toLowerCase())
}

export function readAuditTail(n = 200) {
  try {
    if (!existsSync(FILE)) return []
    const raw = readFileSync(FILE, 'utf8').trim()
    if (!raw) return []
    const lines = raw.split('\n')
    const tail = lines.slice(-n)
    return tail.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch (e) {
    return []
  }
}

export function auditFileMeta() {
  try {
    ensure()
    const stat = statSync(FILE)
    const raw = readFileSync(FILE, 'utf8')
    const lines = raw.trim() ? raw.split('\n').length : 0
    return { sizeBytes: stat.size, lines }
  } catch {
    return { sizeBytes: 0, lines: 0 }
  }
}

// Administrative helpers for lock lifecycle
export function createAuditLock(note?: string) {
  ensure();
  if (!existsSync(LOCK_FILE)) writeFileSync(LOCK_FILE, JSON.stringify({ ts: Date.now(), note: note || '' }))
  return { locked: true }
}

export function releaseAuditLock(flush = true) {
  ensure();
  if (!existsSync(LOCK_FILE)) return { locked: false, flushed: 0 }
  // Remove lock first so buffered entries can be re-appended deterministically
  try { unlinkSync(LOCK_FILE) } catch {}
  let flushed = 0
  if (flush && existsSync(LOCK_BUFFER)) {
    try {
      const raw = readFileSync(LOCK_BUFFER,'utf8').trim()
      if (raw) {
        for (const line of raw.split('\n')) {
          if (!line) continue
            try {
              const obj = JSON.parse(line)
              delete (obj as any)._locked
              delete (obj as any).bufferedAt
              // Re-append (will compute fresh chain fields)
              appendAudit(obj)
              flushed++
            } catch {}
        }
      }
    } catch {}
    try { unlinkSync(LOCK_BUFFER) } catch {}
  }
  return { locked: false, flushed }
}

export function readRollingSnapshot() {
  try {
    if (!existsSync(SNAP_FILE)) return null
    return JSON.parse(readFileSync(SNAP_FILE,'utf8'))
  } catch { return null }
}

// Stream-style reader: cursor = 0-based line index. Returns up to limit entries and nextCursor.
export function readAuditStream(cursor = 0, limit = 200) {
  ensure()
  const raw = existsSync(FILE) ? readFileSync(FILE, 'utf8') : ''
  const linesArr = raw.trim() ? raw.split('\n') : []
  if (cursor < 0) cursor = 0
  if (cursor > linesArr.length) cursor = linesArr.length
  const slice = linesArr.slice(cursor, cursor + limit)
  const entries = slice.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const nextCursor = cursor + slice.length
  const eof = nextCursor >= linesArr.length
  return { entries, nextCursor, eof, total: linesArr.length }
}

export function auditStatus() {
  ensure()
  const meta = auditFileMeta()
  let last: any = null
  try {
    if (existsSync(FILE) && meta.lines > 0) {
      const raw = readFileSync(FILE, 'utf8')
      const arr = raw.trim() ? raw.split('\n') : []
      for (let i = arr.length - 1; i >= 0; i--) {
        const line = arr[i]
        if (!line) continue
        try { last = JSON.parse(line); break } catch {}
      }
    }
  } catch {}
  return {
    ok: true,
    schemaVersion: 1,
    lines: meta.lines,
    sizeBytes: meta.sizeBytes,
    lastTs: last?.ts || null,
    lastActionId: last?.actionId || null,
    finalRollingHash: last?.rollingHash || null,
  }
}

// ---- helpers ----
function stringToHexSafe(s: string): `0x${string}` {
  // Convert UTF-8 string to hex without introducing dependencies beyond viem (manual encode)
  const enc = new TextEncoder().encode(s)
  let hex = '0x'
  for (const b of enc) hex += b.toString(16).padStart(2, '0')
  return hex as `0x${string}`
}

function concatHex(a: string, b: string): `0x${string}` {
  if (a === '0x') return b as `0x${string}`
  if (b === '0x') return a as `0x${string}`
  return (`0x${a.slice(2)}${b.slice(2)}`) as `0x${string}`
}
