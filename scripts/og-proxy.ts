import express from 'express'
import { keccak256 } from 'viem'

// Minimal local OG proxy for development.
// Exposes POST /inference and returns a deterministic score from features/featureHashV2.
// This is NOT the real OG; it's a local stub to unblock end-to-end wiring while we deploy the Python proxy.

function scoreFromHash(h: string): number {
  // Use first 4 bytes of keccak as uint32, normalize to [0,1]
  const hex = h.replace(/^0x/, '')
  const a = parseInt(hex.slice(0, 8), 16)
  return (a >>> 0) / 0xffffffff
}

function stableStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']'
  const keys = Object.keys(obj).sort()
  const parts: string[] = []
  for (const k of keys) parts.push(JSON.stringify(k) + ':' + stableStringify(obj[k]))
  return '{' + parts.join(',') + '}'
}

const app = express()
app.use(express.json({ limit: '1mb' }))

app.get('/', (_req, res) => res.json({ ok: true, service: 'og-proxy-mock', endpoints: ['/inference'] }))

app.post('/inference', (req, res) => {
  try {
    const { modelId, features, delegator, timestamp, featureHashV2, inferenceProofHash } = req.body || {}
    const basis = typeof featureHashV2 === 'string' && featureHashV2.startsWith('0x')
      ? featureHashV2
      : keccak256(('0x' + Buffer.from(stableStringify(features) || '{}', 'utf8').toString('hex')) as `0x${string}`)
    const score = scoreFromHash(basis)
    const z = (score - 0.5) * 4 // simple centered z-ish value for debug
    const modelHash = keccak256(('0x' + Buffer.from(String(modelId || 'og-mock'), 'utf8').toString('hex')) as `0x${string}`)
    const weightsUsedHash = keccak256(('0x' + Buffer.from('weights:' + String(modelId || 'og-mock'), 'utf8').toString('hex')) as `0x${string}`)
    return res.json({ ok: true, score, z, modelHash, weightsUsedHash, meta: { receivedProofHash: inferenceProofHash || null, delegator, timestamp } })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'proxy_inference_failed' })
  }
})

const PORT = Number(process.env.OG_PROXY_PORT || 8000)
const HOST = process.env.OG_PROXY_HOST || '127.0.0.1'
app.listen(PORT, HOST as any, () => {
  console.log(`[og-proxy] listening on http://${HOST}:${PORT}`)
})
