#!/usr/bin/env tsx
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { keccak256 } from 'viem'

function stringToHex(s: string): `0x${string}` {
  const enc = new TextEncoder().encode(s)
  let hex = '0x'
  for (const b of enc) hex += b.toString(16).padStart(2,'0')
  return hex as `0x${string}`
}
function concatHex(a: string, b: string): `0x${string}` {
  if (a === '0x') return b as `0x${string}`
  if (b === '0x') return a as `0x${string}`
  return (`0x${a.slice(2)}${b.slice(2)}`) as `0x${string}`
}

interface Line { actionId: string; prevEntryHash?: string; rollingHash?: string; action: string; ts: number; [k: string]: any }

const file = join(process.cwd(), 'data', 'delegations', 'audit.log')
if (!existsSync(file)) {
  console.error('[verify] audit.log missing at', file)
  process.exit(1)
}
const raw = readFileSync(file, 'utf8').trim()
if (!raw) {
  console.log('[verify] empty audit log (OK)')
  process.exit(0)
}
const args = process.argv.slice(2)
const RELAXED = args.includes('--relaxed')
const lines = raw.split('\n')

let ok = true
let aiCount = 0
let legacy = 0
let computedRolling: string | null = null
let prevLineHash: string | null = null
let firstChainedIndex: number | null = null

for (let i = 0; i < lines.length; i++) {
  const lineRaw = lines[i]
  if (!lineRaw) continue
  let obj: Line
  try { obj = JSON.parse(lineRaw) } catch { console.error('[verify] invalid json at line', i); ok = false; continue }
  if (obj.action === 'ai_decision') aiCount++
  const chained = typeof obj.prevEntryHash === 'string' && typeof obj.rollingHash === 'string'
  if (!chained) { legacy++; continue }
  if (firstChainedIndex === null) firstChainedIndex = i
  // Expected prevEntryHash = prev full line hash (hash over JSON string WITHOUT modification). We recompute prevLineHash from previous iteration.
  const expectedPrev = prevLineHash || '0x'
  if (obj.prevEntryHash !== expectedPrev && !RELAXED) {
    console.error('[verify] prevEntryHash mismatch line', i, 'expected', expectedPrev, 'got', obj.prevEntryHash)
    ok = false
  }
  // Compute lineHash: keccak(JSON string of object INCLUDING prevEntryHash but EXCLUDING rollingHash) replicating appendAudit interim.
  const interimClone = { ...obj }
  delete (interimClone as any).rollingHash
  const interimStr = JSON.stringify(interimClone)
  const lineHash = keccak256(stringToHex(interimStr))
  if (computedRolling === null) {
    // Genesis (either proper or mid-log start). Accept obj.rollingHash as lineHash OR (if mismatch) flag unless relaxed.
    const expectedRolling = lineHash
    if (obj.rollingHash !== expectedRolling && !RELAXED) {
      console.error('[verify] rollingHash mismatch (genesis) line', i)
      ok = false
    }
    computedRolling = expectedRolling
  } else {
    computedRolling = keccak256(concatHex(computedRolling, lineHash))
    if (obj.rollingHash !== computedRolling && !RELAXED) {
      console.error('[verify] rollingHash mismatch line', i)
      ok = false
    }
  }
  prevLineHash = lineHash
}

if (ok) {
  console.log('[verify] PASS lines=', lines.length, 'legacy=', legacy, 'ai_decisions=', aiCount, 'finalRollingHash=', computedRolling)
} else {
  console.error('[verify] FAIL (see errors above) legacy=', legacy, 'finalRollingHash=', computedRolling)
  process.exit(2)
}
