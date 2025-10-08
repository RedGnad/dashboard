#!/usr/bin/env ts-node
/**
 * verify-guardrails.ts
 * Quick CLI to evaluate current guardrails head and compare with latest ai_decision context.
 * Usage:
 *   npm run verify:guardrails
 * Exit codes:
 *   0 -> success (no blocking + no unexpected mismatch)
 *   1 -> evaluation error or hard block active
 *   2 -> soft warnings present (still returns JSON summary)
 */
import fs from 'node:fs'
import path from 'node:path'
import { evaluateGuardrailsV2, loadGuardrails } from './guardrails'

function readAuditTail(limit = 1000): any[] {
  const file = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
  if (!fs.existsSync(file)) return []
  const raw = fs.readFileSync(file, 'utf8').trim()
  if (!raw) return []
  const lines = raw.split('\n').slice(-limit)
  return lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

async function main() {
  try {
    const gr = loadGuardrails(true)
    const lines = readAuditTail(1200)
    let lastDecision: any = null
    let lastExecution: any = null
    const since24h = Date.now() - 24*60*60*1000
    let executions24h = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]
      if (l.action === 'ai_decision' && !lastDecision) lastDecision = l
      else if (l.action === 'execute' && !lastExecution) lastExecution = l
      if (l.action === 'execute' && l.ts >= since24h) executions24h++
      if (lastDecision && lastExecution && executions24h) break
    }
    // Feature head (optional)
    let featureHead: any = null
    try {
      const { computeFeatureSet } = await import('./hyperindex/features')
      featureHead = computeFeatureSet({})
    } catch {}
    const volatilitySimple = featureHead?.features ? featureHead.features.volatilitySimple : undefined
    const evalRes = evaluateGuardrailsV2(gr, {
      ai: { risk: lastDecision?.aiRiskScore, confidence: lastDecision?.aiConfidence },
      ctx: {
        lastExecutionTs: lastExecution?.ts,
        executions24h,
        spentUsd24h: 0,
        lastDecisionFeatureHash: lastDecision?.featureHash,
        lastDecisionFeatureHashV2: lastDecision?.featureHashV2,
        lastDecisionVolatilitySimple: lastDecision?.inferenceFeatures?.volatilitySimple,
      },
      features: featureHead ? { featureHash: featureHead.featureHash, featureHashV2: featureHead.featureHashV2, asOfTs: featureHead.asOfTs, volatilitySimple } : undefined,
    })
    const out = { ok: true, guardrails: gr, evaluation: evalRes, lastDecisionRollingHash: lastDecision?.rollingHash || null }
    console.log(JSON.stringify(out, null, 2))
    if (evalRes.blocked) process.exit(1)
    if (evalRes.warnings.length) process.exit(2)
    process.exit(0)
  } catch (e: any) {
    console.error('[verify-guardrails] error', e?.message || e)
    process.exit(1)
  }
}
main()
