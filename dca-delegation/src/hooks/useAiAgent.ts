import { useState, useCallback, useEffect } from 'react'
import { aiService, type AiSuggestion, type AiDecision } from '../lib/aiService'
import type { EnvioMetrics } from './useEnvioMetrics'

export function useAiAgent() {
  const [isGenerating, setIsGenerating] = useState(false)
  const [currentSuggestion, setCurrentSuggestion] = useState<AiSuggestion | null>(null)
  const [decisions, setDecisions] = useState<AiDecision[]>([])
  const [error, setError] = useState<string | null>(null)

  // Load decisions on mount
  useEffect(() => {
    setDecisions(aiService.getDecisions())
  }, [])

  const generateSuggestion = useCallback(async (
    balances: Record<string, string>,
    metrics: EnvioMetrics,
    currentDcaActive: boolean
  ) => {
    setIsGenerating(true)
    setError(null)
    
    try {
      const suggestion = await aiService.generateSuggestion(balances, metrics, currentDcaActive)
      setCurrentSuggestion(suggestion)
      
      // Create decision record
      aiService.createDecision(suggestion, balances, metrics, currentDcaActive)
      setDecisions(aiService.getDecisions())
      
      return suggestion
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'AI generation failed'
      setError(errorMsg)
      throw err
    } finally {
      setIsGenerating(false)
    }
  }, [])

  const approveDecision = useCallback((decisionId: string, feedback?: string) => {
    const success = aiService.approveDecision(decisionId, feedback)
    if (success) {
      setDecisions(aiService.getDecisions())
    }
    return success
  }, [])

  const rejectDecision = useCallback((decisionId: string, feedback?: string) => {
    const success = aiService.rejectDecision(decisionId, feedback)
    if (success) {
      setDecisions(aiService.getDecisions())
    }
    return success
  }, [])

  const clearSuggestion = useCallback(() => {
    setCurrentSuggestion(null)
    setError(null)
  }, [])

  return {
    isGenerating,
    currentSuggestion,
    decisions,
    error,
    generateSuggestion,
    approveDecision,
    rejectDecision,
    clearSuggestion,
  }
}
