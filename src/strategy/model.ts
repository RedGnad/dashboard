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
  // Basic thresholds
  let action: DecisionMapping['actionType'] = 'SKIP'
  if (allocDev < -0.03 && score > 0.58) action = 'DCA_SWAP'
  else if (allocDev > 0.05 && score > 0.60) action = 'SELL'

  const magnitude = Math.min(0.25, Math.max(0.05, Math.abs(allocDev))) // 5% - 25%
  const sizePct = Number(magnitude.toFixed(4))
  // Risk: allocate ~ scaled positive combination (simulate volatility weighting if present)
  const executions = features.executionsLast24h || 0
  const vol = typeof features.volatilitySimple === 'number' ? features.volatilitySimple : 0
  const baseRisk = Math.min(100, Math.round((Math.abs(allocDev) * 50) + (vol * 10) + executions * 5))
  const riskScore = baseRisk
  const confidence = Number((0.5 + (score * 0.45)).toFixed(4)) // 0.5 -> 0.95
  const rationale = `score=${score.toFixed(4)} allocDev=${allocDev.toFixed(4)} action=${action}`
  return { actionType: action, sizePct, rationale, riskScore, confidence, meta: { allocDev, executions, vol, score } }
}
