import http from 'node:http'
import https from 'node:https'
import { keccak256 } from 'viem'

function fetch(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(url, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch (e) { reject(e) } })
    })
    req.on('error', reject)
  })
}

async function main() {
  const base = process.env.API_BASE || 'http://127.0.0.1:8787'
  const url = base.replace(/\/$/, '') + '/api/hyperindex/proof?canonical=1'
  const js = await fetch(url)
  if (!js.ok) {
    console.error('[verify-hyperindex-proof] endpoint error', js.error)
    process.exit(2)
  }
  if (js.empty || !js.proof) {
    console.log('[verify-hyperindex-proof] empty')
    process.exit(0)
  }
  const { eventSetHash, canonical } = js.proof
  if (!canonical) {
    console.error('[verify-hyperindex-proof] canonical missing (add ?canonical=1)')
    process.exit(2)
  }
  // hex encode canonical
  const enc = new TextEncoder().encode(canonical)
  let hex = '0x'
  for (const b of enc) hex += b.toString(16).padStart(2,'0')
  const local = keccak256(hex as `0x${string}`)
  if (local.toLowerCase() !== String(eventSetHash).toLowerCase()) {
    console.error('[verify-hyperindex-proof] MISMATCH', { server: eventSetHash, local })
    process.exit(1)
  }
  console.log('[verify-hyperindex-proof] OK match', eventSetHash)
}

main().catch(e => { console.error('[verify-hyperindex-proof] error', e); process.exit(1) })
