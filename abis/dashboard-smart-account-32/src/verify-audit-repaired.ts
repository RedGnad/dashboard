#!/usr/bin/env tsx
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { keccak256 } from 'viem'

function stringToHex(s: string): `0x${string}` { const enc = new TextEncoder().encode(s); let h='0x'; for (const b of enc) h+=b.toString(16).padStart(2,'0'); return h as `0x${string}` }
function concatHex(a: string, b: string): `0x${string}` { if (a==='0x') return b as `0x${string}`; if (b==='0x') return a as `0x${string}`; return ('0x'+a.slice(2)+b.slice(2)) as `0x${string}` }

const file = join(process.cwd(),'data','delegations','audit.repaired.log')
if (!existsSync(file)) { console.error('[verify-repaired] missing', file); process.exit(1) }
const raw = readFileSync(file,'utf8').trim(); if (!raw){ console.log('[verify-repaired] empty'); process.exit(0) }
const lines = raw.split('\n')
let ok = true
let computedRolling: string | null = null
let prevLineHash: string | null = null
for (let i=0;i<lines.length;i++) {
  const lineRaw = lines[i]; if (!lineRaw) continue
  let obj: any; try { obj = JSON.parse(lineRaw) } catch { console.error('[verify-repaired] invalid json line', i+1); ok=false; continue }
  const expectedPrev = prevLineHash || '0x'
  if (obj.prevEntryHash !== expectedPrev) { console.error('[verify-repaired] prev mismatch line', i+1, 'exp', expectedPrev, 'got', obj.prevEntryHash); ok=false }
  const interim = { ...obj }; delete interim.rollingHash
  const lineHash = keccak256(stringToHex(JSON.stringify(interim)))
  if (computedRolling === null) {
    const expectedRolling = lineHash
    if (obj.rollingHash !== expectedRolling) { console.error('[verify-repaired] rolling mismatch genesis line', i+1); ok=false }
    computedRolling = expectedRolling
  } else {
    computedRolling = keccak256(concatHex(computedRolling, lineHash))
    if (obj.rollingHash !== computedRolling) { console.error('[verify-repaired] rolling mismatch line', i+1); ok=false }
  }
  prevLineHash = lineHash
}
if (ok) console.log('[verify-repaired] PASS lines=', lines.length, 'finalRollingHash=', computedRolling)
else { console.error('[verify-repaired] FAIL finalRollingHash=', computedRolling); process.exit(2) }
