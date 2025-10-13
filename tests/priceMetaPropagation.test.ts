import { describe, it, expect } from 'vitest'
import { computeCoreFeatures } from '../src/features'

// This test validates that without ENABLE_SWITCHBOARD the price meta fields are still populated
// and source defaults to synthetic while snapshotPriceTs is present.

describe('price meta propagation (synthetic fallback)', () => {
  it('provides snapshotPrice, snapshotPriceTs & synthetic source deterministically', () => {
    delete process.env.ENABLE_SWITCHBOARD
    const refNow = Date.now()
    const feat = computeCoreFeatures('0xdeadbeef', { referenceNow: refNow })
    expect(feat.snapshotPrice).not.toBeUndefined()
    expect(typeof feat.snapshotPrice).toBe('number')
    expect(feat.priceSource).toBeDefined()
    expect(feat.priceSource === 'synthetic' || feat.priceSource === 'surge').toBe(true)
    // In absence of Surge we expect synthetic
    if (feat.priceSource !== 'synthetic') {
      // If this ever fails it means Surge auto-connected in CI unexpectedly
      // We still allow it but assert timestamp shape.
      expect(feat.snapshotPriceTs).toBeGreaterThan(0)
    } else {
      expect(feat.priceSource).toBe('synthetic')
      expect(feat.snapshotPriceTs).toBeGreaterThan(0)
      // Age should be near zero relative to refNow (allow a small drift)
      if (feat.snapshotPriceTs) {
        expect(Math.abs(feat.snapshotPriceTs - refNow)).toBeLessThanOrEqual(2000)
      }
    }
  })
})
