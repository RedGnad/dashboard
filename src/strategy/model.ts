import fs from 'node:fs'
import path from 'node:path'
import { keccak256 } from 'viem'

export interface LoadedModel {
  version: string
  arch: string
  weights: Record<string, number>
  bias: number
  meta?: Record<string, any>
  modelHash: string
}

let CACHED: LoadedModel | null = null
let CACHED_MTIME = 0

function canonicalize(raw: any) {
  // Keep only stable fields in canonical order
  const weights: Record<string, number> = {}
  const keys = Object.keys(raw.weights || {}).sort()
  for (const k of keys) {
    const v = Number(raw.weights[k])
    if (Number.isFinite(v)) weights[k] = Number(v.toFixed(8))
  }
  return {
    version: String(raw.version || ''),
    arch: String(raw.arch || ''),
    bias: Number(raw.bias || 0),
    weights,
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},
  }
}

function hashCanonical(can: ReturnType<typeof canonicalize>): string {
  const payload = {
    version: can.version,
    arch: can.arch,
    bias: Number(can.bias.toFixed(8)),
    weights: can.weights,
    meta: can.meta, // meta included (must stay immutable for deterministic hash)
  }
  const json = JSON.stringify(payload)
  const enc = new TextEncoder().encode(json)
  let hex = '0x'
  for (const b of enc) hex += b.toString(16).padStart(2,'0')
  return keccak256(hex as `0x${string}`)
}

export function loadModel(): LoadedModel {
  const file = path.join(process.cwd(), 'strategy-model.json')
  const stat = fs.statSync(file)
  if (CACHED && stat.mtimeMs === CACHED_MTIME) return CACHED
  const raw = JSON.parse(fs.readFileSync(file,'utf8'))
  const can = canonicalize(raw)
  const modelHash = hashCanonical(can)
  CACHED = { ...can, modelHash }
  CACHED_MTIME = stat.mtimeMs
  return CACHED
}

export interface ScoreResult {
  score: number
  z: number
  weightsUsed: Record<string, number>
  weightsUsedHash: string
}

export function computeScore(features: Record<string, any>, model: LoadedModel): ScoreResult {
  let z = model.bias
  for (const [k,w] of Object.entries(model.weights)) {
    const v = typeof features[k] === 'number' && Number.isFinite(features[k]) ? features[k] : 0
    z += w * v
  }
  const score = 1 / (1 + Math.exp(-z))
  // weightsUsedHash derived from deterministic JSON of weights
  const weightsJson = JSON.stringify(model.weights)
  const enc = new TextEncoder().encode(weightsJson)
  let hex = '0x'
  for (const b of enc) hex += b.toString(16).padStart(2,'0')
  const weightsUsedHash = keccak256(hex as `0x${string}`)
  return { score: Number(score.toFixed(8)), z: Number(z.toFixed(8)), weightsUsed: model.weights, weightsUsedHash }
}

export interface DecisionMapping {
  actionType: 'DCA_SWAP' | 'SKIP' | 'SELL' | 'BUY'
  sizePct: number
  rationale: string
  riskScore: number
  confidence: number
  meta: Record<string, any>
}

