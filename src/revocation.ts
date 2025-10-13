import fs from 'node:fs'
import path from 'node:path'
import { appendAudit } from './audit'

interface RevocationRecord {
  delegator: string
  revokedAt: number
  reason: string
  meta?: any
}

interface StateFile {
  revocations: RevocationRecord[]
  streaks: Record<string, { abnormalHyperIndex: number; lastUpdated: number }>
}

const DIR = path.join(process.cwd(), 'data')
const FILE = path.join(DIR, 'revocations.json')

function loadState(): StateFile {
  try {
    if (fs.existsSync(FILE)) {
      const js = JSON.parse(fs.readFileSync(FILE, 'utf8'))
      return { revocations: js.revocations || [], streaks: js.streaks || {} }
    }
  } catch {}
  return { revocations: [], streaks: {} }
}

function saveState(st: StateFile) {
  try { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }) } catch {}
  try { fs.writeFileSync(FILE, JSON.stringify(st, null, 2)) } catch {}
}

export function isRevoked(delegator: string): RevocationRecord | null {
  const st = loadState()
  return st.revocations.find(r => r.delegator === delegator.toLowerCase()) || null
}

export function recordGuardrailHit(delegator: string, code: string) {
  const st = loadState()
  const key = delegator.toLowerCase()
  if (!st.streaks[key]) st.streaks[key] = { abnormalHyperIndex: 0, lastUpdated: 0 }
  if (code === 'abnormal_hyperindex_activity') {
    st.streaks[key].abnormalHyperIndex += 1
  } else if (code === 'clear') {
    st.streaks[key].abnormalHyperIndex = 0
  }
  st.streaks[key].lastUpdated = Date.now()
  saveState(st)
}

export function getStreak(delegator: string): number {
  const st = loadState()
  return st.streaks[delegator.toLowerCase()]?.abnormalHyperIndex || 0
}

export function maybeAutoRevoke(delegator: string, opts?: { threshold?: number; reason?: string }): RevocationRecord | null {
  const t = opts?.threshold ?? Number(process.env.AUTO_REVOKE_ABNORMAL_STREAK || 2)
  const streak = getStreak(delegator)
  if (streak >= t) {
    return revokeDelegation(delegator, opts?.reason || 'auto_revoke_abnormal_hyperindex')
  }
  return null
}

export function revokeDelegation(delegator: string, reason: string, meta?: any): RevocationRecord {
  const st = loadState()
  const key = delegator.toLowerCase()
  if (st.revocations.find(r => r.delegator === key)) {
    // already revoked; idempotent
    return st.revocations.find(r => r.delegator === key) as RevocationRecord
  }
  const rec: RevocationRecord = { delegator: key, revokedAt: Date.now(), reason, meta }
  st.revocations.push(rec)
  saveState(st)
  appendAudit({
    action: 'revoke',
    ts: rec.revokedAt,
    delegator: key,
    delegate: '0x',
    role: 'system',
    aiRationaleHash: undefined,
    guardrailReason: reason,
    warnings: [],
    signatureModel: 'UNKNOWN',
  })
  return rec
}

export function listRevocations(): RevocationRecord[] { return loadState().revocations.slice() }
