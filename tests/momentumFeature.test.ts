import { describe, it, expect } from 'vitest'
import { computeCoreFeatures, computeSyntheticPrice } from '../src/features'
import { appendAudit } from '../src/audit'
import fs from 'node:fs'
import path from 'node:path'

// Helper to append synthetic ai_decision lines with snapshotPrice for momentum history
function appendDecision(ts: number, price: number) {
  appendAudit({
    action: 'ai_decision',
    delegator: '0xdeadbeef',
    delegate: '0xdeadbeef',
    role: 'system',
    ts,
    snapshotPrice: price,
    priceSource: 'synthetic',
    snapshotPriceTs: ts,
  })
}

describe('momentumShortMinusLong feature', () => {
  const auditFile = path.join(process.cwd(),'data','delegations','audit.log')

  it('is null when insufficient historical points (<20)', () => {
    // Ensure clean audit so we control series precisely
    try { fs.rmSync(auditFile) } catch {}
    const refNow = Date.now()
    const feat = computeCoreFeatures('0xdeadbeef', { referenceNow: refNow, priceSeriesOverride: [] })
    expect(feat.momentumShortMinusLong).toBeNull()
  })

  it('computes SMA short-long difference once 20 historical points exist', () => {
  // Reset audit file for deterministic history
  try { fs.rmSync(auditFile) } catch {}
  // Generate 25 minutes of synthetic prices (1 per minute) as historical ai_decision entries
  const base = Date.now() - 40 * 60_000
    for (let i = 0; i < 25; i++) {
      const ts = base + i * 60_000
      const price = computeSyntheticPrice(ts)
      appendDecision(ts, price)
    }
    const refNow = base + 26 * 60_000
    const feat = computeCoreFeatures('0xdeadbeef', { referenceNow: refNow })
    expect(feat.momentumShortMinusLong).not.toBeUndefined()
    expect(feat.momentumShortMinusLong).not.toBeNull()
    // Basic sanity: value should be a finite number in plausible range
    if (feat.momentumShortMinusLong != null) {
      expect(Number.isFinite(feat.momentumShortMinusLong)).toBe(true)
      expect(Math.abs(feat.momentumShortMinusLong)).toBeLessThan(0.1)
    }
  })
})
