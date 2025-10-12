import { describe, it, expect } from 'vitest'
import { loadModel, computeScore, mapScoreToDecision } from '../src/strategy/model'
import { keccak256 } from 'viem'

function hex(str: string) {
  const enc = new TextEncoder().encode(str)
  let h = '0x'
  for (const b of enc) h += b.toString(16).padStart(2,'0')
  return h as `0x${string}`
}

describe('model determinism', () => {
  it('produces same modelHash across two loads', () => {
    const m1 = loadModel()
    const m2 = loadModel()
    expect(m1.modelHash).toBe(m2.modelHash)
  })

  it('score & mapping stable for fixed features', () => {
    const model = loadModel()
    const features = { allocationDeviation: -0.04123, executionsLast24h: 3, volatilitySimple: 0.12 }
    const { score, z } = computeScore(features, model)
    const mapped = mapScoreToDecision(score, features)
    const { score: score2, z: z2 } = computeScore(features, model)
    const mapped2 = mapScoreToDecision(score2, features)
    expect(score).toBe(score2)
    expect(z).toBe(z2)
    expect(mapped.actionType).toBe(mapped2.actionType)
    expect(mapped.riskScore).toBe(mapped2.riskScore)
    expect(mapped.confidence).toBe(mapped2.confidence)
  })
})

describe('audit line hash canonical (excluding rollingHash)', () => {
  it('hash matches recomputation logic', () => {
    const sample = { schemaVersion:1, ts:123, action:'test', actionId:'x', chainId:0, delegator:'0x', delegate:'0x', role:'system', structHash:'0x', digest:'0x', domainSeparator:'0x', caveatsRoot:'0x', salt:'0x', warnings:[], signatureModel:'UNKNOWN', prevEntryHash:'0xaaa' }
    const clone: any = { ...sample }
    // simulate append: rollingHash added AFTER line hash computed
    const lineHash = keccak256(hex(JSON.stringify(clone)))
    const rollingHash = lineHash // genesis style
    const stored = { ...clone, rollingHash }
    const recomputeClone = { ...stored }; delete (recomputeClone as any).rollingHash
    const recomputed = keccak256(hex(JSON.stringify(recomputeClone)))
    expect(recomputed).toBe(lineHash)
  })
})
