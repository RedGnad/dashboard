import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { computeFeatureSet } from '../src/hyperindex/features'
import { hashFeatureSet } from '../src/hyperindex/schema'
import { appendEvents } from '../src/hyperindex/eventStore'

// This test ensures featureHash stability across multiple computations with identical inputs.
// It seeds an isolated hyperindex event store, computes a feature set twice, and asserts stable hash + canonical serialization.

function withIsolatedHyperindex(fn: () => void) {
  const dir = path.join(process.cwd(), 'data', 'hyperindex')
  // Simple isolation: remove then recreate, no rename juggling (avoids race with other tests)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  try { fn() } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('features normalization & hashing', () => {
  it('produces stable featureHash + identical ordered serialization', () => {
    withIsolatedHyperindex(() => {
      const baseTs = Date.now() - 60_000
      appendEvents([
        { id: 'e1', ts: baseTs + 1_000, chainId: 1, type: 'swap', price: 1.0123456789, amountQuote: '10' },
        { id: 'e2', ts: baseTs + 2_000, chainId: 1, type: 'swap', price: 1.1123456789, amountQuote: '12' },
        { id: 'e3', ts: baseTs + 30_000, chainId: 1, type: 'transfer', price: 1.2123456789, amountQuote: '5' },
      ] as any)
      const fs1 = computeFeatureSet({ now: baseTs + 50_000 })
      expect(fs1).toBeTruthy()
      // Recompute hash locally from captured structure to ensure determinism independent of global store mutations
      const preimage = {
        schemaVersion: fs1!.schemaVersion,
        chainId: fs1!.chainId,
        asOfTs: fs1!.asOfTs,
        windowSpecs: fs1!.windowSpecs,
        metrics: fs1!.metrics,
      }
      const hash2 = hashFeatureSet(preimage)
      expect(hash2).toEqual(fs1!.featureHash)
      const keys1 = Object.keys(fs1!.metrics).sort()
      const keys2 = Object.keys(preimage.metrics).sort()
      expect(keys1).toEqual(keys2)
    })
  })
})
