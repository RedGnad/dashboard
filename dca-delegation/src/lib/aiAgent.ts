import type { EnvioMetrics } from '../hooks/useEnvioMetrics'

export type AiPersonality = 'conservative' | 'balanced' | 'aggressive' | 'contrarian'

export type AiAction = 
  | { type: 'BUY', sourceToken: 'MON' | 'USDC', targetToken: string, amount: string, reasoning: string }
  | { type: 'SWAP', sourceToken: string, targetToken: string, amount: string, reasoning: string }
  | { type: 'HOLD', duration: number, reasoning: string }
  | { type: 'SELL_TO_MON', fromToken: string, amount: string, reasoning: string }
  | { type: 'SELL_TO_USDC', fromToken: string, amount: string, reasoning: string }

export interface AiDecision {
  id: string
  timestamp: number
  personality: AiPersonality
  action: AiAction
  context: {
    balances: Record<string, string>
    metrics: EnvioMetrics
    portfolioValueMon: number
  }
  nextInterval: number // seconds until next decision
  confidence: number
  executed: boolean
}

export interface TokenMetrics {
  token: string
  price: number
  priceChange24h: number
  volume24h: number
  volatility: number
  momentum: number
  liquidityScore: number
  trend: 'bullish' | 'bearish' | 'sideways'
}

export class AutonomousAiAgent {
  private apiKey: string
  private decisions: AiDecision[] = []
  private personality: AiPersonality = 'balanced'
  private enabled: boolean = false

  constructor() {
    this.apiKey = import.meta.env.VITE_OPENAI_API_KEY as string
    if (!this.apiKey) {
      throw new Error('VITE_OPENAI_API_KEY not configured')
    }
    this.loadState()
  }

  private loadState() {
    try {
      const stored = localStorage.getItem('ai-agent-state')
      if (stored) {
        const state = JSON.parse(stored)
        this.personality = state.personality || 'balanced'
        this.enabled = state.enabled || false
        this.decisions = state.decisions || []
      }
    } catch (e) {
      console.warn('Failed to load AI agent state', e)
    }
  }

  private saveState() {
    try {
      const state = {
        personality: this.personality,
        enabled: this.enabled,
        decisions: this.decisions.slice(0, 100) // Keep last 100 decisions
      }
      localStorage.setItem('ai-agent-state', JSON.stringify(state))
    } catch (e) {
      console.warn('Failed to save AI agent state', e)
    }
  }

  setPersonality(personality: AiPersonality) {
    this.personality = personality
    this.saveState()
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled
    this.saveState()
  }

  getPersonality(): AiPersonality {
    return this.personality
  }

  isEnabled(): boolean {
    return this.enabled
  }

  getDecisions(): AiDecision[] {
    return [...this.decisions]
  }

  private calculatePortfolioValue(balances: Record<string, string>): number {
    // Simple calculation: assume 1 MON = 1 unit, USDC stable, CHOG volatile
    const mon = parseFloat(balances.MON || '0')
    const wmon = parseFloat(balances.WMON || '0')
    const usdc = parseFloat(balances.USDC || '0') * 0.1 // Assume 1 USDC = 0.1 MON
    const chog = parseFloat(balances.CHOG || '0') * 0.001 // Assume 1 CHOG = 0.001 MON
    
    return mon + wmon + usdc + chog
  }

