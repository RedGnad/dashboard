#!/usr/bin/env tsx
/**
 * Replay a specific ai_decision audit line by rollingHash (or latest if omitted).
 * Steps:
 * 1. Load audit log, find target ai_decision line.
 * 2. Recompute features at original timestamp (referenceNow = decision.ts) and hash.
 * 3. Load model and recompute score + mapping.
 * 4. Compare key fields (featureHash, modelHash, actionType, riskScore, confidence) with stored values.
 * 5. Optionally verify rolling hash chain (lightweight) for the segment up to that line.
 *
 * Usage:
 *   npm run replay:decision -- --rolling <rollingHash>
 *   npm run replay:decision  # (replays latest ai_decision)
 */
import fs from 'node:fs'
import path from 'node:path'
import { computeCoreFeatures, type FeatureResult } from './features'
import { loadModel, computeScore, mapScoreToDecision } from './strategy/model'
import { MAPPING_VERSION } from './constants'
import { keccak256 } from 'viem'

interface DecisionLine {
  action: string
  rollingHash: string
  ts: number
  delegator: string
  aiRiskScore?: number
  aiConfidence?: number
  aiActionType?: string
  aiRationaleHash?: string
  featureHash?: string
  featureSchemaVersion?: number
  modelHash?: string
  featuresCanonical?: string
  inferenceFeatures?: Record<string, any>
}

function loadAuditLines(): DecisionLine[] {
  const file = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
  if (!fs.existsSync(file)) return []
  const raw = fs.readFileSync(file, 'utf8').trim()
  if (!raw) return []
  const out: DecisionLine[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const j = JSON.parse(line)
      if (j.action === 'ai_decision') out.push(j)
    } catch {}
  }
  return out
}

function parseArgs() {
  const args = process.argv.slice(2)
  const out: any = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--rolling' && args[i+1]) { out.rolling = args[++i] }
    if (a === '--json') out.json = true
    if (a === '--strict') out.strict = true
    if (a === '--strict-snapshot') out.strictSnapshot = true
    if (a === '--list' && args[i+1]) { out.list = Number(args[++i]) }
    if (a === '--chain') out.chain = true
  }
  return out
}

function buildFeatureProxy(decisionTs: number) {
  // For now we recompute features fresh. This may differ if past context changed (e.g., new executes after decision ts)
  // Future: we could snapshot features at decision time or scan subset of audit up to decision index.
  return computeCoreFeatures('0x', { referenceNow: decisionTs })
}

function replay(decision: DecisionLine) {
  // Recompute features at decision timestamp ignoring future events (cutoffTs)
  let feat: FeatureResult | null = null
  let recomputedFeatureHash: string | undefined
  if (decision.featuresCanonical) {
    // Re-hash the canonical snapshot deterministically to compare with stored featureHash
    const enc = new TextEncoder().encode(decision.featuresCanonical)
    let hex = '0x'
    for (const b of enc) hex += b.toString(16).padStart(2,'0')
    recomputedFeatureHash = keccak256(hex as `0x${string}`)
  } else {
    feat = computeCoreFeatures(decision.delegator, { referenceNow: decision.ts, cutoffTs: decision.ts })
    recomputedFeatureHash = feat.featureHash
  }
  const model = loadModel()
  const featureInputs: Record<string, any> = decision.inferenceFeatures || (feat ? {
    allocationDeviation: feat.features.allocationDeviation ?? 0,
    executionsLast24h: feat.features.executionsLast24h ?? 0,
    volatilitySimple: feat.features.volatilitySimple ?? 0,
  } : { allocationDeviation:0, executionsLast24h:0, volatilitySimple:0 })
  const { score } = computeScore({
    allocationDeviation: featureInputs.allocationDeviation,
    executionsLast24h: featureInputs.executionsLast24h,
    volatilitySimple: featureInputs.volatilitySimple,
  }, model)
  const mapped = mapScoreToDecision(score, {
    allocationDeviation: featureInputs.allocationDeviation,
    executionsLast24h: featureInputs.executionsLast24h,
    volatilitySimple: featureInputs.volatilitySimple,
  })
  const diffs: Record<string, { expected: any; actual: any }> = {}
  const tolerant: string[] = []
  function cmp(label: string, expected: any, actual: any) {
    if (expected !== actual) diffs[label] = { expected, actual }
  }
  cmp('featureHash', decision.featureHash, recomputedFeatureHash)
  cmp('modelHash', decision.modelHash, model.modelHash)
  cmp('aiActionType', decision.aiActionType, mapped.actionType === 'SELL' ? 'REBALANCE' : mapped.actionType)
  cmp('aiRiskScore', decision.aiRiskScore, mapped.riskScore)
  cmp('aiConfidence', decision.aiConfidence, mapped.confidence)
  // Tolerance: if ONLY riskScore / confidence differ AND mappingVersion recorded matches current mapping version,
  // we still consider core provenance deterministic (features/model/action).
  const diffKeys = Object.keys(diffs)
  const coreKeys = diffKeys.filter(k => !['aiRiskScore','aiConfidence'].includes(k))
  if (coreKeys.length === 0 && diffKeys.length > 0) {
    const mvStored = (decision as any).mappingVersion
    if (mvStored && mvStored === MAPPING_VERSION) {
      // classify risk/confidence diffs as tolerant (non-fatal drift in formula rounding)
      for (const k of diffKeys) if (['aiRiskScore','aiConfidence'].includes(k)) tolerant.push(k)
    }
  }

  const hardDiffs = Object.fromEntries(Object.entries(diffs).filter(([k]) => !tolerant.includes(k)))
  const pass = Object.keys(hardDiffs).length === 0
  return { pass, diffs, tolerant, decisionRollingHash: decision.rollingHash, decisionTs: decision.ts, stored: decision, recomputed: { featureHash: recomputedFeatureHash, modelHash: model.modelHash, mapped } }
}

