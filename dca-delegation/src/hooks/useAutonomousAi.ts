import { useState, useCallback, useEffect } from 'react'
import { autonomousAiAgent, type AiPersonality, type AiDecision, type AiProvider } from '../lib/aiAgent'
import type { EnvioMetrics } from './useEnvioMetrics'
import type { TokenMetrics } from '../lib/aiAgent'

export function useAutonomousAi() {
  const [personality, setPersonalityState] = useState<AiPersonality>(autonomousAiAgent.getPersonality())
  const [enabled, setEnabledState] = useState<boolean>(autonomousAiAgent.isEnabled())
  const [decisions, setDecisions] = useState<AiDecision[]>(autonomousAiAgent.getDecisions())
  const [provider, setProviderState] = useState<AiProvider>(autonomousAiAgent.getProvider())
  const [modelId, setModelIdState] = useState<string>(autonomousAiAgent.getModelId())
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modelAvailable, setModelAvailable] = useState<boolean | null>(null)
  const [testingModel, setTestingModel] = useState(false)

  // Sync with agent state
  useEffect(() => {
    const interval = setInterval(() => {
      const list = autonomousAiAgent.getDecisions()
      const now = Date.now()
      for (const d of list) {
        if (!d.executed && d.action.type === 'HOLD') {
          const dur = (d.action as any).duration ?? d.nextInterval
          const ms = (Number(dur) || 0) * 1000
          if (ms > 0 && now - d.timestamp >= ms) {
            autonomousAiAgent.markDecisionExecuted(d.id)
          }
        }
      }
      setDecisions(autonomousAiAgent.getDecisions())
      // Keep personality in sync across components
      const p = autonomousAiAgent.getPersonality()
      setPersonalityState(p)
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  // React to personality changes dispatched elsewhere
  useEffect(() => {
    function onPersonality(ev: any) {
      const p = ev?.detail
      if (p) setPersonalityState(p)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('ai:personality', onPersonality as any)
      return () => window.removeEventListener('ai:personality', onPersonality as any)
    }
  }, [])

  const setPersonality = useCallback((newPersonality: AiPersonality) => {
    autonomousAiAgent.setPersonality(newPersonality)
    setPersonalityState(newPersonality)
    try {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('ai:personality', { detail: newPersonality }))
      }
    } catch {}
  }, [])

  const setEnabled = useCallback((newEnabled: boolean) => {
    autonomousAiAgent.setEnabled(newEnabled)
    setEnabledState(newEnabled)
  }, [])

  const setProvider = useCallback((p: AiProvider) => {
    autonomousAiAgent.setProvider(p)
    setProviderState(p)
  }, [])

  const setModelId = useCallback((m: string) => {
    autonomousAiAgent.setModelId(m)
    setModelIdState(m)
  }, [])

  const testModel = useCallback(async () => {
    setTestingModel(true)
    try {
      const ok = await (autonomousAiAgent as any).testModelAvailability()
      setModelAvailable(ok)
      return ok
    } finally {
      setTestingModel(false)
    }
  }, [])

  // Auto-test on provider/model change (debounced light)
  useEffect(() => {
    let id: any
    if (provider === 'openai' && modelId) {
      id = setTimeout(() => { void testModel() }, 300)
    } else {
      setModelAvailable(null)
    }
    return () => id && clearTimeout(id)
  }, [provider, modelId, testModel])

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
    provider,
    modelId,
    modelAvailable,
    testingModel,
    isProcessing,
    error,
    setPersonality,
    setEnabled,
    setProvider,
    setModelId,
    testModel,
    makeDecision,
    markExecuted,
    getLatestDecision,
    clearError,
  }
}
