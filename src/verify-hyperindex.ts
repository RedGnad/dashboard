import { keccak256 } from 'viem'
import http from 'node:http'
import https from 'node:https'
import { serializeFeatures } from './hyperindex/schema'
import { aggregateHyperIndex } from './hyperindex/aggregator'

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(url, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        try { resolve(JSON.parse(data || '{}')) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
  })
}

async function main() {
  const base = process.env.API_BASE || 'http://127.0.0.1:8787'
  const url = base.replace(/\/$/, '') + '/api/hyperindex/features/head'
  const js = await fetchJson(url)
  if (!js.ok) {
    console.error('[verify-hyperindex] endpoint error', js.error)
    process.exit(2)
  }
  if (js.empty || !js.features) {
    console.log('[verify-hyperindex] no features (empty)')
    process.exit(0)
  }
  const feat = js.features
  const { featureHash, ...rest } = feat
  const ser = serializeFeatures(rest)
  // encode to hex for keccak256 like backend does
  const enc = new TextEncoder().encode(ser)
  let hex = '0x'
  for (const b of enc) hex += b.toString(16).padStart(2, '0')
  const local = keccak256(hex as `0x${string}`)
  const match = local.toLowerCase() === String(featureHash).toLowerCase()
  if (!match) {
    console.error('[verify-hyperindex] MISMATCH', { server: featureHash, local })
    process.exit(1)
  }
  console.log('[verify-hyperindex] OK match', featureHash)
  // Optionnel: si l'API renvoie un eventSetHash dans provenance, on tente de recomposer localement.
  try {
    const prov = js.provenance || js.features?.provenance || js.provenance || {}
    if (prov.eventSetHash) {
      const agg = aggregateHyperIndex({ includeCanonical: false })
      if (!agg) {
        console.warn('[verify-hyperindex] aucun events locaux pour recomposer eventSetHash')
      } else if (agg.eventSetHash.toLowerCase() !== String(prov.eventSetHash).toLowerCase()) {
        console.error('[verify-hyperindex] eventSetHash mismatch', { server: prov.eventSetHash, local: agg.eventSetHash })
        process.exitCode = 1
      } else {
        console.log('[verify-hyperindex] eventSetHash OK', agg.eventSetHash)
      }
    }
  } catch (e) {
    console.warn('[verify-hyperindex] eventSetHash verify error', (e as any)?.message || e)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
