import { describe, it, expect } from 'vitest'
import { appendEvents } from '../src/hyperindex/eventStore'
import { computeFeatureSet } from '../src/hyperindex/features'
import { serializeFeatures } from '../src/hyperindex/schema'
import fs from 'node:fs'
import path from 'node:path'

// This test is light and deterministic: it appends synthetic events, computes features, re-hashes.
// It will not fail the suite if empty (no events) but will if hashing diverges.

describe('HyperIndex feature hashing', () => {
  const dataDir = path.join(process.cwd(), 'data', 'hyperindex')
  const eventsFile = path.join(dataDir, 'events.log')
  // isolate by clearing file (OK for test env)
  if (fs.existsSync(eventsFile)) fs.unlinkSync(eventsFile)

  it('re-hash matches backend serialization logic', () => {
    const now = Date.now()
    appendEvents([
      { id: 'e1', ts: now - 10000, chainId: 1, type: 'swap', price: 1.0, amountQuote: '100', amountBase: '50' },
      { id: 'e2', ts: now - 5000, chainId: 1, type: 'swap', price: 1.01, amountQuote: '120', amountBase: '60' },
      { id: 'e3', ts: now - 1000, chainId: 1, type: 'swap', price: 1.02, amountQuote: '80', amountBase: '40' }
    ] as any)
    const feat = computeFeatureSet({ now })
    expect(feat).toBeTruthy()
    if (!feat) return
    const { featureHash, ...rest } = feat as any
    const ser = serializeFeatures(rest)
    const enc = new TextEncoder().encode(ser)
    let hex = '0x'
    for (const b of enc) hex += b.toString(16).padStart(2, '0')
    // dynamic import of viem keccak for consistency
    const { keccak256 } = require('viem') as typeof import('viem')
    const local = keccak256(hex as `0x${string}`)
    if (local.toLowerCase() !== featureHash.toLowerCase()) {
      console.warn('[hyperindexFeatureHash.test] mismatch', { featureHash, local })
    }
    expect(local.toLowerCase()).toBe(featureHash.toLowerCase())
  })
})
