import { useState, useCallback } from 'react'
import { aiAuditor, type AuditReport, type AuditContext } from '../lib/aiAudit'
import type { AiDecision } from '../lib/aiAgent'
import type { EnvioMetrics } from './useEnvioMetrics'
import { getTargetTokens } from '../lib/tokens'

export function useAiAudit() {
  const [auditHistory, setAuditHistory] = useState<AuditReport[]>(aiAuditor.getAuditHistory())
  const [isAuditing, setIsAuditing] = useState(false)

  const auditDecision = useCallback(async (
    decision: AiDecision,
    balances: Record<string, string>,
    metrics: EnvioMetrics,
    portfolioValueMon: number,
    delegationExpired: boolean,
    maxDailySpend: number = 1.0, // Default 1 MON per day
    maxSlippageBps: number = 500 // Default 5% slippage
  ): Promise<AuditReport> => {
    setIsAuditing(true)
    
    try {
      const context: AuditContext = {
        balances,
        metrics,
        portfolioValueMon,
        delegationExpired,
        maxDailySpend,
        allowedTokens: getTargetTokens().map(t => t.symbol),
        maxSlippageBps
      }

      const report = aiAuditor.audit(decision, context)
      setAuditHistory(aiAuditor.getAuditHistory())
      
      return report
    } finally {
      setIsAuditing(false)
    }
  }, [])

  const getAuditStats = useCallback(() => {
    return aiAuditor.getAuditStats()
  }, [auditHistory])

  const exportForSwarm = useCallback((decision: AiDecision, context: Omit<AuditContext, 'allowedTokens'>) => {
    const fullContext: AuditContext = {
      ...context,
      allowedTokens: getTargetTokens().map(t => t.symbol)
    }
    return aiAuditor.exportDecisionContext(decision, fullContext)
  }, [])

  return {
    auditHistory,
    isAuditing,
    auditDecision,
    getAuditStats,
    exportForSwarm
  }
}
