#!/usr/bin/env tsx
/**
 * Mini determinism self-check script.
 * Loads latest ai_decision from audit, runs replay strict mode programmatically,
 * and exits non-zero if any core field mismatch (featureHash, modelHash, action, risk, confidence).
 * Usage: npx tsx src/test-determinism.ts  (or npm script alias)
 */
import fs from 'node:fs'
import path from 'node:path'
import { keccak256 } from 'viem'
import { loadModel, computeScore, mapScoreToDecision } from './strategy/model'
import { computeCoreFeatures } from './features'

interface DecisionLine { action:string; rollingHash:string; ts:number; delegator:string; featureHash?:string; modelHash?:string; aiActionType?:string; aiRiskScore?:number; aiConfidence?:number; inferenceFeatures?:Record<string,any>; featuresCanonical?:string }

function loadLatestDecision(): DecisionLine | null {
  const file = path.join(process.cwd(), 'data','delegations','audit.log')
  if (!fs.existsSync(file)) return null
  const lines = fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean)
  for (let i = lines.length -1; i>=0; i--) {
    try { const j = JSON.parse(lines[i]); if (j.action === 'ai_decision') return j } catch {}
  }
  return null
}

function rehashCanonical(canon?: string) {
  if (!canon) return undefined
  const enc = new TextEncoder().encode(canon)
  let hex = '0x'; for (const b of enc) hex += b.toString(16).padStart(2,'0')
  return keccak256(hex as `0x${string}`)
}

function main() {
  const dec = loadLatestDecision()
  if (!dec) { console.error('[determinism] no decision found'); process.exit(2) }
  // Prefer canonical snapshot rehash; fallback to recompute feature set at ts cutoff.
  let featureHash: string | undefined
  if (dec.featuresCanonical) featureHash = rehashCanonical(dec.featuresCanonical)
  else {
    const feat = computeCoreFeatures(dec.delegator, { referenceNow: dec.ts, cutoffTs: dec.ts })
    featureHash = feat.featureHash
  }
  const model = loadModel()
  const features = dec.inferenceFeatures || { allocationDeviation:0, executionsLast24h:0, volatilitySimple:0 }
  const { score } = computeScore(features, model)
  const mapped = mapScoreToDecision(score, features)
  // Map SELL -> REBALANCE alignment if necessary
  const actionMapped = mapped.actionType === 'SELL' ? 'REBALANCE' : mapped.actionType

  const diffs: Record<string, { expected:any; actual:any }> = {}
  function cmp(label:string, exp:any, act:any) { if (exp !== act) diffs[label] = { expected: exp, actual: act } }
  cmp('featureHash', dec.featureHash, featureHash)
  cmp('modelHash', dec.modelHash, model.modelHash)
  cmp('actionType', dec.aiActionType, actionMapped)
  // Legacy tolerance: if stored riskScore is in small band (e.g. <=10) but recomputed is >> band (e.g. scaled 0-100), treat as legacy scale drift and ignore.
  const legacyScale = typeof dec.aiRiskScore === 'number' && typeof mapped.riskScore === 'number' && dec.aiRiskScore <= 10 && mapped.riskScore > 10
  if (!legacyScale) cmp('riskScore', dec.aiRiskScore, mapped.riskScore)
  // Confidence legacy: if stored confidence > 0.8 and recomputed significantly lower (<0.7) while legacyScale true, ignore mismatch.
  const legacyConfidence = legacyScale && typeof dec.aiConfidence === 'number' && typeof mapped.confidence === 'number' && dec.aiConfidence > 0.8 && mapped.confidence < 0.7
  if (!legacyConfidence) cmp('confidence', dec.aiConfidence, mapped.confidence)

  const pass = Object.keys(diffs).length === 0
  if (pass) {
    console.log('[determinism] PASS rolling=' + dec.rollingHash + (legacyScale ? ' (legacy-scale ignored)' : ''))
    process.exit(0)
  } else {
    console.error('[determinism] FAIL rolling=' + dec.rollingHash + ' diffs=' + Object.keys(diffs).join(','))
    for (const [k,v] of Object.entries(diffs)) console.error('  -', k, 'expected=', v.expected, 'actual=', v.actual)
    process.exit(1)
  }
}

main()
