import fs from 'node:fs'
import path from 'node:path'

export interface GuardrailsConfig {
  maxRiskScore: number
  minConfidence: number
  dailyCapUsd: number
  minMinutesBetweenExec: number
  maxExecutionsPer24h: number
}

let cached: GuardrailsConfig | null = null
let loadedAt = 0

const FILE = path.join(process.cwd(), 'config', 'guardrails.json')

const DEFAULTS: GuardrailsConfig = {
  maxRiskScore: 80,
  minConfidence: 0.5,
  dailyCapUsd: 500,
  minMinutesBetweenExec: 15,
  maxExecutionsPer24h: 24,
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
  return cached!
}

export interface ExecutionContextSummary {
  lastExecutionTs?: number
  executions24h: number
  spentUsd24h: number
}

export interface GuardrailEvaluation {
  blocked: boolean
  reason?: string
}

export function evaluateGuardrails(gr: GuardrailsConfig, ai: { risk?: number; confidence?: number }, ctx: ExecutionContextSummary): GuardrailEvaluation {
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
