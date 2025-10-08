import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { appendAudit } from './audit'

// Guardrails v2 adds: volatility drift detection, stale feature age detection, feature hash mismatch.
// Backward compatible with v1 config. Additional runtime inputs drive v2 soft/hard warnings.

export interface GuardrailsConfig {
  maxRiskScore: number
  minConfidence: number
  dailyCapUsd: number
  minMinutesBetweenExec: number
  maxExecutionsPer24h: number
  // v2 tuning (optional; default conservative)
  maxVolatilityDrift?: number // absolute difference allowed between latest volatility feature and prior decision's volatilitySimple
  maxFeatureAgeMs?: number    // how old feature set (asOfTs) can be vs now before stale
  hashMismatchHardBlock?: boolean // if true, featureHash mismatch = blocked; else warn only
  blockOnAbnormalHyperIndex?: boolean // NEW: block if abnormalTransferFlag / hyper abnormal metric present
}

let cached: GuardrailsConfig | null = null
let loadedAt = 0
let cachedHash: string | null = null

const FILE = path.join(process.cwd(), 'config', 'guardrails.json')

const DEFAULTS: GuardrailsConfig = {
  maxRiskScore: 80,
  minConfidence: 0.5,
  dailyCapUsd: 500,
  minMinutesBetweenExec: 15,
  maxExecutionsPer24h: 24,
  maxVolatilityDrift: 0.35, // allow moderate drift (model risk scale 0-2)
  maxFeatureAgeMs: 5 * 60_000, // 5 minutes
  hashMismatchHardBlock: true,
  blockOnAbnormalHyperIndex: true,
}

export function loadGuardrails(force = false): GuardrailsConfig {
  const now = Date.now()
  if (!force && cached && now - loadedAt < 30_000) return cached
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
      cached = { ...DEFAULTS, ...raw }
    } else cached = { ...DEFAULTS }
  } catch {
    cached = { ...DEFAULTS }
  }
  loadedAt = now
  // Compute stable hash (sorted JSON)
  try {
    const stable = JSON.stringify(Object.keys(cached!).sort().reduce((acc,k)=>{(acc as any)[k]=(cached as any)[k];return acc},{} as any))
    const h = createHash('sha256').update(stable).digest('hex')
    if (h !== cachedHash) {
      const prev = cachedHash
      cachedHash = h
      appendAudit({
        action: 'guardrails_config',
        ts: Date.now(),
        role: 'system',
        prevConfigHash: prev ? '0x'+prev : undefined,
        configHash: '0x'+h,
        config: cached,
      } as any)
    }
  } catch {}
  return cached!
}

export function getGuardrailsConfigHash(): string | null { return cachedHash ? '0x'+cachedHash : null }

export interface ExecutionContextSummary {
  lastExecutionTs?: number
  executions24h: number
  spentUsd24h: number
  // v2 context additions
  lastDecisionFeatureHash?: string
  lastDecisionFeatureHashV2?: string
  lastDecisionVolatilitySimple?: number
}

export interface GuardrailEvaluation {
  blocked: boolean
  reason?: string
  warnings: string[]
  info: Record<string, any>
  reasonsAll?: string[]
}

export interface EvaluateV2Inputs {
  ai: { risk?: number; confidence?: number }
  ctx: ExecutionContextSummary
  features?: { featureHash?: string; featureHashV2?: string; asOfTs?: number; volatilitySimple?: number }
  hyper?: { abnormalTransferFlag?: number | boolean }
}

export function evaluateGuardrails(gr: GuardrailsConfig, ai: { risk?: number; confidence?: number }, ctx: ExecutionContextSummary): GuardrailEvaluation {
  const { blocked, reason } = legacyEvaluate(gr, ai, ctx)
  return { blocked, reason, warnings: [], info: {} }
}

