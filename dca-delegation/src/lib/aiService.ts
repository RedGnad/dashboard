import type { EnvioMetrics } from '../hooks/useEnvioMetrics'

export interface AiSuggestion {
  amount: string
  token: 'USDC' | 'CHOG'
  intervalSeconds: number
  reasoning: string
  confidence: number
  riskLevel: 'low' | 'medium' | 'high'
}

export interface AiDecision {
  id: string
  timestamp: number
  suggestion: AiSuggestion
  context: {
    balances: Record<string, string>
    metrics: EnvioMetrics
    currentDcaActive: boolean
  }
  status: 'pending' | 'approved' | 'rejected'
  userFeedback?: string
}

export class AiService {
  private apiKey: string
  private decisions: AiDecision[] = []

  constructor() {
    this.apiKey = import.meta.env.VITE_OPENAI_API_KEY as string
    if (!this.apiKey) {
      throw new Error('VITE_OPENAI_API_KEY not configured')
    }
    this.loadDecisions()
  }

  private loadDecisions() {
    try {
      const stored = localStorage.getItem('ai-decisions')
      if (stored) {
        this.decisions = JSON.parse(stored)
      }
    } catch (e) {
      console.warn('Failed to load AI decisions from localStorage', e)
    }
  }

  private saveDecisions() {
    try {
      localStorage.setItem('ai-decisions', JSON.stringify(this.decisions))
    } catch (e) {
      console.warn('Failed to save AI decisions to localStorage', e)
    }
  }

  async generateSuggestion(
    balances: Record<string, string>,
    metrics: EnvioMetrics,
    currentDcaActive: boolean
  ): Promise<AiSuggestion> {
    const prompt = this.buildPrompt(balances, metrics, currentDcaActive)
    
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'You are a DeFi trading AI assistant specializing in Dollar Cost Averaging (DCA) strategies on Monad testnet. Analyze market data and user portfolio to suggest optimal DCA parameters. Always respond with valid JSON only.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.3,
          max_tokens: 500,
        }),
      })

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`)
      }

      const data = await response.json()
      const content = data.choices[0]?.message?.content

      if (!content) {
        throw new Error('No response from OpenAI')
      }

      return this.parseSuggestion(content)
    } catch (error) {
      console.error('AI suggestion failed:', error)
      return this.getFallbackSuggestion(balances, metrics)
    }
  }

  private buildPrompt(
    balances: Record<string, string>,
    metrics: EnvioMetrics,
    currentDcaActive: boolean
  ): string {
    return `
PORTFOLIO ANALYSIS:
- MON Balance: ${balances.MON}
- USDC Balance: ${balances.USDC}
- WMON Balance: ${balances.WMON}
- CHOG Balance: ${balances.CHOG}

MARKET METRICS (24h):
- Transactions Today: ${metrics.txToday}
- Fees Paid (MON): ${metrics.feesTodayMon.toFixed(6)}
- Whale Alerts: ${metrics.whales24h.length}

DCA STATUS:
- Currently Active: ${currentDcaActive}

TASK: Suggest optimal DCA parameters for MON -> token swaps.

CONSTRAINTS:
- Amount: 0.01-1.0 MON per execution
- Tokens: USDC (stable) or CHOG (volatile)
- Interval: 30-3600 seconds
- Consider whale activity (high = reduce frequency)
- Consider transaction volume (low = increase interval)

Respond with JSON only:
{
  "amount": "0.05",
  "token": "USDC",
  "intervalSeconds": 300,
  "reasoning": "Market analysis summary",
  "confidence": 0.8,
  "riskLevel": "medium"
}
`
  }

  private parseSuggestion(content: string): AiSuggestion {
    try {
      const cleaned = content.replace(/```json\n?|\n?```/g, '').trim()
      const parsed = JSON.parse(cleaned)
      
      return {
        amount: String(parsed.amount || '0.05'),
        token: parsed.token === 'CHOG' ? 'CHOG' : 'USDC',
        intervalSeconds: Math.max(30, Math.min(3600, Number(parsed.intervalSeconds || 300))),
        reasoning: String(parsed.reasoning || 'AI analysis completed'),
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0.5))),
        riskLevel: ['low', 'medium', 'high'].includes(parsed.riskLevel) ? parsed.riskLevel : 'medium'
      }
    } catch (e) {
      console.warn('Failed to parse AI response, using fallback', e)
      throw new Error('Invalid AI response format')
    }
  }

  private getFallbackSuggestion(
    balances: Record<string, string>,
    metrics: EnvioMetrics
  ): AiSuggestion {
    const monBalance = parseFloat(balances.MON)
    const whaleActivity = metrics.whales24h.length
    
    // Simple heuristics
    const amount = monBalance > 1 ? '0.1' : '0.05'
    const token = whaleActivity > 5 ? 'USDC' : 'CHOG' // Stable during high whale activity
    const intervalSeconds = whaleActivity > 10 ? 600 : 300 // Slower during high activity
    
    return {
      amount,
      token,
      intervalSeconds,
      reasoning: 'Fallback analysis: Conservative approach based on portfolio size and whale activity',
      confidence: 0.6,
      riskLevel: 'medium'
    }
  }

  createDecision(
    suggestion: AiSuggestion,
    balances: Record<string, string>,
    metrics: EnvioMetrics,
    currentDcaActive: boolean
  ): AiDecision {
    const decision: AiDecision = {
      id: `ai_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      suggestion,
      context: { balances, metrics, currentDcaActive },
      status: 'pending'
    }
    
    this.decisions.unshift(decision)
    this.decisions = this.decisions.slice(0, 50) // Keep last 50 decisions
    this.saveDecisions()
    
    return decision
  }

  approveDecision(decisionId: string, feedback?: string): boolean {
    const decision = this.decisions.find(d => d.id === decisionId)
    if (decision) {
      decision.status = 'approved'
      decision.userFeedback = feedback
      this.saveDecisions()
      return true
    }
    return false
  }

  rejectDecision(decisionId: string, feedback?: string): boolean {
    const decision = this.decisions.find(d => d.id === decisionId)
    if (decision) {
      decision.status = 'rejected'
      decision.userFeedback = feedback
      this.saveDecisions()
      return true
    }
    return false
  }

  getDecisions(): AiDecision[] {
    return [...this.decisions]
  }

  getLatestDecision(): AiDecision | null {
    return this.decisions[0] || null
  }
}

export const aiService = new AiService()
