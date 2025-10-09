import { keccak256 } from 'viem'

export interface InferenceRequest {
  features: Record<string, any>
  delegator: string
  timestamp: number
  featureHashV2?: string // optionnel si déjà calculé plus haut
}

export interface InferenceResponse {
  score: number
  z?: number
  modelHash: string
  weightsUsedHash?: string
  provider: string
  version: string
  txHash?: string
  meta?: Record<string, any>
}

export interface InferenceProvider {
  name(): string
  run(req: InferenceRequest): Promise<InferenceResponse>
}

// Utilitaire stable pour transformer une chaîne hex en score déterministe [0,1)
export function scoreFromHex(hex: string): number {
  try {
    if (!hex.startsWith('0x')) return 0.5
    const slice = hex.slice(2, 14) // 12 hex ~ 48 bits
    const n = parseInt(slice, 16)
    const denom = 16 ** slice.length
    const f = n / denom
    return Number(f.toFixed(8))
  } catch { return 0.5 }
}

export function hashJsonStable(obj: any): string {
  try {
    const json = JSON.stringify(obj, Object.keys(obj).sort())
    let h = '0x'
    const enc = new TextEncoder().encode(json)
    for (const b of enc) h += b.toString(16).padStart(2,'0')
    return keccak256(h as `0x${string}`)
  } catch { return '0x' + '0'.repeat(64) }
}