  private getPersonalityPrompt(personality: AiPersonality): string {
    switch (personality) {
      case 'conservative':
        return `You are a CONSERVATIVE DeFi trader. Priorities:
- Preserve capital above all
- Prefer stable assets (USDC) over volatile ones
- Use small position sizes (1-5% of portfolio per trade)
- Longer intervals between decisions (300-1800 seconds)
- Quick to sell to USDC during uncertainty
- Only buy when clear bullish signals`

      case 'aggressive':
        return `You are an AGGRESSIVE DeFi trader. Priorities:
- Maximize returns, accept higher risk
- Prefer volatile assets (CHOG) for higher upside
- Use larger position sizes (5-15% of portfolio per trade)
- Shorter intervals between decisions (60-300 seconds)
- Hold through volatility, sell to MON only on major reversals
- Buy on dips and momentum`

      case 'contrarian':
        return `You are a CONTRARIAN DeFi trader. Priorities:
- Buy when others are selling, sell when others are buying
- Look for oversold/overbought conditions
- Medium position sizes (3-8% of portfolio per trade)
- Medium intervals (180-600 seconds)
- Fade whale activity and high volume spikes
- Profit from market inefficiencies`

      default: // balanced
        return `You are a BALANCED DeFi trader. Priorities:
- Balance risk and reward
- Diversify between stable (USDC) and volatile (CHOG) assets
- Use moderate position sizes (2-8% of portfolio per trade)
- Adaptive intervals based on market conditions (120-900 seconds)
- Tactical allocation based on momentum and volatility
- Risk management with stop-losses to USDC`
    }
  }

