#!/usr/bin/env tsx
/**
 * Quick CLI to verify the latest ai_decision line deterministically.
 * Usage:  npm run verify:latest
 */
import fs from 'node:fs'
import path from 'node:path'
import { keccak256 } from 'viem'
import { loadModel } from './strategy/model'

interface AiDecisionLine { [k: string]: any; action: string }

function findLatestDecision(): AiDecisionLine | null {
  const file = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
  if (!fs.existsSync(file)) return null
  const raw = fs.readFileSync(file, 'utf8').trim()
  if (!raw) return null
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (!l) continue
    try { const j = JSON.parse(l); if (j.action === 'ai_decision') return j } catch {}
  }
  return null
}

function rehashCanonical(canonical: string): string {
  const enc = new TextEncoder().encode(canonical)
  let hex = '0x'; for (const b of enc) hex += b.toString(16).padStart(2,'0')
  return keccak256(hex as `0x${string}`)
}

function rehashCanonicalV2(canonical: string): string {
  const filtered = canonical.split('\n').filter(l => !l.startsWith('ts=')).join('\n')
  const enc = new TextEncoder().encode(filtered)
  let hex = '0x'; for (const b of enc) hex += b.toString(16).padStart(2,'0')
  return keccak256(hex as `0x${string}`)
}

function main() {
  const line = findLatestDecision()
  if (!line) {
    console.error('[verify-latest] aucune décision trouvée')
    process.exit(1)
  }
  const checks: Record<string, { expected: any; actual: any; pass: boolean }> = {}
  function add(label: string, expected: any, actual: any) { checks[label] = { expected, actual, pass: expected === actual } }

  if (line.featuresCanonical) {
    const fh = rehashCanonical(line.featuresCanonical)
    add('featureHash', line.featureHash, fh)
    if (line.featureHashV2) {
      const fh2 = rehashCanonicalV2(line.featuresCanonical)
      add('featureHashV2', line.featureHashV2, fh2)
    }
  } else {
    add('featuresCanonical(present)', true, false)
  }

  // Model provenance
  try {
    const model = loadModel()
    add('modelHash', line.modelHash, model.modelHash)
  } catch (e) {
    add('modelHash(load)', 'success', 'error:' + (e as Error).message)
  }

  // Presence fields
  add('rawScore(present)', true, line.rawScore !== undefined)
  add('logitZ(present)', true, line.logitZ !== undefined)
  add('mappingVersion(present)', true, line.mappingVersion !== undefined)
  add('weightsUsedHash(present)', true, line.weightsUsedHash !== undefined)

  const pass = Object.values(checks).every(c => c.pass)
  if (pass) {
    console.log(JSON.stringify({ pass: true, rollingHash: line.rollingHash, actionId: line.actionId, checks }, null, 2))
    process.exit(0)
  } else {
    console.error(JSON.stringify({ pass: false, rollingHash: line.rollingHash, actionId: line.actionId, checks }, null, 2))
    process.exit(2)
  }
}

main()