function legacyEvaluate(gr: GuardrailsConfig, ai: { risk?: number; confidence?: number }, ctx: ExecutionContextSummary): { blocked: boolean; reason?: string } {
  if (typeof ai.risk === 'number' && ai.risk > gr.maxRiskScore) return { blocked: true, reason: 'risk_score_exceeds_max' }
  if (typeof ai.confidence === 'number' && ai.confidence < gr.minConfidence) return { blocked: true, reason: 'confidence_below_min' }
  if (ctx.executions24h >= gr.maxExecutionsPer24h) return { blocked: true, reason: 'max_exec_24h_reached' }
  if (ctx.spentUsd24h + 0 > gr.dailyCapUsd) return { blocked: true, reason: 'daily_cap_reached' }
  if (ctx.lastExecutionTs) {
    const diffMin = (Date.now() - ctx.lastExecutionTs) / 60000
    if (diffMin < gr.minMinutesBetweenExec) return { blocked: true, reason: 'min_spacing_not_elapsed' }
  }
  return { blocked: false }
}

// New v2 evaluation merging legacy blocking conditions + soft/hard checks.
export function evaluateGuardrailsV2(gr: GuardrailsConfig, inputs: EvaluateV2Inputs): GuardrailEvaluation {
  const legacy = legacyEvaluate(gr, inputs.ai, inputs.ctx)
  const warnings: string[] = []
  let blocked = legacy.blocked
  let reason = legacy.reason
  const info: Record<string, any> = {}
  const feat = inputs.features || {}
  const now = Date.now()

  // Stale feature detection
  if (feat.asOfTs && gr.maxFeatureAgeMs) {
    const ageMs = now - feat.asOfTs
    info.featureAgeMs = ageMs
    if (ageMs > gr.maxFeatureAgeMs) {
      warnings.push('features_stale')
      // Do not block; observability first. Could escalate to block if extremely stale (> 6h) in future.
    }
  }
  // Volatility drift detection
  if (typeof feat.volatilitySimple === 'number' && typeof inputs.ctx.lastDecisionVolatilitySimple === 'number' && typeof gr.maxVolatilityDrift === 'number') {
    const drift = Math.abs(feat.volatilitySimple - inputs.ctx.lastDecisionVolatilitySimple)
    info.volatilityDrift = drift
    if (drift > gr.maxVolatilityDrift) {
      warnings.push('volatility_drift_exceeds_threshold')
    }
  }
  // Feature hash mismatch detection (protect against silent feature pipeline change)
  if (feat.featureHash && inputs.ctx.lastDecisionFeatureHash && feat.featureHash !== inputs.ctx.lastDecisionFeatureHash) {
    warnings.push('feature_hash_mismatch')
    if (gr.hashMismatchHardBlock) { blocked = true; reason = reason || 'feature_hash_mismatch' }
  }
  if (feat.featureHashV2 && inputs.ctx.lastDecisionFeatureHashV2 && feat.featureHashV2 !== inputs.ctx.lastDecisionFeatureHashV2) {
    warnings.push('feature_hash_v2_mismatch')
    if (gr.hashMismatchHardBlock) { blocked = true; reason = reason || 'feature_hash_v2_mismatch' }
  }
  // HyperIndex abnormal flag
  if (gr.blockOnAbnormalHyperIndex && inputs.hyper && (inputs.hyper.abnormalTransferFlag === 1 || inputs.hyper.abnormalTransferFlag === true)) {
    blocked = true
    reason = reason || 'abnormal_hyperindex_activity'
    warnings.push('abnormal_hyperindex_activity')
  }
  // Escalation: if abnormal activity present (in warnings) and current reason is a feature hash mismatch,
  // promote abnormal_hyperindex_activity to primary reason so downstream auto-revoke logic can detect the root cause.
  if (warnings.includes('abnormal_hyperindex_activity') && reason && (reason === 'feature_hash_mismatch' || reason === 'feature_hash_v2_mismatch')) {
    reason = 'abnormal_hyperindex_activity'
  }
  // Aggregate all distinct reasons (primary + warnings)
  const reasonsAll = Array.from(new Set([reason, ...warnings].filter(Boolean))) as string[]
  return { blocked, reason, warnings, info, reasonsAll }
}