  async makeDecision(
    balances: Record<string, string>,
    metrics: EnvioMetrics,
    tokenMetrics?: TokenMetrics[]
  ): Promise<AiDecision> {
    if (!this.enabled) {
      throw new Error('AI agent is disabled')
    }

    const portfolioValue = this.calculatePortfolioValue(balances)
    const personalityPrompt = this.getPersonalityPrompt(this.personality)
    
    const prompt = this.buildDecisionPrompt(balances, metrics, portfolioValue, personalityPrompt, tokenMetrics)
    
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content: `You are an autonomous DeFi trading AI agent. You make real trading decisions for a DCA bot on Monad testnet. Always respond with valid JSON only. ${personalityPrompt}`
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.4,
          max_tokens: 800,
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

      const decision = this.parseDecision(content, balances, metrics, portfolioValue)
      this.decisions.unshift(decision)
      this.saveState()
      
      return decision
    } catch (error) {
      console.error('AI decision failed:', error)
      return this.getFallbackDecision(balances, metrics, portfolioValue)
    }
  }

  private buildDecisionPrompt(
    balances: Record<string, string>,
    metrics: EnvioMetrics,
    portfolioValue: number,
    personalityPrompt: string,
    tokenMetrics?: TokenMetrics[]
  ): string {
    const whaleActivity = metrics.whales24h.length > 10 ? 'HIGH' : metrics.whales24h.length > 5 ? 'MEDIUM' : 'LOW'
    const marketActivity = metrics.txToday > 50 ? 'HIGH' : metrics.txToday > 20 ? 'MEDIUM' : 'LOW'
    
    return `
CURRENT PORTFOLIO:
- MON: ${balances.MON}
- WMON: ${balances.WMON}  
- USDC: ${balances.USDC}
- CHOG: ${balances.CHOG}
- Total Value: ${portfolioValue.toFixed(4)} MON

MARKET CONDITIONS:
- Transactions Today: ${metrics.txToday} (${marketActivity} activity)
- Whale Alerts 24h: ${metrics.whales24h.length} (${whaleActivity} whale activity)
- Network Fees: ${metrics.feesTodayMon.toFixed(6)} MON

${tokenMetrics ? `TOKEN METRICS:
${tokenMetrics.map(tm => `- ${tm.token}: Price ${tm.price.toFixed(6)}, Change 24h: ${tm.priceChange24h.toFixed(2)}%, Volume: ${tm.volume24h.toFixed(2)}, Trend: ${tm.trend}`).join('\n')}` : ''}

PERSONALITY: ${this.personality.toUpperCase()}
${personalityPrompt}

DECISION REQUIRED:
Choose ONE action for the next DCA execution. Consider portfolio balance, market conditions, and your personality.

CONSTRAINTS:
- Amount: 0.5-15% of portfolio value (${(portfolioValue * 0.005).toFixed(4)}-${(portfolioValue * 0.15).toFixed(4)} MON)
- Next interval: 60-1800 seconds (be reasonable)
- Source tokens (to spend): MON (native), USDC (stable), or ANY volatile token for swaps
- Target tokens (to buy): WMON, BEAN, CHOG, DAK, YAKI, WBTC, DAKIMAKURA, USDC
- Available actions: BUY (spend source to get target), SWAP (volatile→volatile), HOLD (wait), SELL_TO_MON (convert to native), SELL_TO_USDC (safe haven)

DECISION LOGIC:
- Choose source token based on available balance (MON or USDC)
- Choose target token based on market analysis and personality
- Consider portfolio diversification and risk management

Respond with JSON only:
{
  "action": {
    "type": "BUY|SWAP|HOLD|SELL_TO_MON|SELL_TO_USDC",
    "sourceToken": "MON|USDC",
    "targetToken": "WMON|BEAN|CHOG|DAK|YAKI|WBTC|DAKIMAKURA",
    "amount": "0.05",
    "reasoning": "Market analysis and decision rationale"
  },
  "nextInterval": 300,
  "confidence": 0.8
}
`
  }

  private parseDecision(
    content: string,
    balances: Record<string, string>,
    metrics: EnvioMetrics,
    portfolioValue: number
  ): AiDecision {
    try {
      const cleaned = content.replace(/```json\n?|\n?```/g, '').trim()
      const parsed = JSON.parse(cleaned)
      
      const action: AiAction = {
        type: parsed.action.type,
        ...(parsed.action.type === 'BUY' && { 
          sourceToken: parsed.action.sourceToken,
          targetToken: parsed.action.targetToken,
          amount: String(parsed.action.amount)
        }),
        ...(parsed.action.type === 'SELL_TO_MON' && { 
          fromToken: parsed.action.fromToken || parsed.action.targetToken,
          amount: String(parsed.action.amount)
        }),
        ...(parsed.action.type === 'SELL_TO_USDC' && { 
          fromToken: parsed.action.fromToken || parsed.action.targetToken,
          amount: String(parsed.action.amount)
        }),
        ...(parsed.action.type === 'HOLD' && { duration: parsed.nextInterval }),
        reasoning: String(parsed.action.reasoning || 'AI decision completed')
      } as AiAction

      // Validate and clamp values
      const nextInterval = Math.max(60, Math.min(1800, Number(parsed.nextInterval || 300)))
      const confidence = Math.max(0, Math.min(1, Number(parsed.confidence || 0.5)))

      return {
        id: `ai_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: Date.now(),
        personality: this.personality,
        action,
        context: { balances, metrics, portfolioValueMon: portfolioValue },
        nextInterval,
        confidence,
        executed: false
      }
    } catch (e) {
      console.warn('Failed to parse AI decision, using fallback', e)
      throw new Error('Invalid AI response format')
    }
  }

  private getFallbackDecision(
    balances: Record<string, string>,
    metrics: EnvioMetrics,
    portfolioValue: number
  ): AiDecision {
    const whaleActivity = metrics.whales24h.length
    const monBalance = parseFloat(balances.MON)
    
    // Conservative fallback logic
    let action: AiAction
    if (whaleActivity > 10) {
      // High whale activity - go to safety
      action = {
        type: 'SELL_TO_USDC',
        fromToken: 'CHOG',
        amount: (portfolioValue * 0.02).toFixed(4),
        reasoning: 'Fallback: High whale activity detected, moving to safety'
      }
    } else if (monBalance > portfolioValue * 0.8) {
      // Too much MON - diversify
      action = {
        type: 'BUY',
        sourceToken: 'MON',
        targetToken: 'USDC',
        amount: (portfolioValue * 0.05).toFixed(4),
        reasoning: 'Fallback: Portfolio too concentrated in MON, diversifying to USDC'
      }
    } else {
      // Default hold
      action = {
        type: 'HOLD',
        duration: 600,
        reasoning: 'Fallback: Uncertain conditions, holding position'
      }
    }

    return {
      id: `ai_fallback_${Date.now()}`,
      timestamp: Date.now(),
      personality: this.personality,
      action,
      context: { balances, metrics, portfolioValueMon: portfolioValue },
      nextInterval: 600,
      confidence: 0.3,
      executed: false
    }
  }

  markDecisionExecuted(decisionId: string) {
    const decision = this.decisions.find(d => d.id === decisionId)
    if (decision) {
      decision.executed = true
      this.saveState()
    }
  }
}

export const autonomousAiAgent = new AutonomousAiAgent()
