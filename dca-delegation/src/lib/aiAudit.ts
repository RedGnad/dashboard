import type { AiDecision } from './aiAgent'
import type { EnvioMetrics } from '../hooks/useEnvioMetrics'

export interface AuditRule {
  id: string
  name: string
  description: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  check: (decision: AiDecision, context: AuditContext) => AuditResult
}

export interface AuditContext {
  balances: Record<string, string>
  metrics: EnvioMetrics
  portfolioValueMon: number
  delegationExpired: boolean
  maxDailySpend: number
  allowedTokens: string[]
  maxSlippageBps: number
}

export interface AuditResult {
  passed: boolean
  message: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  recommendation?: string
}

export interface AuditReport {
  decision: AiDecision
  timestamp: number
  results: Array<AuditResult & { ruleId: string; ruleName: string }>
  overallStatus: 'PASS' | 'WARN' | 'FAIL'
  riskScore: number // 0-100
}

// Core audit rules for AI verification
export const AUDIT_RULES: AuditRule[] = [
  {
    id: 'delegation-valid',
    name: 'Delegation Validity',
    description: 'Ensure delegation is not expired',
    severity: 'critical',
    check: (_decision, context) => ({
      passed: !context.delegationExpired,
      message: context.delegationExpired ? 'Delegation has expired' : 'Delegation is valid',
      severity: 'critical',
      recommendation: context.delegationExpired ? 'Renew delegation before executing trades' : undefined
    })
  },
  
  {
    id: 'portfolio-balance',
    name: 'Portfolio Balance Check',
    description: 'Verify sufficient balance for the proposed action',
    severity: 'high',
    check: (decision, context) => {
      if (decision.action.type === 'BUY') {
        const sourceToken = decision.action.sourceToken
        const amount = parseFloat(decision.action.amount)
        const balance = parseFloat(context.balances[sourceToken] || '0')
        
        return {
          passed: balance >= amount,
          message: balance >= amount 
            ? `Sufficient ${sourceToken} balance (${balance.toFixed(4)})` 
            : `Insufficient ${sourceToken} balance (${balance.toFixed(4)} < ${amount.toFixed(4)})`,
          severity: 'high',
          recommendation: balance < amount ? `Reduce amount or top up ${sourceToken}` : undefined
        }
      }
      return { passed: true, message: 'Balance check not applicable', severity: 'low' }
    }
  },

  {
    id: 'amount-limits',
    name: 'Amount Limits',
    description: 'Check if amount is within reasonable portfolio percentage',
    severity: 'medium',
    check: (decision, context) => {
      if (decision.action.type === 'BUY') {
        const amount = parseFloat(decision.action.amount)
        const portfolioPercent = (amount / context.portfolioValueMon) * 100
        const maxPercent = 5 // 5% max per trade
        
        return {
          passed: portfolioPercent <= maxPercent,
          message: `Trade size: ${portfolioPercent.toFixed(2)}% of portfolio`,
          severity: portfolioPercent > maxPercent ? 'medium' : 'low',
          recommendation: portfolioPercent > maxPercent ? `Reduce amount to max ${maxPercent}% of portfolio` : undefined
        }
      }
      return { passed: true, message: 'Amount check not applicable', severity: 'low' }
    }
  },

  {
    id: 'token-whitelist',
    name: 'Token Whitelist',
    description: 'Verify target token is in allowed list',
    severity: 'high',
    check: (decision, context) => {
      if (decision.action.type === 'BUY') {
        const targetToken = decision.action.targetToken
        const allowed = context.allowedTokens.includes(targetToken)
        
        return {
          passed: allowed,
          message: allowed 
            ? `Token ${targetToken} is whitelisted` 
            : `Token ${targetToken} is not in whitelist`,
          severity: 'high',
          recommendation: !allowed ? 'Choose a whitelisted token or update token whitelist' : undefined
        }
      }
      return { passed: true, message: 'Token check not applicable', severity: 'low' }
    }
  },

  {
    id: 'whale-activity',
    name: 'Whale Activity Risk',
    description: 'Check for high whale activity that might affect trades',
    severity: 'medium',
    check: (decision, context) => {
      const whaleCount = context.metrics.whales24h.length
      const highActivity = whaleCount > 10
      
      if (decision.action.type === 'BUY' && highActivity) {
        return {
          passed: false,
          message: `High whale activity detected (${whaleCount} alerts)`,
          severity: 'medium',
          recommendation: 'Consider waiting or reducing position size during high whale activity'
        }
      }
      
      return {
        passed: true,
        message: `Whale activity normal (${whaleCount} alerts)`,
        severity: 'low'
      }
    }
  },

  {
    id: 'daily-spend-limit',
    name: 'Daily Spend Limit',
    description: 'Ensure daily spending does not exceed limits',
    severity: 'medium',
    check: (decision, context) => {
      if (decision.action.type === 'BUY') {
        const amount = parseFloat(decision.action.amount)
        const dailySpent = context.metrics.feesTodayMon // Simplified - should track actual spend
        const totalSpend = dailySpent + amount
        
        return {
          passed: totalSpend <= context.maxDailySpend,
          message: `Daily spend: ${totalSpend.toFixed(4)}/${context.maxDailySpend} MON`,
          severity: totalSpend > context.maxDailySpend ? 'medium' : 'low',
          recommendation: totalSpend > context.maxDailySpend ? 'Reduce amount or wait until tomorrow' : undefined
        }
      }
      return { passed: true, message: 'Daily limit check not applicable', severity: 'low' }
    }
  },

  {
    id: 'market-conditions',
    name: 'Market Conditions',
    description: 'Assess market conditions for trade timing',
    severity: 'low',
    check: (decision, context) => {
      const txToday = context.metrics.txToday
      const lowActivity = txToday < 10
      
      if (decision.action.type === 'BUY' && lowActivity) {
        return {
          passed: true,
          message: `Low market activity (${txToday} tx today) - good for entry`,
          severity: 'low'
        }
      }
      
      return {
        passed: true,
        message: `Market activity: ${txToday} transactions today`,
        severity: 'low'
      }
    }
  }
]

