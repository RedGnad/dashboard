import { InferenceProvider, InferenceRequest, InferenceResponse } from './types'
import { keccak256 } from 'viem'

// Minimal HTTP client without extra deps using global fetch (Node >=18)
async function httpPostJSON(url: string, body: any, timeoutMs = 8000): Promise<any> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal })
    const text = await res.text()
    let json: any = null
    try { json = text ? JSON.parse(text) : null } catch { json = { ok: false, error: 'invalid_json', raw: text } }
    if (!res.ok) {
      const errMsg = (json && (json.error || json.message || (json.detail && (json.detail.error || json.detail.message)) )) || `http_${res.status}`
      throw new Error(String(errMsg))
    }
    return json
  } finally {
    clearTimeout(t)
  }
}

export class OpenGradientHttpProvider implements InferenceProvider {
  private baseUrl: string
  private modelId: string
  private version: string
  private inferenceMode: string
  constructor(opts?: { baseUrl?: string; modelId?: string; version?: string }) {
    this.baseUrl = opts?.baseUrl || process.env.OG_PROXY_URL || 'http://127.0.0.1:8000'
    this.modelId = opts?.modelId || process.env.OG_MODEL_ID || 'openai/gpt-4o-mini' // placeholder id if proxy ignores
    this.version = opts?.version || 'og-http-v1'
    this.inferenceMode = (process.env.OG_INFERENCE_MODE || 'VANILLA').toUpperCase()
  }
  name() { return 'opengradient' }
  async run(req: InferenceRequest): Promise<InferenceResponse> {
    // Canonical inference blob we will also send to proxy (or subset) and hash locally for proof
    const canonical = {
      provider: this.name(),
      version: this.version,
      modelId: this.modelId,
      featureHashV2: req.featureHashV2 || null,
      delegator: req.delegator,
      ts: req.timestamp,
      // We avoid including raw features to keep blob small and stable; only pre-hash is included here.
    }
    const enc = new TextEncoder().encode(JSON.stringify(canonical))
    let hex = '0x'; for (const b of enc) hex += b.toString(16).padStart(2, '0')
    const inferenceProofHash = keccak256(hex as `0x${string}`)
    // Call local proxy; it can use req.features as needed, but our proof binds to featureHashV2 above.
    const payload = { modelId: this.modelId, features: req.features, delegator: req.delegator, timestamp: req.timestamp, featureHashV2: req.featureHashV2, inferenceProofHash, inferenceMode: this.inferenceMode }
    let j: any
    try {
      j = await httpPostJSON(`${this.baseUrl}/inference`, payload)
    } catch (e: any) {
      const msg = (e?.message || '').toLowerCase()
      // Map common network errors to a clearer message for the API/UI layer
      if (msg.includes('abort') || msg.includes('fetch') || msg.includes('econn') || msg.includes('http_') ) {
        throw new Error(`og_proxy_unreachable: ${this.baseUrl}`)
      }
      throw e
    }
    // Expect shape { ok: true, score, z?, modelHash, weightsUsedHash?, meta? }
    if (!j || !j.ok) throw new Error(j?.error || 'og_proxy_failed')
    return {
      score: Number(j.score),
      z: typeof j.z === 'number' ? j.z : undefined,
      modelHash: String(j.modelHash || ''),
      weightsUsedHash: j.weightsUsedHash ? String(j.weightsUsedHash) : undefined,
      provider: this.name(),
      version: this.version,
      txHash: (j.meta && typeof j.meta.txHash === 'string') ? j.meta.txHash : (typeof j.txHash === 'string' ? j.txHash : undefined),
      meta: { ...(j.meta || {}), inferenceProofHash, modelId: this.modelId, baseUrl: this.baseUrl },
    }
  }
}
