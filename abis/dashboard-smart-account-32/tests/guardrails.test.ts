import path from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

function loadAuditLines(): any[] {
  try {
    const raw = readFileSync(path.join(process.cwd(),'data','delegations','audit.log'),'utf8').trim()
    if (!raw) return []
    return raw.split('\n').map(l=>{ try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

describe('guardrail presence sanity', () => {
  it('counts guardrailReason codes consistently (if any)', () => {
    const lines = loadAuditLines()
    if (!lines.length) return
    const reasons: Record<string, number> = {}
    for (const l of lines) {
      if (l.action === 'execute' && l.guardrailReason) {
        reasons[l.guardrailReason] = (reasons[l.guardrailReason] || 0) + 1
      }
    }
    // Simple invariant: counts are non-negative and keys are strings
    for (const [k,v] of Object.entries(reasons)) {
      expect(typeof k).toBe('string')
      expect(v).toBeGreaterThan(0)
    }
  })
})

import { evaluateGuardrailsV2, loadGuardrails } from '../src/guardrails'

describe('guardrails v2 evaluation', () => {
  const baseCtx = { executions24h: 0, spentUsd24h: 0 } as any
  it('flags volatility drift', () => {
    const gr = loadGuardrails(true)
    const res = evaluateGuardrailsV2(gr, {
      ai: { risk: 10, confidence: 0.9 },
      ctx: { ...baseCtx, lastDecisionVolatilitySimple: 0.1 },
      features: { volatilitySimple: (gr.maxVolatilityDrift || 0.35) + 0.5, featureHash: '0x1', featureHashV2: '0x2', asOfTs: Date.now() }
    })
    expect(res.warnings).toContain('volatility_drift_exceeds_threshold')
  })
  it('flags stale features', () => {
    const gr = loadGuardrails(true)
    const res = evaluateGuardrailsV2(gr, {
      ai: { risk: 10, confidence: 0.9 },
      ctx: { ...baseCtx },
      features: { asOfTs: Date.now() - (gr.maxFeatureAgeMs || 300000) - 10_000 }
    })
    expect(res.warnings).toContain('features_stale')
  })
  it('blocks on feature hash mismatch when hard block enabled', () => {
    const gr = loadGuardrails(true)
    const res = evaluateGuardrailsV2(gr, {
      ai: { risk: 10, confidence: 0.9 },
      ctx: { ...baseCtx, lastDecisionFeatureHash: '0xabc', lastDecisionFeatureHashV2: '0xdef' },
      features: { featureHash: '0x123', featureHashV2: '0x456', asOfTs: Date.now() }
    })
    expect(res.blocked).toBe(true)
    expect(res.reason).toMatch(/feature_hash/)
  })
  it('passes clean scenario', () => {
    const gr = loadGuardrails(true)
    const res = evaluateGuardrailsV2(gr, {
      ai: { risk: 10, confidence: 0.9 },
      ctx: { ...baseCtx },
      features: { asOfTs: Date.now(), volatilitySimple: 0.2, featureHash: '0xaaa', featureHashV2: '0xbbb' }
    })
    expect(res.blocked).toBe(false)
    expect(res.warnings.length).toBe(0)
  })
})