export class AiAuditor {
  private auditHistory: AuditReport[] = []

  private rules: AuditRule[]
  
  constructor(rules: AuditRule[] = AUDIT_RULES) {
    this.rules = rules
  }

  audit(decision: AiDecision, context: AuditContext): AuditReport {
    const results = this.rules.map(rule => {
      const result = rule.check(decision, context)
      return {
        ...result,
        ruleId: rule.id,
        ruleName: rule.name
      }
    })

    // Calculate overall status and risk score
    const criticalFails = results.filter(r => !r.passed && r.severity === 'critical').length
    const highFails = results.filter(r => !r.passed && r.severity === 'high').length
    const mediumFails = results.filter(r => !r.passed && r.severity === 'medium').length

    let overallStatus: 'PASS' | 'WARN' | 'FAIL' = 'PASS'
    if (criticalFails > 0) overallStatus = 'FAIL'
    else if (highFails > 0) overallStatus = 'FAIL'
    else if (mediumFails > 0) overallStatus = 'WARN'

    // Risk score calculation (0-100)
    const riskScore = Math.min(100, 
      criticalFails * 40 + 
      highFails * 25 + 
      mediumFails * 15 + 
      results.filter(r => !r.passed && r.severity === 'low').length * 5
    )

    const report: AuditReport = {
      decision,
      timestamp: Date.now(),
      results,
      overallStatus,
      riskScore
    }

    this.auditHistory.unshift(report)
    this.auditHistory = this.auditHistory.slice(0, 50) // Keep last 50 audits

    return report
  }

  getAuditHistory(): AuditReport[] {
    return [...this.auditHistory]
  }

  getAuditStats(): { total: number, passed: number, warned: number, failed: number } {
    const total = this.auditHistory.length
    const passed = this.auditHistory.filter(r => r.overallStatus === 'PASS').length
    const warned = this.auditHistory.filter(r => r.overallStatus === 'WARN').length
    const failed = this.auditHistory.filter(r => r.overallStatus === 'FAIL').length

    return { total, passed, warned, failed }
  }

  // For swarm inference - export decision context for external validation
  exportDecisionContext(decision: AiDecision, context: AuditContext) {
    return {
      decision: {
        id: decision.id,
        personality: decision.personality,
        action: decision.action,
        confidence: decision.confidence,
        timestamp: decision.timestamp
      },
      context: {
        portfolioValue: context.portfolioValueMon,
        balances: context.balances,
        whaleAlerts: context.metrics.whales24h.length,
        txToday: context.metrics.txToday,
        feesToday: context.metrics.feesTodayMon
      },
      constraints: {
        maxDailySpend: context.maxDailySpend,
        allowedTokens: context.allowedTokens,
        maxSlippageBps: context.maxSlippageBps
      }
    }
  }
}

export const aiAuditor = new AiAuditor()
