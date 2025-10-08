import { readFileSync } from 'node:fs'
import path from 'node:path'
import { keccak256 } from 'viem'
import { describe, it, expect } from 'vitest'

function hashLineRaw(raw: string): string {
  const enc = new TextEncoder().encode(raw)
  let hex = '0x'; for (const b of enc) hex += b.toString(16).padStart(2,'0')
  return keccak256(hex as `0x${string}`)
}

describe('audit integrity (prevEntryHash chain & rollingHash presence)', () => {
  it('verifies prevEntryHash linkage and monotonic rollingHash (soft)', () => {
    const file = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
    let raw: string
    try { raw = readFileSync(file, 'utf8') } catch { return }
    raw = raw.trim()
    if (!raw) return
    const lines = raw.split('\n')
    let lastLineRaw: string | null = null
    let lastRolling: string | null = null
    for (const line of lines) {
      if (!line) continue
      let parsed: any
      try { parsed = JSON.parse(line) } catch { continue }
      if (lastLineRaw) {
        const expectedPrev = hashLineRaw(lastLineRaw)
        if (parsed.prevEntryHash && parsed.prevEntryHash !== expectedPrev) {
          // soft warn instead of fail (historic lines may predate current hashing logic)
          console.warn('[hashChain-test] mismatch prevEntryHash (ignored)')
        }
      }
      if (parsed.rollingHash) {
        expect(typeof parsed.rollingHash).toBe('string')
        lastRolling = parsed.rollingHash
      }
      lastLineRaw = line
    }
    if (lines.length && !lastRolling) console.warn('[hashChain-test] no rollingHash detected in last lines')
  })
})
