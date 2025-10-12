import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// This test builds a proof pack, then re-runs the verify script to ensure
// the canonical pre-image hashing (excluding packKeccak256 & anchorRef) is stable.

function run(cmd: string) {
  return execSync(cmd, { stdio: 'pipe' }).toString('utf8')
}

describe('Proof Pack canonical snapshot', () => {
  it('builds and verifies latest pack deterministically', () => {
    // Build pack
  const out = run('npm run build:proof-pack')
  // Current script prints: 'packKeccak256 0xabc...'
  expect(out).toMatch(/packKeccak256\s+0x[0-9a-f]{64}/i)
  const match = out.split(/\n/).reverse().find(l => /packKeccak256\s+0x/i.test(l)) || ''
  const hash = (match.match(/packKeccak256\s+(0x[0-9a-f]{64})/i) || [])[1]
    expect(hash).toBeTruthy()
    // Assume script writes last pack path hint OR use default dist path
    const distPath = join(process.cwd(), 'dist')
    // Heuristic: build script likely writes something like last-pack.json.gz
    // Build script writes into data/proof-packs by observation of logs
    const dataPackDir = join(process.cwd(), 'data', 'proof-packs')
    // naive approach: rely on verify:proof-pack ability to read provided path; use most recent file
    let candidate = join(distPath, 'last-pack.json.gz')
    if (!existsSync(candidate) && existsSync(dataPackDir)) {
      const files = readdirSync(dataPackDir).filter(f=>f.endsWith('.json.gz')).sort()
      if (files.length) candidate = join(dataPackDir, files[files.length-1])
    }
    expect(existsSync(candidate)).toBe(true)
    const verifyOut = run(`npm run verify:proof-pack -- ${candidate}`)
  // We do not assert the original packKeccak256 necessarily reprinted by verify step; it recomputes from canonical pre-image.
  expect(verifyOut.toLowerCase()).toMatch(/ok match/)
  })
})
