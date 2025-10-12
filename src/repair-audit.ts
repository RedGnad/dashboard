#!/usr/bin/env tsx
/**
 * Repair audit chain by recalculating prevEntryHash + rollingHash from first detected divergence.
 * - Reads data/delegations/audit.log
 * - Detects earliest line where prevEntryHash != keccak256(previous full JSON line)
 * - Recomputes from that point: prevEntryHash, lineHash, rollingHash
 * - Writes repaired file to data/delegations/audit.repaired.log (does NOT overwrite original)
 * - Emits summary mapping oldRollingHash -> newRollingHash for modified lines
 *
 * Rolling hash logic assumption:
 *   lineHash = keccak256(JSON.stringify(entryWithoutPrevAndRolling?)?)
 *   BUT we don't have original lineHash field. We reconstruct prevEntryHash chain and recompute rollingHash as:
 *     newRollingHash = keccak256(previousRollingHash + keccak256(lineJSON))  (concatenated hex without 0x repeated) if previousRollingHash exists
 * If actual project rolling formula differs, adjust logic below accordingly.
 */
import fs from 'node:fs'
import path from 'node:path'
import { keccak256 } from 'viem'

function toHexUtf8(s:string){ const enc = new TextEncoder().encode(s); let h='0x'; for (const b of enc) h+=b.toString(16).padStart(2,'0'); return h as `0x${string}` }
function concatHex(a: string, b: string){ return (a.replace(/^0x/,'') + b.replace(/^0x/,'')) as `0x${string}` }

const auditPath = path.join(process.cwd(),'data','delegations','audit.log')
if (!fs.existsSync(auditPath)) { console.error('[repair] audit.log not found'); process.exit(1) }
const linesRaw = fs.readFileSync(auditPath,'utf8').trim().split('\n').filter(Boolean)
if (!linesRaw.length) { console.error('[repair] empty audit.log'); process.exit(1) }

// Parse lines
interface Entry { raw:string; obj:any; index:number }
const entries: Entry[] = []
for (let i=0;i<linesRaw.length;i++) {
  try { entries.push({ raw: linesRaw[i], obj: JSON.parse(linesRaw[i]), index: i }) } catch { console.error('[repair] invalid JSON line', i+1); process.exit(2) }
}

// Detect divergence using canonical logic used by verifier:
// prevEntryHash should equal keccak(JSON.stringify(previousEntryWithoutRollingHash))
let divergenceIndex = -1
for (let i=0;i<entries.length;i++) {
  if (i===0) continue
  const prev = entries[i-1]
  let prevObjClone = { ...prev.obj }
  delete (prevObjClone as any).rollingHash
  const prevCanonical = JSON.stringify(prevObjClone)
  const expectedPrevHash = keccak256(toHexUtf8(prevCanonical))
  const actualPrev = entries[i].obj.prevEntryHash
  if (actualPrev !== expectedPrevHash) { divergenceIndex = i; break }
}

if (divergenceIndex === -1) {
  console.log('[repair] No divergence detected; no output written.')
  process.exit(0)
}
console.log('[repair] divergence at line (1-based) =', divergenceIndex+1)

// Recompute from divergenceIndex
const repaired: string[] = []
// Keep originals up to divergenceIndex-1
for (let i=0;i<divergenceIndex;i++) repaired.push(entries[i].raw)

// Seed with last correct canonical line hash + rolling hash
let seedEntry = entries[divergenceIndex-1]
let seedClone = { ...seedEntry.obj }; delete (seedClone as any).rollingHash
let prevLineHash = keccak256(toHexUtf8(JSON.stringify(seedClone)))
let prevRolling = seedEntry.obj.rollingHash as string | undefined
const modifications: { line:number; oldRolling?:string; newRolling:string; oldPrev?:string; newPrev:string }[] = []

for (let i=divergenceIndex;i<entries.length;i++) {
  const original = entries[i]
  // Build new object with corrected prevEntryHash first (prevLineHash)
  const newPrev = prevLineHash
  const clone = { ...original.obj, prevEntryHash: newPrev }
  // Compute canonical line hash = keccak(JSON.stringify(clone without rollingHash))
  const interim = { ...clone }; delete (interim as any).rollingHash
  const interimJson = JSON.stringify(interim)
  const lineHash = keccak256(toHexUtf8(interimJson))
  // Rolling hash chaining: rolling = lineHash if first after seed else keccak(prevRolling || '' + lineHash)
  const newRolling = prevRolling ? keccak256(('0x'+concatHex(prevRolling, lineHash).replace(/^0x/,'')) as `0x${string}`) : lineHash
  const oldRolling = clone.rollingHash
  clone.rollingHash = newRolling
  repaired.push(JSON.stringify(clone))
  modifications.push({ line: i+1, oldRolling, newRolling, oldPrev: original.obj.prevEntryHash, newPrev })
  // Advance seeds
  prevLineHash = lineHash
  prevRolling = newRolling
}

const outPath = path.join(process.cwd(),'data','delegations','audit.repaired.log')
fs.writeFileSync(outPath, repaired.join('\n') + '\n')

console.log('[repair] wrote repaired log:', outPath)
console.log('[repair] modified lines:', modifications.length)
for (const m of modifications.slice(0, 10)) {
  console.log(`  line ${m.line}: prev ${m.oldPrev?.slice(0,10)}.. -> ${m.newPrev.slice(0,10)}.. ; rolling ${m.oldRolling?.slice(0,10)}.. -> ${m.newRolling.slice(0,10)}..`)
}
if (modifications.length > 10) console.log('  ...')
console.log('[repair] final rollingHash new tail =', prevRolling)
