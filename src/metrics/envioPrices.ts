import 'dotenv/config'

type PricePoint = { ts: number; price: number }

function headers() {
  const h: Record<string,string> = { 'Content-Type': 'application/json' }
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
  if (!res.ok) throw new Error(`Envio HTTP ${res.status}: ${await res.text().catch(()=> '')}`)
  const json = await res.json()
  if (json.errors) throw new Error(`Envio errors: ${JSON.stringify(json.errors)}`)
  return json.data
}

// Try common table patterns to get recent swaps between baseToken and quoteToken.
// We compute unit price = quote per 1 base. Returns most recent first or as returned (we re-sort by ts asc).
export async function fetchPriceSeriesEnvio(params: { baseToken: string; quoteToken: string; windowMinutes?: number; maxPoints?: number }): Promise<PricePoint[] | null> {
  const base = params.baseToken.toLowerCase()
  const quote = params.quoteToken.toLowerCase()
  const windowMinutes = Math.max(1, Math.min(60*24, params.windowMinutes ?? 60))
  const maxPoints = Math.max(5, Math.min(2000, params.maxPoints ?? 200))
  const since = Math.floor(Date.now()/1000) - windowMinutes * 60

  // Variant A: Swaps(tokenIn, tokenOut, amountIn, amountOut, timestamp)
  const QA = `
    query SwapsA($a: String!, $b: String!, $since: Int!, $limit: Int!) {
      Swaps(where: {timestamp: {_gte: $since}, tokenIn: {_in: [$a, $b]}, tokenOut: {_in: [$a, $b]}}, order_by: {timestamp: desc}, limit: $limit) {
        tokenIn tokenOut amountIn amountOut timestamp
      }
    }
  `
  try {
    const d = await gql<{ Swaps: Array<{ tokenIn: string; tokenOut: string; amountIn: string; amountOut: string; timestamp: number }> }>(QA, { a: base, b: quote, since, limit: maxPoints })
    if (Array.isArray(d?.Swaps) && d.Swaps.length) {
      const out: PricePoint[] = []
      for (const s of d.Swaps) {
        const tin = (s.tokenIn||'').toLowerCase()
        const tout = (s.tokenOut||'').toLowerCase()
        const ain = Number(s.amountIn)
        const aout = Number(s.amountOut)
        if (!Number.isFinite(ain) || !Number.isFinite(aout) || ain<=0) continue
        // price (quote per 1 base)
        if (tin === base && tout === quote) out.push({ ts: s.timestamp*1000, price: aout/ain })
        else if (tin === quote && tout === base && aout>0) out.push({ ts: s.timestamp*1000, price: ain/aout })
      }
      if (out.length) return out.sort((a,b)=>a.ts-b.ts)
    }
  } catch {}

  // Variant B: V2Swap(token0, token1, amount0In, amount1In, amount0Out, amount1Out, timestamp)
  const QB = `
    query SwapsB($a: String!, $b: String!, $since: Int!, $limit: Int!) {
      V2Swap(where: {timestamp: {_gte: $since}, token0: {_in: [$a,$b]}, token1: {_in: [$a,$b]}}, order_by: {timestamp: desc}, limit: $limit) {
        token0 token1 amount0In amount1In amount0Out amount1Out timestamp
      }
    }
  `
  try {
    const d = await gql<{ V2Swap: Array<{ token0: string; token1: string; amount0In: string; amount1In: string; amount0Out: string; amount1Out: string; timestamp: number }> }>(QB, { a: base, b: quote, since, limit: maxPoints })
    if (Array.isArray(d?.V2Swap) && d.V2Swap.length) {
      const out: PricePoint[] = []
      for (const s of d.V2Swap) {
        const t0 = (s.token0||'').toLowerCase()
        const t1 = (s.token1||'').toLowerCase()
        // pick a direction
        if (t0 === base && t1 === quote) {
          const in0 = Number(s.amount0In||'0'), out1 = Number(s.amount1Out||'0')
          if (in0>0 && out1>0) out.push({ ts: s.timestamp*1000, price: out1/in0 })
          else {
            const in1 = Number(s.amount1In||'0'), out0 = Number(s.amount0Out||'0')
            if (in1>0 && out0>0) out.push({ ts: s.timestamp*1000, price: in1/out0 })
          }
        } else if (t0 === quote && t1 === base) {
          const in0 = Number(s.amount0In||'0'), out1 = Number(s.amount1Out||'0')
          if (in0>0 && out1>0) out.push({ ts: s.timestamp*1000, price: in0/out1 })
          else {
            const in1 = Number(s.amount1In||'0'), out0 = Number(s.amount0Out||'0')
            if (in1>0 && out0>0) out.push({ ts: s.timestamp*1000, price: out0/in1 })
          }
        }
      }
      if (out.length) return out.sort((a,b)=>a.ts-b.ts)
    }
  } catch {}

  return null
}
