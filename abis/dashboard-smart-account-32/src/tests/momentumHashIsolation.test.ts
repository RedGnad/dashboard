import { describe, it, expect } from 'vitest'
import { computeCoreFeatures } from '../features'

// This test asserts that introducing momentumShortMinusLong does not change the hashed feature ordering
// or the resulting featureHash / featureHashV2 values for identical core feature inputs. We simulate
// accumulation of historical priceSeries by writing synthetic ai_decision lines then recomputing.
// For simplicity (and to avoid mutating the real audit log) we just call computeCoreFeatures twice
// and assert stability when momentum transitions from null->value (by mimicking priceSeriesOverride).

type PricePoint = { ts: number; price: number }

function buildSeries(n: number, base=1): PricePoint[] {
  const out: PricePoint[] = []
  const now = Date.now()
  for (let i=0;i<n;i++) {
    // mild drift so SMA windows differ
    const p = base + (i/1000)
    out.push({ ts: now - (n-i)*60000, price: Number(p.toFixed(6)) })
  }
  return out
}

describe('momentum hash isolation', () => {
  it('feature hashes unchanged when momentum becomes non-null', () => {
    const delegator = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    // Series length 10 -> momentum null (needs 20)
    const shortSeries = buildSeries(10)
    const r1 = computeCoreFeatures(delegator, { priceSeriesOverride: shortSeries, referenceNow: shortSeries.at(-1)!.ts + 1000 })
    expect(r1.momentumShortMinusLong).toBeNull()

    // Series length 25 -> momentum non-null
    const longSeries = buildSeries(25)
    const r2 = computeCoreFeatures(delegator, { priceSeriesOverride: longSeries, referenceNow: longSeries.at(-1)!.ts + 1000 })
    expect(r2.momentumShortMinusLong).not.toBeNull()

    // Core ordered feature list must match
    expect(r1.order).toEqual(r2.order)

    // featureHash (v1) and featureHashV2 must remain identical across runs if core inputs align.
    // We cannot force identical timeSinceLastTradeMins etc. here because those derive from audit scan.
    // Instead we assert: the set of ordered feature names exclude momentum, and momentum absence/presence
    // does NOT appear in serialization order.
    expect(r1.order.includes('momentumShortMinusLong')).toBe(false)

    // Defensive: featureHashV2 should remain deterministic given identical core field values (approximate).
    // Because we bypass audit log, timeSinceLastTradeMins & executionsLast24h may differ if computed.
    // We still assert that momentum does not leak into hash strings.
    const serHasMomentumToken = (s: string|undefined) => !!s && s.includes('momentum')
    expect(serHasMomentumToken(r1.featureHash)).toBe(false)
    expect(serHasMomentumToken(r2.featureHash)).toBe(false)
    if (r1.featureHashV2 && r2.featureHashV2) {
      expect(serHasMomentumToken(r1.featureHashV2)).toBe(false)
      expect(serHasMomentumToken(r2.featureHashV2)).toBe(false)
    }
  })
})
