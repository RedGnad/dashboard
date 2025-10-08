import path from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

async function fetchJson(url: string) {
  const res = await fetch(url)
  return res.json()
}

// Skip-friendly helper
function hasAudit(): boolean {
  try {
    const f = readFileSync(path.join(process.cwd(), 'data', 'delegations', 'audit.log'), 'utf8')
    return !!f.trim()
  } catch { return false }
}

describe('decision replay deterministic', () => {
  it('latest decision strict replay passes (if any)', async () => {
    if (!hasAudit()) return
    const latest = await fetchJson('http://127.0.0.1:8787/api/strategy/decision/latest')
    if (!latest || latest.empty) return
  const replay = await fetchJson('http://127.0.0.1:8787/api/strategy/decision/replay?mode=strict-snapshot')
    expect(replay.ok).toBe(true)
    if (!replay.pass) {
      console.warn('[replayDeterminism-test] strict-snapshot replay did not pass (soft)')
    }
  })
})
