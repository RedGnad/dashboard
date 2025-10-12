import { describe, it, expect, beforeAll } from 'vitest'

// We will simulate two runs of computeCoreFeatures with different PRICE_BASE_SYMBOL
// and assert that the core featureHash (v1) remains unchanged (since price not in hashing order yet).

import { computeCoreFeatures } from '../src/features'

function runWithSymbol(symbol: string, referenceNow: number) {
  process.env.PRICE_BASE_SYMBOL = symbol
  const res = computeCoreFeatures('0xdeadbeef', { referenceNow })
  return { featureHash: res.featureHash, featureHashV2: res.featureHashV2 }
}

describe('PRICE_BASE_SYMBOL invariance', () => {
  beforeAll(() => {
    // Ensure deterministic environment (no prior audit lines influencing executions24h for this delegator)
  })
  it('changing PRICE_BASE_SYMBOL does not change featureHash (timestamp-neutral by fixing referenceNow)', () => {
    // Because featureHash v1 includes the timestamp, we fix referenceNow so the hash comparison is meaningful.
    const fixedNow = Date.now()
    const a = runWithSymbol('MON', fixedNow)
    const b = runWithSymbol('WMON', fixedNow)
    expect(a.featureHash).toBe(b.featureHash)
    if (a.featureHashV2 && b.featureHashV2) expect(a.featureHashV2).toBe(b.featureHashV2)
  })
})
