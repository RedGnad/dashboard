#!/usr/bin/env tsx
/**
 * Migration d'intégrité complète de audit.log
 * - Recalcule prevEntryHash et rollingHash pour TOUTES les lignes (legacy incluses)
 * - Conserve toutes les autres propriétés inchangées
 * - Écrit un nouveau fichier temporaire puis swap atomique + backup .bak horodaté
 *
 * Formules:
 *  lineHash = keccak256(JSON.stringify(lineSansRolling))
 *  prevEntryHash = lineHash précédent (ou 0x pour première ligne)
 *  rollingHash = (première ? lineHash : keccak256(prevRollingHash || lineHash))
 *  NB: On inclut prevEntryHash dans l'objet AVANT de calculer lineHash (aligné avec appendAudit logique interim)
 */
import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { keccak256 } from 'viem'

function stringToHex(s: string): `0x${string}` {
  const enc = new TextEncoder().encode(s)
  let h = '0x'
  for (const b of enc) h += b.toString(16).padStart(2,'0')
  return h as `0x${string}`
}
function concatHex(a: string, b: string): `0x${string}` {
  if (a === '0x') return b as `0x${string}`
  if (b === '0x') return a as `0x${string}`
  return (`0x${a.slice(2)}${b.slice(2)}`) as `0x${string}`
}

const dir = join(process.cwd(), 'data', 'delegations')
const file = join(dir, 'audit.log')
if (!existsSync(file)) { console.error('[migrate] audit.log introuvable'); process.exit(1) }
const raw = readFileSync(file, 'utf8')
const lines = raw.trim() ? raw.split('\n') : []
if (!lines.length) { console.log('[migrate] fichier vide - rien à faire'); process.exit(0) }

const args = process.argv.slice(2)
const DRY = args.includes('--dry') || args.includes('--dry-run')
const outTemp = join(dir, 'audit.migrated.tmp')
const ts = new Date().toISOString().replace(/[:.]/g,'-')
const backup = join(dir, `audit.backup-${ts}.log`)

let prevLineHash: string = '0x'
let rolling: string = '0x'
let migratedCount = 0
let aiCount = 0
let firstLineHash: string | null = null

const outBuf: string[] = []
for (let i=0;i<lines.length;i++) {
  const rawLine = lines[i]
  if (!rawLine) continue
  let obj: any
  try { obj = JSON.parse(rawLine) } catch { console.error('[migrate] JSON invalide ligne', i); process.exit(2) }
  if (obj.action === 'ai_decision') aiCount++
  // Remplacer / injecter prevEntryHash
  obj.prevEntryHash = prevLineHash
  // Construire objet sans rollingHash avant hash
  const interim = { ...obj }
  delete (interim as any).rollingHash
  const interimStr = JSON.stringify(interim)
  const lineHash = keccak256(stringToHex(interimStr))
  if (!firstLineHash) firstLineHash = lineHash
  rolling = (rolling === '0x') ? lineHash : keccak256(concatHex(rolling, lineHash))
  obj.rollingHash = rolling
  // Préparer pour ligne suivante
  prevLineHash = lineHash
  migratedCount++
  outBuf.push(JSON.stringify(obj))
}

if (DRY) {
  console.log('[migrate] DRY-RUN ✅')
  console.log(JSON.stringify({ lines: lines.length, migrated: migratedCount, ai_decisions: aiCount, firstLineHash, finalRollingHash: rolling }, null, 2))
  process.exit(0)
}

// Sauvegarde et swap atomique
copyFileSync(file, backup)
writeFileSync(outTemp, outBuf.join('\n') + '\n')
renameSync(outTemp, file)
console.log('[migrate] DONE ✅', JSON.stringify({ lines: lines.length, migrated: migratedCount, ai_decisions: aiCount, finalRollingHash: rolling, backup }, null, 2))
