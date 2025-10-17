import 'dotenv/config'

async function fetchStatus(address: string) {
  const apiKey = process.env.BLOCKVISION_API_KEY
  if (!apiKey) throw new Error('BLOCKVISION_API_KEY missing')
  const url = new URL('https://api.blockvision.org/v2/monad/contract/source/code')
  url.searchParams.set('address', address.toLowerCase())
  const res = await fetch(url.toString(), { headers: { 'X-API-Key': apiKey } })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch {
    return { address, ok: false, status: 'unknown', abi: false, note: `Non-JSON response HTTP ${res.status}` }
  }
  if (json.code !== 0 || !json.result) {
    return { address, ok: false, status: json.result?.status ?? 'unknown', abi: false, note: `${json.message || 'no message'}${json.reason ? ` / ${json.reason}` : ''}` }
  }
  const status = json.result.status || 'unknown'
  const abi = !!json.result.abi && json.result.abi.length > 2
  return { address, ok: true, status, abi }
}

async function main() {
  const addrs = process.argv.slice(2).filter(a => a && a.startsWith('0x') && a.length === 42)
  if (addrs.length === 0) {
    console.error('Usage: tsx src/tools/check-verify-blockvision.ts <address> [address2 ...]')
    process.exit(1)
  }
  for (const a of addrs) {
    try {
      const r = await fetchStatus(a)
      console.log(`${r.address} -> status=${r.status} abi=${r.abi ? 'yes' : 'no'}${r.note ? ` (${r.note})` : ''}`)
    } catch (e: any) {
      console.log(`${a} -> error: ${e?.message || e}`)
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
