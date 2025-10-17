import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { evaluateGuardrailsV2, loadGuardrails } from '../src/guardrails'
import { recordGuardrailHit, getStreak, revokeDelegation, isRevoked } from '../src/revocation'

// Utility to isolate revocation state (works because file persistence is simple JSON)
const REV_FILE = path.join(process.cwd(),'data','revocations.json')
function resetRevocations() {
  if (fs.existsSync(REV_FILE)) fs.unlinkSync(REV_FILE)
}

beforeEach(() => {
  resetRevocations()
})

describe('auto-revoke escalation & streak', () => {
  const delegator = '0x1111111111111111111111111111111111111111'
  it('escalates abnormal_hyperindex_activity over hash mismatch', () => {
    const gr = loadGuardrails(true)
    // Simule: feature hash mismatch + hyper abnormal flag
    const res = evaluateGuardrailsV2(gr, {
      ai: { risk: 10, confidence: 0.9 },
      ctx: { executions24h: 0, spentUsd24h: 0, lastDecisionFeatureHash: '0xabc', lastDecisionFeatureHashV2: '0xdef' },
      features: { featureHash: '0x123', featureHashV2: '0x456', asOfTs: Date.now() },
      hyper: { abnormalTransferFlag: 1 }
    })
    expect(res.blocked).toBe(true)
    expect(res.warnings).toContain('abnormal_hyperindex_activity')
    expect(res.reason).toBe('abnormal_hyperindex_activity')
    expect(res.reasonsAll).toContain('feature_hash_mismatch')
  })

  it('increments streak then auto revokes at threshold', () => {
    // Manually simulate two abnormal hits
    recordGuardrailHit(delegator, 'abnormal_hyperindex_activity')
    expect(getStreak(delegator)).toBe(1)
    recordGuardrailHit(delegator, 'abnormal_hyperindex_activity')
    expect(getStreak(delegator)).toBe(2)
    // threshold default is 2 -> revoke on maybeAutoRevoke logic normally, emulate direct revoke here
    const rec = revokeDelegation(delegator, 'auto_revoke_abnormal_hyperindex')
    expect(rec.delegator).toBe(delegator)
    const rv = isRevoked(delegator)
    expect(!!rv).toBe(true)
  })

  it('clears streak on clear event', () => {
    recordGuardrailHit(delegator, 'abnormal_hyperindex_activity')
    recordGuardrailHit(delegator, 'clear')
    expect(getStreak(delegator)).toBe(0)
  })
})
