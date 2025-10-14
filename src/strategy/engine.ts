import { keccak256 } from 'viem'
import { loadModel, mapScoreToDecision } from './model'
import { MAPPING_VERSION } from '../constants'
import { computeCoreFeaturesAsync } from '../features'
import { selectInferenceProvider } from './providers'

export interface StrategyContext {
  timestamp: number
  delegator: string
  balances: Record<string, string>
  targets: { symbol: string; weightBps: number }[]
  prices: Record<string, string>
  recentExecutions: { ts: number; action: string; amount?: string }[]
  riskParams: { maxSlippageBps: number; maxSingleUsd: number }
  marketVolatilityScore: number
  strategyProfile?: 'default' | 'conservative' | 'aggressive'
  testForceAction?: 'buy' | 'sell' | ''
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
    const model = loadModel() // conservé pour compat local et pour feature hash v2 même si provider externe
  // Compute core features using async path (Envio or on-chain). Avoid sync path which can yield unknown balances.
  const feat = await computeCoreFeaturesAsync(ctx.delegator || '0x')
    const featuresForModel: Record<string, any> = {
      // Keep original values without coercion to preserve unknown/null state for mapper fallbacks
      allocationDeviation: typeof feat.features.allocationDeviation === 'number' ? feat.features.allocationDeviation : 0,
      executionsLast24h: feat.features.executionsLast24h || 0,
      volatilitySimple: typeof feat.features.volatilitySimple === 'number' ? feat.features.volatilitySimple : (ctx.marketVolatilityScore || 0),
      // Provide optional momentum to the mapper (used to relax/tighten thresholds)
      hyper_momentum: typeof (feat as any).momentumShortMinusLong === 'number' ? (feat as any).momentumShortMinusLong : undefined,
      // Pass-through raw ratios (can be null) so mapper can detect unknown allocation state
      balanceStableRatio: (feat.features.balanceStableRatio ?? null),
      balanceTargetRatio: (feat.features.balanceTargetRatio ?? null),
      timeSinceLastTradeMins: feat.features.timeSinceLastTradeMins ?? 60,
      // Explicit flag to indicate we could not compute allocation (e.g., indexer down OR zero funds)
      allocUnknown: (feat.features.balanceTargetRatio == null || feat.features.balanceStableRatio == null) ? 1 : 0,
      strategyProfile: ctx.strategyProfile || (process.env.STRATEGY_PROFILE as any) || 'default',
      testForceAction: ctx.testForceAction || '',
    }
    // Provider abstraction
  // Allow provider override via ctx (set by server using req.query.provider)
  const provider = selectInferenceProvider((ctx as any)?.inferenceProviderOverride)
    const inf = await provider.run({ features: featuresForModel, delegator: ctx.delegator, timestamp: ctx.timestamp, featureHashV2: feat.featureHashV2 })
    const score = inf.score
    const z = inf.z ?? 0
    // weightsUsedHash: si provider ne fournit pas, fallback au model local (pour cohérence structure audit)
    const weightsUsedHash = inf.weightsUsedHash || model.modelHash // model.modelHash as placeholder
    console.log('[DEBUG] Before mapScoreToDecision:', { score, featuresForModel })
  // Smart target selection: if multiple targets and positive momentum, pick highest momentum token
  // Otherwise use first non-stable target
  let primary = ctx.targets.find(t => t && t.symbol && t.symbol.toUpperCase() !== 'USDC') || ctx.targets[0]
  if (!primary) primary = { symbol: 'WMON', weightBps: 5000 }
  
  // TODO: In the future, query momentum per token and select best candidate
  // For now, use provided target or default to WMON
  const targetSymbol = primary.symbol
  
  const mapped = mapScoreToDecision(score, { ...featuresForModel, targetSymbol })
    
  // USE AI-CALCULATED SIZE instead of hardcoded values
  const aiSizePct = mapped.sizePct || 0.01 // AI-determined size percentage 
  const intentUsdFloat = aiSizePct * 100 // Convert to USD (sizePct is 0-1, multiply by base portfolio size)
  const intentUsd = Math.max(1, Math.round(intentUsdFloat * 100) / 100).toString() // Min 1 USD, round to cents
  const baseAmount = '10000000000000000' // Keep as placeholder for now
  
  console.log('[DEBUG] AI sizing:', { sizePct: mapped.sizePct, intentUsd, rawMagnitude: mapped.meta?.magnitude, targetSymbol })
  
  // Multi-asset: Determine source token based on allocation state
  // If allocUnknown (multi-asset rotation), default to MON as source
  // If classic DCA mode, use USDC
  const sourceToken = featuresForModel.allocUnknown === 1 ? 'MON' : 'USDC'
  
  const steps = mapped.actionType === 'DCA_SWAP' ? [ 
    { from: sourceToken, to: targetSymbol, amount: baseAmount, intentUsd } 
  ] : []
    return {
      actionType: mapped.actionType === 'SELL' ? 'REBALANCE' : (mapped.actionType as any),
      steps,
      rationale: mapped.rationale,
      riskScore: mapped.riskScore,
      confidence: mapped.confidence,
      meta: { ...mapped.meta, strategyProfile: featuresForModel.strategyProfile, modelHash: inf.modelHash || model.modelHash, inferenceProvider: provider.name(), inferenceVersion: inf.version, rawScore: score, logitZ: z, mappingVersion: MAPPING_VERSION, weightsUsedHash, featureHash: feat.featureHash, featureHashV2: feat.featureHashV2, inferenceProofHash: (inf.meta as any)?.inferenceProofHash },
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
