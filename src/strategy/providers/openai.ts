import { InferenceProvider, InferenceRequest, InferenceResponse } from './types'
import { keccak256 } from 'viem'

export class OpenAIProvider implements InferenceProvider {
  private apiKey: string
  private model: string
  constructor(opts?: { apiKey?: string; model?: string }) {
    this.apiKey = opts?.apiKey || process.env.OPENAI_API_KEY || ''
    this.model = opts?.model || process.env.OPENAI_MODEL || 'gpt-4o-mini'
  }
  name() { return 'openai' }
  async run(req: InferenceRequest): Promise<InferenceResponse> {
    if (!this.apiKey) throw new Error('openai_api_key_missing')
    // Compute a canonical inference proof hash similar to OG flow
    const canonical = {
      provider: this.name(),
      version: 'openai-v1',
      modelId: this.model,
      featureHashV2: req.featureHashV2 || null,
      delegator: req.delegator,
      ts: req.timestamp,
    }
    const enc = new TextEncoder().encode(JSON.stringify(canonical))
    let hex = '0x'; for (const b of enc) hex += b.toString(16).padStart(2, '0')
    const inferenceProofHash = keccak256(hex as `0x${string}`)
    const prompt = this.buildPrompt(req)
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: 'You are an expert trading assistant. Answer with a concise JSON only.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    }
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`openai_http_${res.status}: ${text}`)
    }
    const json: any = await res.json()
    // Extract JSON from assistant message
    const content = json?.choices?.[0]?.message?.content || '{}'
    let parsed: any
    try { parsed = JSON.parse(content) } catch { parsed = {} }
    // Expected minimal schema: { score: number in [0,1], z?: number, justification?: string }
    const score = typeof parsed.score === 'number' && isFinite(parsed.score) ? Math.max(0, Math.min(1, parsed.score)) : 0.5
    const z = typeof parsed.z === 'number' && isFinite(parsed.z) ? parsed.z : undefined
    return {
      score,
      z,
      modelHash: '',
      provider: this.name(),
      version: 'openai-v1',
      meta: { raw: parsed, model: this.model, inferenceProofHash }
    }
  }
  private buildPrompt(req: InferenceRequest): string {
    // Provide a compact, deterministic context to the LLM
    const f = req.features || {}
    const lines = [
      'You are scoring a DCA decision from 0 to 1 as JSON only.',
      'Return exactly: {"score": number in [0,1], "z": optional number, "justification": string}',
      'Scoring rubric:',
      '- 0.70–0.90: BUY bias when allocationDeviation << 0 (underweight) and volatility is modest.',
      '- 0.55–0.70: Mild BUY if slightly underweight or momentum positive.',
      '- 0.45–0.55: NEUTRAL/WAIT when signals conflict or uncertainty is high.',
      '- 0.10–0.45: SELL/REBALANCE bias when strongly overweight and/or momentum negative.',
      'Signal weights (from most to least): allocationDeviation, volatilitySimple, executionsLast24h.',
      'Be conservative under high volatility; don’t saturate at extremes unless signals are strong.',
      `delegator: ${req.delegator}`,
      `timestamp: ${req.timestamp}`,
      `allocationDeviation: ${f.allocationDeviation ?? null}`,
      `executionsLast24h: ${f.executionsLast24h ?? null}`,
      `volatilitySimple: ${f.volatilitySimple ?? null}`,
      `momentum: ${(f as any).hyper_momentum ?? null}`,
      `profile: ${f.strategyProfile ?? 'default'}`,
      `force: ${f.testForceAction ?? ''}`,
    ]
    return lines.join('\n')
  }
}
