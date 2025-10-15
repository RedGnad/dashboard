import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type DiagEntry = {
  ts: number
  level?: 'info' | 'warn' | 'error'
  scope?: string
  message?: string
  details?: any
  error?: any
}

const DATA_DIR = join(process.cwd(), 'data')
const DIAG_FILE = join(DATA_DIR, 'diag.log')

function safeJson(v: any) {
  try { return JSON.stringify(v) } catch { return JSON.stringify(String(v)) }
}

export function appendDiag(e: DiagEntry) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const line = safeJson({ ...e, ts: e?.ts || Date.now() }) + '\n'
    appendFileSync(DIAG_FILE, line)
  } catch {}
}

export function readDiagTail(limit = 200, contains?: string): DiagEntry[] {
  try {
    if (!existsSync(DIAG_FILE)) return []
    const raw = readFileSync(DIAG_FILE, 'utf8')
    if (!raw) return []
    const lines = raw.trim().split('\n')
    const slice = lines.slice(-Math.max(1, Math.min(1000, limit)))
    const out: DiagEntry[] = []
    for (const l of slice) {
      try {
        const j = JSON.parse(l)
        out.push(j)
      } catch {}
    }
    if (contains) {
      const s = contains.toLowerCase()
      return out.filter((e) =>
        (e.message && String(e.message).toLowerCase().includes(s)) ||
        (e.scope && String(e.scope).toLowerCase().includes(s)) ||
        (e.details && safeJson(e.details).toLowerCase().includes(s)) ||
        (e.error && safeJson(e.error).toLowerCase().includes(s))
      )
    }
    return out
  } catch { return [] }
}
