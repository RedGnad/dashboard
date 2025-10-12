import { describe, it, expect } from 'vitest'
import { mapScoreToDecision } from '../src/strategy/model'

// These tests isolate the mapping logic to verify when it returns SKIP
// independent of Envio sync or feature builder availability.

describe('mapScoreToDecision basic behavior', () => {
  it('returns SKIP when allocationDeviation is 0 even with high score', () => {
    const score = 0.85
    const features = {
      allocationDeviation: 0,
      executionsLast24h: 47,
      volatilitySimple: 0.0115,
      strategyProfile: 'default',
      hyper_momentum: 0.0024,
    }
    const decision = mapScoreToDecision(score, features)
    expect(decision.actionType).toBe('SKIP')
    expect(decision.rationale).toContain('score=')
    expect(decision.meta.allocDev).toBe(0)
  })

  it('returns DCA_SWAP when underweight (allocDev < -0.02) and score above threshold', () => {
    const score = 0.85
    const features = {
      allocationDeviation: -0.05,
      executionsLast24h: 10,
      volatilitySimple: 0.01,
      strategyProfile: 'default',
    }
    const decision = mapScoreToDecision(score, features)
    expect(['DCA_SWAP', 'BUY']).toContain(decision.actionType)
  })

  it('returns SELL when overweight (allocDev > 0.04) and score above threshold', () => {
    const score = 0.86
    const features = {
      allocationDeviation: 0.06,
      executionsLast24h: 5,
      volatilitySimple: 0.02,
      strategyProfile: 'default',
    }
    const decision = mapScoreToDecision(score, features)
    expect(decision.actionType).toBe('SELL')
  })
})
