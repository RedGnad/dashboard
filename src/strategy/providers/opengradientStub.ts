import { keccak256 } from 'viem'
import { InferenceProvider, InferenceRequest, InferenceResponse, scoreFromHex, hashJsonStable } from './types'

// Stub déterministe: transforme les features en un score stable.
// modelHash dérivé d'une canonicalisation pour pouvoir vérifier après coup.
export class OpenGradientStubProvider implements InferenceProvider {
  private modelCid: string
  private inferenceMode: string
  constructor(opts?: { modelCid?: string; inferenceMode?: string }) {
    this.modelCid = opts?.modelCid || 'stub-model-cid'
    this.inferenceMode = (opts?.inferenceMode || 'VANILLA').toUpperCase()
  }
  name() { return 'opengradient-stub' }
  async run(req: InferenceRequest): Promise<InferenceResponse> {
    // Construire un pseudo feature hash stable si non fourni:
    const base = { f: req.features, delegator: req.delegator }
    const pseudoFeatureHash = req.featureHashV2 || hashJsonStable(base)
    const score = scoreFromHex(pseudoFeatureHash)
    // Recréer un z cohérent (logit inverse simplifié):
    const eps = 1e-9
    const z = Math.log((score + eps) / (1 - score + eps))
    const modelHash = keccak256((() => {
      const tag = `OGSTUB|${this.modelCid}|${this.inferenceMode}|v1`
      let hex = '0x'
      const enc = new TextEncoder().encode(tag)
      for (const b of enc) hex += b.toString(16).padStart(2,'0')
      return hex as `0x${string}`
    })())
    return {
      score: Number(score.toFixed(8)),
      z: Number(z.toFixed(8)),
      modelHash,
      provider: this.name(),
      version: 'stub-v1',
      meta: { modelCid: this.modelCid, inferenceMode: this.inferenceMode, pseudoFeatureHash }
    }
  }
}
