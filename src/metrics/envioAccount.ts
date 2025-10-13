import 'dotenv/config'

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  const admin = process.env.ENVIO_HASURA_ADMIN_SECRET
  const bearer = process.env.ENVIO_GRAPHQL_BEARER
  if (admin && admin !== 'your_admin_secret') h['x-hasura-admin-secret'] = admin
  if (bearer) h['Authorization'] = `Bearer ${bearer}`
  return h
}

async function gql<T>(query: string, variables: any): Promise<T> {
  const url = process.env.ENVIO_GRAPHQL_URL
  if (!url) throw new Error('ENVIO_GRAPHQL_URL missing')
  const res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify({ query, variables }) })
  if (!res.ok) { const t = await res.text().catch(()=> ''); throw new Error(`Envio HTTP ${res.status} ${t}`) }
  const json = await res.json()
  if (json.errors) throw new Error(`Envio errors: ${JSON.stringify(json.errors)}`)
  return json.data as T
}

export type AccountBalances = { usdc: number; wmon: number; mon: number }

// Try a few common schemas to retrieve per-account token balances.
export async function fetchAccountBalancesEnvio(address: string, tokens: { usdc: string; wmon: string }): Promise<AccountBalances | null> {
  const addr = (address || '').toLowerCase()
  const usdc = (tokens.usdc || '').toLowerCase()
  const wmon = (tokens.wmon || '').toLowerCase()
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return null
  // Variant A: TokenBalances table
  const Q_A = `
    query Q($owner: String!, $tokens: [String!]) {
      TokenBalances(where: {owner: {_eq: $owner}, token: {_in: $tokens}}) { token, balance }
    }
  `
  try {
    const data = await gql<{ TokenBalances: Array<{ token: string; balance: string | number }> }>(Q_A, { owner: addr, tokens: [usdc, wmon] })
    const map = new Map<string, number>()
    for (const r of data.TokenBalances || []) {
      const t = (r.token || '').toLowerCase()
      const v = typeof r.balance === 'string' ? Number(r.balance) : Number(r.balance || 0)
      map.set(t, v)
    }
    if (map.size > 0) return { usdc: (map.get(usdc) || 0), wmon: (map.get(wmon) || 0), mon: 0 }
  } catch {}
  // Variant B: ERC20Balance table
  const Q_B = `
    query Q($owner: String!, $tokens: [String!]) {
      ERC20Balance(where: {owner: {_eq: $owner}, tokenAddress: {_in: $tokens}}) { tokenAddress, balance }
    }
  `
  try {
    const data = await gql<{ ERC20Balance: Array<{ tokenAddress: string; balance: string | number }> }>(Q_B, { owner: addr, tokens: [usdc, wmon] })
    const map = new Map<string, number>()
    for (const r of data.ERC20Balance || []) {
      const t = (r.tokenAddress || '').toLowerCase()
      const v = typeof r.balance === 'string' ? Number(r.balance) : Number(r.balance || 0)
      map.set(t, v)
    }
    if (map.size > 0) return { usdc: (map.get(usdc) || 0), wmon: (map.get(wmon) || 0), mon: 0 }
  } catch {}
  // If neither present, return null to let caller fallback on-chain
  return null
}
