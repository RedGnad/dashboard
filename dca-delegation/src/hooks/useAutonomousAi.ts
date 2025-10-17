import { useState, useCallback, useEffect } from 'react'
import { autonomousAiAgent, type AiPersonality, type AiDecision } from '../lib/aiAgent'
import type { EnvioMetrics } from './useEnvioMetrics'
import type { TokenMetrics } from '../lib/aiAgent'

export function useAutonomousAi() {
  const [personality, setPersonalityState] = useState<AiPersonality>(autonomousAiAgent.getPersonality())
  const [enabled, setEnabledState] = useState<boolean>(autonomousAiAgent.isEnabled())
  const [decisions, setDecisions] = useState<AiDecision[]>(autonomousAiAgent.getDecisions())
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Sync with agent state
  useEffect(() => {
    const interval = setInterval(() => {
      setDecisions(autonomousAiAgent.getDecisions())
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  const setPersonality = useCallback((newPersonality: AiPersonality) => {
    autonomousAiAgent.setPersonality(newPersonality)
    setPersonalityState(newPersonality)
  }, [])

  const setEnabled = useCallback((newEnabled: boolean) => {
    autonomousAiAgent.setEnabled(newEnabled)
    setEnabledState(newEnabled)
  }, [])

  const makeDecision = useCallback(async (
    balances: Record<string, string>,
    metrics: EnvioMetrics,
    tokenMetrics?: TokenMetrics[]
  ): Promise<AiDecision | null> => {
    if (!enabled) {
      return null
    }

    setIsProcessing(true)
    setError(null)

    try {
      const decision = await autonomousAiAgent.makeDecision(balances, metrics, tokenMetrics)
      setDecisions(autonomousAiAgent.getDecisions())
      return decision
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'AI decision failed'
      setError(errorMsg)
      return null
    } finally {
      setIsProcessing(false)
    }
  }, [enabled])

  const markExecuted = useCallback((decisionId: string) => {
    autonomousAiAgent.markDecisionExecuted(decisionId)
    setDecisions(autonomousAiAgent.getDecisions())
  }, [])

  const getLatestDecision = useCallback((): AiDecision | null => {
    const unexecutedDecisions = decisions.filter(d => !d.executed)
    return unexecutedDecisions[0] || null
  }, [decisions])

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  return {
    personality,
    enabled,
    decisions,
    isProcessing,
    error,
    setPersonality,
    setEnabled,
    makeDecision,
    markExecuted,
    getLatestDecision,
    clearError,
  }
}
