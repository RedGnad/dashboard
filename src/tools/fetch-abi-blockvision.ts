import 'dotenv/config'
import { createPublicClient, http, Address } from 'viem'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

async function main() {
  const addr = (process.argv[2] || '').toLowerCase()
  const out = process.argv[3]
  if (!addr || !addr.startsWith('0x') || addr.length !== 42) {
    console.error('Usage: tsx src/tools/fetch-abi-blockvision.ts <address> [out.json]')
    process.exit(1)
  }
  const apiKey = process.env.BLOCKVISION_API_KEY
  if (!apiKey) {
    console.error('Missing BLOCKVISION_API_KEY in environment.')
    process.exit(1)
  }
  const url = new URL('https://api.blockvision.org/v2/monad/contract/source/code')
  url.searchParams.set('address', addr)
  const res = await fetch(url.toString(), { headers: { 'X-API-Key': apiKey } })
  if (!res.ok) {
    const text = await res.text().catch(()=> '')
    throw new Error(`BlockVision HTTP ${res.status}: ${text}`)
  }
  const json = await res.json()
  if (json.code !== 0 || !json.result) {
    throw new Error(`BlockVision error: ${json.reason || json.message || 'unknown'}`)
  }
  const abiStr = json.result.abi as string | undefined
  if (!abiStr) throw new Error('No ABI in response')
  let abi: any
  try { abi = JSON.parse(abiStr) } catch {
    // Some explorers return abi already as object
    abi = json.result.abi
  }
  const dir = join(process.cwd(), 'envio', 'abis')
  try { mkdirSync(dir, { recursive: true }) } catch {}
  const file = out ? out : join(dir, `${addr}.abi.json`)
  writeFileSync(file, JSON.stringify(abi, null, 2))
  console.log('[abi] saved to', file)
}

main().catch((e) => { console.error(e); process.exit(1) })
