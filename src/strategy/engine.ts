import { keccak256 } from 'viem'
import { loadModel, computeScore, mapScoreToDecision } from './model'

export interface StrategyContext {
  timestamp: number
  delegator: string
  balances: Record<string, string>
  targets: { symbol: string; weightBps: number }[]
  prices: Record<string, string>
  recentExecutions: { ts: number; action: string; amount?: string }[]
  riskParams: { maxSlippageBps: number; maxSingleUsd: number }
  marketVolatilityScore: number
}

export interface StrategyDecisionStep {
  from: string
  to: string
  amount: string // base units
  intentUsd?: string
}

export interface StrategyDecision {
  actionType: 'DCA_SWAP' | 'REBALANCE' | 'WITHDRAW' | 'SKIP'
  steps: StrategyDecisionStep[]
  rationale: string
  riskScore: number // 0 low risk -> 100 high
  confidence: number // 0..1
  meta?: Record<string, any>
}

export interface StrategyEngine {
  version(): string
  decide(ctx: StrategyContext): Promise<StrategyDecision>
}

export class DeterministicDcaStrategy implements StrategyEngine {
  version() { return 'det-v1' }
  async decide(ctx: StrategyContext): Promise<StrategyDecision> {
    const model = loadModel()
    // Features consumed: we rely on preview attaching featureHash externally; here we recompute needed keys only if present in ctx.balances (not yet) -> use placeholders
    // For now we derive allocationDeviation & others from empty placeholders -> neutral decisions unless model weights + random context produce thresholds.
    const pseudoFeatures: Record<string, any> = {
      balanceStableRatio: null,
      balanceTargetRatio: null,
      allocationDeviation: 0, // neutral by default
      timeSinceLastTradeMins: 60,
      executionsLast24h: 0,
      volatilitySimple: ctx.marketVolatilityScore, // reuse volatility as stand-in
    }
  const { score, z, weightsUsedHash } = computeScore(pseudoFeatures, model)
  const mapped = mapScoreToDecision(score, pseudoFeatures)
    const primary = ctx.targets[0] || { symbol: 'WMON', weightBps: 5000 }
    const baseAmount = '10000000000000000'
    const steps = mapped.actionType === 'DCA_SWAP' ? [ { from: 'USDC', to: primary.symbol, amount: baseAmount, intentUsd: '10' } ] : []
    return {
      actionType: mapped.actionType === 'SELL' ? 'REBALANCE' : (mapped.actionType as any),
      steps,
      rationale: mapped.rationale,
      riskScore: mapped.riskScore,
      confidence: mapped.confidence,
      meta: { ...mapped.meta, modelHash: model.modelHash, inferenceProvider: 'ts-local', version: model.version, rawScore: score, logitZ: z, mappingVersion: 'map-v1', weightsUsedHash },
    }
  }
}

export function hashRationale(rationale: string): string {
  const enc = new TextEncoder().encode(rationale)
  let hex = '0x'
  for (const b of enc) hex += b.toString(16).padStart(2,'0')
  return keccak256(hex as `0x${string}`)
}

// Singleton stub instance for now
export const strategyEngine: StrategyEngine = new DeterministicDcaStrategy()
