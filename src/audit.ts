import { writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type AuditAction = 'build' | 'submit' | 'execute' | 'verify' | 'userop_settled'

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
}

const DIR = join(process.cwd(), 'data', 'delegations')
const FILE = join(DIR, 'audit.log')
let _structHashIndex: Set<string> | null = null

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
  }
}

export function appendAudit(entry: Partial<DelegationAuditEntryV1>) {
  try {
    ensure()
    const full = buildAuditEntry(entry)
    appendFileSync(FILE, JSON.stringify(full) + '\n')
    if (_structHashIndex) _structHashIndex.add(full.structHash.toLowerCase())
  } catch (e) {
    console.warn('[audit] append failed', e)
  }
}

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