export function mapScoreToDecision(score: number, features: Record<string, any>): DecisionMapping {
  const allocDev = typeof features.allocationDeviation === 'number' ? features.allocationDeviation : 0
  const allocUnknown = features.allocUnknown === 1 || (features.balanceTargetRatio == null && features.balanceStableRatio == null)
  console.log('[DEBUG] mapScoreToDecision:', { allocationDeviation: features.allocationDeviation, allocDev, allocUnknown, features: Object.keys(features) })
  const hyperVol24h = typeof features.hyper_volatility_24h === 'number' ? features.hyper_volatility_24h : undefined
  const momentum = typeof features.hyper_momentum === 'number' ? features.hyper_momentum : undefined
  const profile = (features.strategyProfile || 'default') as 'default' | 'conservative' | 'aggressive'
  const testForceAction = (features.testForceAction || '') as 'buy' | 'sell' | ''
  // Basic thresholds
  let action: DecisionMapping['actionType'] = 'SKIP'
  // LOWERED thresholds to allow more trading when allocation is significantly off
  let buyThreshold = 0.42  // Was 0.56
  let sellThreshold = 0.45  // Was 0.57
  let sizeMultiplier = 1.0
  // Profile tuning: conservative = plus strict et tailles réduites; aggressive = plus souple et tailles accrues
  if (profile === 'conservative') {
    buyThreshold += 0.04
    sellThreshold += 0.04
    sizeMultiplier = 0.6
  } else if (profile === 'aggressive') {
    buyThreshold -= 0.04
    sellThreshold -= 0.04
    sizeMultiplier = 1.5
  }
  // Momentum influence: if positive momentum, ease buy; if negative, ease sell
  if (typeof momentum === 'number') {
    if (momentum > 0.2) buyThreshold -= 0.02
    if (momentum < -0.2) sellThreshold -= 0.02
  }
  if (testForceAction === 'buy') {
    action = 'DCA_SWAP'
  } else if (testForceAction === 'sell') {
    action = 'SELL'
  } else {
    // Multi-asset rotation mode: if allocation is unknown, use momentum/score to decide
    if (allocUnknown) {
      const executionsCount = features.executionsLast24h || 0
      const timeSinceLastTrade = features.timeSinceLastTradeMins ?? 999
      
      // Exploration mode: 15% chance of exploratory trade
      // Dev: no time limit (set to 0 for immediate), prod: set to 1 minute
      const minTimeBetweenExploratoryTrades = Number(process.env.MIN_EXPLORATORY_TRADE_MINS || 0)
      const explorationThreshold = 0.15 // 15% chance
      const shouldExplore = timeSinceLastTrade > minTimeBetweenExploratoryTrades && Math.random() < explorationThreshold
      
      // Positive momentum = BUY opportunity (assouplir thresholds)
      if (momentum && momentum > 0.008 && score > 0.50) {
        action = 'DCA_SWAP'
      }
      // High confidence even with low momentum
      else if (score > 0.75) {
        action = 'DCA_SWAP'
      }
      // Negative momentum = potential SELL
      else if (momentum && momentum < -0.012 && score > 0.55) {
        action = 'SELL'
      }
      // Exploratory trade: small random trade to discover opportunities
      else if (shouldExplore && score > 0.40) {
        action = 'DCA_SWAP'
        console.log('[strategy] Exploratory trade triggered (random exploration)')
      }
      // Default: SKIP
      else {
        action = 'SKIP'
      }
    } else {
      // Classic DCA mode: use allocation deviation
      if (allocDev < -0.02 && score > buyThreshold) action = 'DCA_SWAP'
      else if (allocDev > 0.04 && score > sellThreshold) action = 'SELL'
    }
  }

  // Stable-aware damping (only affects BUY into a stable target when strategy requests it via flag)
  // If the chosen target upstream is a stable (e.g., rotating into USDC), require higher conviction to avoid
  // always-buying safety. This is minimal and can be extended later when SELL path is enabled.
  try {
    const targetIsStable = String(features.targetSymbol || '').toUpperCase() === 'USDC'
    if (targetIsStable && action === 'DCA_SWAP') {
      // Require stronger signal: larger underweight or higher score
      if (!(allocDev < -0.05 && score > (buyThreshold + 0.06))) action = 'SKIP'
    }
  } catch {}

  // Base magnitude: different logic for multi-asset rotation vs classic DCA
  let rawMag: number
  let isExploratoryTrade = false
  
  if (allocUnknown) {
    // Check if this is an exploratory trade (low score/momentum)
    const timeSinceLastTrade = features.timeSinceLastTradeMins ?? 999
    const minTimeBetweenExploratoryTrades = Number(process.env.MIN_EXPLORATORY_TRADE_MINS || 0)
    isExploratoryTrade = action === 'DCA_SWAP' && score < 0.60 && timeSinceLastTrade > minTimeBetweenExploratoryTrades
    
    if (isExploratoryTrade) {
      // Exploratory: very small size (2-5%)
      rawMag = 0.03
    } else if (momentum) {
      // Multi-asset rotation: base size on momentum strength
      const momentumMag = Math.abs(momentum) * 8 // -0.01 momentum = 8% trade
      rawMag = Math.min(0.15, Math.max(0.05, momentumMag)) // 5% to 15%
    } else {
      rawMag = 0.05 // Default 5% if no momentum
    }
  } else {
    // Classic DCA: base on allocation deviation
    rawMag = Math.min(0.25, Math.max(0.04, Math.abs(allocDev)))
  }
  
  let volFactor = 1
  if (typeof hyperVol24h === 'number' && hyperVol24h > 0) {
    // Simple dampening: scale down size when vol > 0.5
    volFactor = Math.max(0.4, Math.min(1, 0.8 / (1 + (hyperVol24h - 0.2))))
  }
  
  // If test override, ensure a sensible minimum size
  const minSize = testForceAction ? 0.10 : (allocUnknown ? 0.03 : 0.0)
  // Multi-asset rotation: allow larger trades (up to 15%), exploratory smaller (up to 5%)
  const maxCap = isExploratoryTrade ? 0.05 : (allocUnknown ? 0.15 : 1)
  const magnitude = Math.min(maxCap, Math.max(minSize, rawMag * volFactor * sizeMultiplier))
  const sizePct = Number(magnitude.toFixed(4))
  // Risk: allocate ~ scaled positive combination (simulate volatility weighting if present)
  const executions = features.executionsLast24h || 0
  const vol = typeof features.volatilitySimple === 'number' ? features.volatilitySimple : 0
  const hyperVolComponent = hyperVol24h ? Math.min(20, hyperVol24h * 5) : 0
  // FIXED: Reduced execution penalty from *5 to *0.5 to avoid oversaturation
  const baseRisk = Math.min(100, Math.round((Math.abs(allocDev) * 50) + (vol * 10) + executions * 0.5 + hyperVolComponent))
  const riskScore = baseRisk
  const confidence = Number((0.5 + (score * 0.45)).toFixed(4)) // 0.5 -> 0.95
  const rationale = `score=${score.toFixed(4)} allocDev=${allocDev.toFixed(4)} action=${action} hyperVol24h=${hyperVol24h ?? 'null'} momentum=${momentum ?? 'null'}${testForceAction ? ` override=${testForceAction}` : ''}${allocUnknown ? ' allocUnknown=1' : ''}${isExploratoryTrade ? ' exploratory=1' : ''}`
  return { actionType: action, sizePct, rationale, riskScore, confidence, meta: { allocDev, executions, vol, score, hyperVol24h, momentum, profile, testForceAction: testForceAction || undefined, magnitude, sizeMultiplier, rawMag, volFactor, allocUnknown, isExploratoryTrade } }
}
