import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { appendAudit } from '../audit'
import { loadGuardrails, evaluateGuardrails } from '../guardrails'
import { runOnceForDelegator } from '../runner'

interface AiDecisionLine {
  action: string
  actionId: string
  rollingHash: string
  ts: number
  delegator: string
  aiRiskScore?: number
  aiConfidence?: number
  aiActionType?: string
  aiRationaleHash?: string
  featureHash?: string
  featureSchemaVersion?: number | null
  modelHash?: string
  inferenceProvider?: string
}

export interface ExecuteResult {
  ok: boolean
  correlationId: string
  status: 'blocked' | 'submitted' | 'noop'
  reason?: string
  userOperationHash?: string
  decisionRollingHash?: string
}

function readAuditLines(): AiDecisionLine[] {
  const file = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
  if (!fs.existsSync(file)) return []
  const raw = fs.readFileSync(file, 'utf8').trim()
  if (!raw) return []
  const out: AiDecisionLine[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try {
      const j = JSON.parse(line)
      if (j.action === 'ai_decision') out.push(j)
    } catch {}
  }
  return out
}

function pickDecision(rollingHash?: string): AiDecisionLine | null {
  const decisions = readAuditLines()
  if (!decisions.length) return null
  if (!rollingHash) return decisions[decisions.length - 1]
  return decisions.find(d => d.rollingHash === rollingHash) || null
}

interface ExecutionContextFetch {
  lastExecutionTs?: number
  executions24h: number
  spentUsd24h: number
}

function buildContextForDelegator(_delegator: string): ExecutionContextFetch {
  // Simplified: scan audit for execute in last 24h
  const file = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
  let lastExecutionTs: number | undefined
  let executions24h = 0
  const since = Date.now() - 24 * 60 * 60 * 1000
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim()
      if (raw) {
        for (const line of raw.split('\n')) {
          if (!line) continue
          try {
            const j = JSON.parse(line)
            // Count only successful submissions (presence of userOperationHash) toward rate limits & spacing
            if (j.action === 'execute' && j.userOperationHash) {
              if (!lastExecutionTs || j.ts > lastExecutionTs) lastExecutionTs = j.ts
              if (j.ts >= since) executions24h++
            }
          } catch {}
        }
      }
    } catch {}
  }
  return { lastExecutionTs, executions24h, spentUsd24h: 0 }
}

export async function executeFromDecision(opts: { rollingHash?: string; force?: boolean; delegator?: string }): Promise<ExecuteResult> {
  const correlationId = randomUUID()
  let decision = pickDecision(opts.rollingHash)
  if (opts.delegator) {
    const dlower = opts.delegator.toLowerCase()
    if (decision && decision.delegator?.toLowerCase() !== dlower) {
      // If a rollingHash was provided but mismatches delegator, force re-select within delegator scope
      if (opts.rollingHash) {
        decision = null
      } else {
        // No explicit rollingHash: choose last decision for this delegator instead
        const all = readAuditLines().filter(l => l.delegator?.toLowerCase() === dlower)
        decision = all.length ? all[all.length - 1] : null
      }
    } else if (!decision) {
      // No decision yet chosen: select last for delegator if any
      const all = readAuditLines().filter(l => l.delegator?.toLowerCase() === dlower)
      decision = all.length ? all[all.length - 1] : null
    }
    if (!decision) return { ok: false, correlationId, status: 'noop', reason: opts.rollingHash ? 'decision_not_found_for_delegator' : 'no_decision_for_delegator' }
    if (decision.delegator?.toLowerCase() !== dlower) return { ok: false, correlationId, status: 'noop', reason: 'decision_delegator_mismatch' }
  }
  if (!decision) return { ok: false, correlationId, status: 'noop', reason: 'no_decision' }
  const guardrails = loadGuardrails()
  const ctx = buildContextForDelegator(decision.delegator)
  const evalResult = evaluateGuardrails(guardrails, { risk: decision.aiRiskScore, confidence: decision.aiConfidence }, ctx)
  if (evalResult.blocked && !opts.force) {
    appendAudit({
      action: 'execute',
      ts: Date.now(),
      delegator: decision.delegator,
      delegate: '0x',
      role: 'orchestrator',
      structHash: '0x',
      digest: '0x',
      domainSeparator: '0x',
      caveatsRoot: '0x',
      salt: '0x',
      warnings: [evalResult.reason || 'guardrail_block'],
      signatureModel: 'UNKNOWN',
      aiRationaleHash: decision.aiRationaleHash,
      aiRiskScore: decision.aiRiskScore,
      aiConfidence: decision.aiConfidence,
      aiActionType: decision.aiActionType,
      featureHash: decision.featureHash,
      featureSchemaVersion: decision.featureSchemaVersion || undefined,
      modelHash: decision.modelHash,
      inferenceProvider: decision.inferenceProvider,
      runId: correlationId,
      // Link back to decision line for audit traceability
      decisionRollingHash: decision.rollingHash,
      guardrailReason: evalResult.reason,
    })
    return { ok: true, correlationId, status: 'blocked', reason: evalResult.reason, decisionRollingHash: decision.rollingHash }
  }
  // Respect AI SKIP decision
  if (decision.aiActionType === 'SKIP') {
    appendAudit({
      action: 'execute',
      ts: Date.now(),
      delegator: decision.delegator,
      delegate: '0x',
      role: 'orchestrator',
      structHash: '0x',
      digest: '0x',
      domainSeparator: '0x',
      caveatsRoot: '0x',
      salt: '0x',
      warnings: ['AI decided SKIP'],
      signatureModel: 'UNKNOWN',
      runId: correlationId,
      decisionRollingHash: decision.rollingHash,
      modelHash: decision.modelHash,
      inferenceProvider: decision.inferenceProvider,
    })
    return { ok: true, correlationId, status: 'noop', reason: 'ai_decided_skip', decisionRollingHash: decision.rollingHash }
  }
  // Trigger actual run
  let userOperationHash: string | undefined
  try {
    userOperationHash = await runOnceForDelegator(decision.delegator as any)
  } catch (e: any) {
    appendAudit({
      action: 'execute',
      ts: Date.now(),
      delegator: decision.delegator,
      delegate: '0x',
      role: 'orchestrator',
      structHash: '0x',
      digest: '0x',
      domainSeparator: '0x',
      caveatsRoot: '0x',
      salt: '0x',
      warnings: [e?.message || 'execution_failed'],
      signatureModel: 'UNKNOWN',
      runId: correlationId,
      decisionRollingHash: decision.rollingHash,
      modelHash: decision.modelHash,
      inferenceProvider: decision.inferenceProvider,
    })
    return { ok: false, correlationId, status: 'noop', reason: 'execution_failed', decisionRollingHash: decision.rollingHash }
  }
  appendAudit({
    action: 'execute',
    ts: Date.now(),
    delegator: decision.delegator,
    delegate: '0x',
    role: 'orchestrator',
    structHash: '0x',
    digest: '0x',
    domainSeparator: '0x',
    caveatsRoot: '0x',
    salt: '0x',
    warnings: [],
    signatureModel: 'UNKNOWN',
    runId: correlationId,
    userOperationHash,
    decisionRollingHash: decision.rollingHash,
    modelHash: decision.modelHash,
    inferenceProvider: decision.inferenceProvider,
  })
  return { ok: true, correlationId, status: 'submitted', userOperationHash, decisionRollingHash: decision.rollingHash }
}