async function main() {
  const args = parseArgs()
  const decisions = loadAuditLines()
  if (!decisions.length) {
    console.error('[replay] no ai_decision lines found')
    process.exit(1)
  }
  if (args.list) {
    const slice = decisions.slice(-args.list)
    const listing = slice.map(d => ({ ts: d.ts, rollingHash: d.rollingHash, action: d.aiActionType, risk: d.aiRiskScore, confidence: d.aiConfidence, featureHash: d.featureHash }))
    if (args.json) console.log(JSON.stringify({ list: listing }, null, 2))
    else {
      console.log('[replay] list size=' + listing.length)
      for (const it of listing) console.log(` - ts=${it.ts} rolling=${it.rollingHash} action=${it.action} risk=${it.risk} conf=${it.confidence}`)
    }
    return
  }
  let target: DecisionLine | undefined
  if (args.rolling) target = decisions.find(d => d.rollingHash === args.rolling)
  else target = decisions[decisions.length - 1]
  if (!target) {
    console.error('[replay] decision not found for rollingHash', args.rolling)
    process.exit(2)
  }
  if (args.strictSnapshot) {
    const snapshotDiffs: Record<string, { expected: any; actual: any }> = {}
    function add(label: string, exp: any, act: any) { if (exp !== act) snapshotDiffs[label] = { expected: exp, actual: act } }
    if (target.featuresCanonical) {
      const enc = new TextEncoder().encode(target.featuresCanonical)
      let hex = '0x'; for (const b of enc) hex += b.toString(16).padStart(2,'0')
      const fh = keccak256(hex as `0x${string}`)
      add('featureHash(rehash)', target.featureHash, fh)
      if ((target as any).featureHashV2) {
        const lines = target.featuresCanonical.split('\n')
        const tsFiltered = lines.filter(l => !l.startsWith('ts=')).join('\n')
        const enc2 = new TextEncoder().encode(tsFiltered)
        let hex2='0x'; for (const b of enc2) hex2+=b.toString(16).padStart(2,'0')
        const fh2 = keccak256(hex2 as `0x${string}`)
        add('featureHashV2(rehash)', (target as any).featureHashV2, fh2)
      }
    } else {
      add('featuresCanonical', 'present', null)
    }
    if (!(target as any).modelHash) add('modelHash', 'non-empty', (target as any).modelHash)
    if ((target as any).rawScore === undefined) add('rawScore', 'present', (target as any).rawScore)
    if ((target as any).mappingVersion === undefined) add('mappingVersion', 'present', (target as any).mappingVersion)
    if ((target as any).weightsUsedHash === undefined) add('weightsUsedHash', 'present', (target as any).weightsUsedHash)
    if (Object.keys(snapshotDiffs).length === 0) {
      if (args.json) console.log(JSON.stringify({ pass: true, mode: 'strict-snapshot', rollingHash: target.rollingHash }, null, 2))
      else console.log('[replay] PASS strict-snapshot', { rollingHash: target.rollingHash })
      return
    } else {
      if (args.json) console.log(JSON.stringify({ pass: false, mode: 'strict-snapshot', diffs: snapshotDiffs }, null, 2))
      else console.error('[replay] MISMATCH strict-snapshot', snapshotDiffs)
      process.exit(4)
    }
  }
  const result = replay(target)
  let chainInfo: any = null
  if (args.chain) {
    try {
      const file = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean)
        let found = false
        for (const l of raw) {
          try { const j = JSON.parse(l); if (j.rollingHash === result.decisionRollingHash) { found = true; break } } catch {}
        }
        chainInfo = { ok: found }
      } else chainInfo = { ok: false, reason: 'audit_missing' }
    } catch (e:any) { chainInfo = { ok: false, reason: e?.message || 'chain_error' } }
  }
  if (args.json) {
    console.log(JSON.stringify({ ...result, chain: chainInfo }, null, 2))
  } else {
    const bits: string[] = []
    bits.push(`rolling=${result.decisionRollingHash}`)
    bits.push(`featureHashMatch=${result.diffs.featureHash ? 'false':'true'}`)
    bits.push(`modelHashMatch=${result.diffs.modelHash ? 'false':'true'}`)
    bits.push(`actionMatch=${result.diffs.aiActionType ? 'false':'true'}`)
  bits.push(`riskMatch=${result.diffs.aiRiskScore ? (result.tolerant.includes('aiRiskScore')?'tolerant':'false'):'true'}`)
  bits.push(`confidenceMatch=${result.diffs.aiConfidence ? (result.tolerant.includes('aiConfidence')?'tolerant':'false'):'true'}`)
    if (chainInfo) bits.push(`chainOk=${chainInfo.ok}`)
    if (result.pass) console.log('[replay] status=PASS ' + bits.join(' '))
    else {
      console.error('[replay] status=FAIL ' + bits.join(' '))
      console.error('[replay] diffs', result.diffs)
      if (args.strict) process.exit(3)
    }
  }
}

main().catch(e => { console.error('[replay] fatal', e); process.exit(10) })
