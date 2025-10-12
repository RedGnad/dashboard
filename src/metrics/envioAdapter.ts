import 'dotenv/config'
import { DailyProtocolMetrics, ProtocolDef } from './protocols'

function getEnvioHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const admin = process.env.ENVIO_HASURA_ADMIN_SECRET
  const bearer = process.env.ENVIO_GRAPHQL_BEARER
  // Only include admin secret if it looks real (avoid default placeholder breaking auth)
  if (admin && admin !== 'your_admin_secret') headers['x-hasura-admin-secret'] = admin
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`
  return headers
}

async function gql<T>(query: string, variables: any): Promise<T> {
  const url = process.env.ENVIO_GRAPHQL_URL
  if (!url) throw new Error('ENVIO_GRAPHQL_URL missing')
  const res = await fetch(url, {
    method: 'POST',
    headers: getEnvioHeaders(),
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) {
    const text = await res.text().catch(()=> '')
    throw new Error(`Envio GraphQL HTTP ${res.status} ${text}`)
  }
  const json = await res.json()
  if (json.errors) throw new Error(`Envio GraphQL errors: ${JSON.stringify(json.errors)}`)
  return json.data as T
}

function todayISO(): string { return new Date().toISOString().slice(0,10) }

export async function fetchDailyMetricsEnvio(registry: ProtocolDef[], dateISO?: string): Promise<DailyProtocolMetrics[]> {
  const date = dateISO || todayISO()
  // Use envioId when provided, otherwise fallback to canonical id
  const ids = registry.map(r => r.envioId || r.id)
  if (ids.length === 0) return []
  const query = `
    query Daily($ids: [String!], $date: String!) {
      DailyMetrics(where: {protocolId: {_in: $ids}, dateISO: {_eq: $date}}) {
        protocolId
        dateISO
        usersDaily
        txDaily
        txCumulative
        avgTxPerUser
        avgFeeNative
      }
    }
  `
  type Row = { protocolId: string; dateISO: string; usersDaily: number; txDaily: number; txCumulative: string | number; avgTxPerUser: number; avgFeeNative: number | null }
  const data = await gql<{ DailyMetrics: Row[] }>(query, { ids, date })
  const map = new Map<string, Row>()
  for (const r of data.DailyMetrics || []) map.set(r.protocolId, r)

  // Fallback: if some protocols have no row for today, fetch the latest available day
  const missing = ids.filter(id => !map.has(id))
  if (missing.length > 0) {
    const queryLatest = `
      query Latest($ids: [String!]) {
        DailyMetrics(where: {protocolId: {_in: $ids}}, order_by: [{dateISO: desc}], limit: 1000) {
          protocolId
          dateISO
          usersDaily
          txDaily
          txCumulative
          avgTxPerUser
          avgFeeNative
        }
      }
    `
    try {
      const latest = await gql<{ DailyMetrics: Row[] }>(queryLatest, { ids: missing })
      const seen = new Set<string>()
      for (const r of latest.DailyMetrics || []) {
        if (!seen.has(r.protocolId)) { map.set(r.protocolId, r); seen.add(r.protocolId) }
        if (seen.size === missing.length) break
      }
    } catch {}
  }
  const out: DailyProtocolMetrics[] = []
  for (const p of registry) {
    const key = p.envioId || p.id
    const r = map.get(key)
    if (r) {
      out.push({
        id: p.id,
        dateISO: r.dateISO,
        usersDaily: r.usersDaily || 0,
        txDaily: r.txDaily || 0,
        txCumulative: typeof r.txCumulative === 'string' ? Number(r.txCumulative) : (r.txCumulative ?? null),
        avgTxPerUser: r.avgTxPerUser || 0,
        avgFeeNative: r.avgFeeNative ?? null,
        depositDaily: null,
        withdrawDaily: null,
      })
    } else {
      out.push({ id: p.id, dateISO: date, usersDaily: 0, txDaily: 0, txCumulative: null, avgTxPerUser: 0, avgFeeNative: null, depositDaily: null, withdrawDaily: null })
    }
  }
  // Optional: enrich with deposit/withdraw if indexer exposes these fields
  try {
    const extrasQ = `
      query DailyExtras($ids: [String!], $date: String!) {
        DailyMetrics(where: {protocolId: {_in: $ids}, dateISO: {_eq: $date}}) {
          protocolId
          depositDaily
          withdrawDaily
        }
      }
    `
    type X = { protocolId: string; depositDaily?: number | null; withdrawDaily?: number | null }
    const ex = await gql<{ DailyMetrics: X[] }>(extrasQ, { ids, date })
    const mapX = new Map<string, X>()
    for (const r of ex.DailyMetrics || []) mapX.set(r.protocolId, r)
    for (const row of out) {
      // Map by envioId if provided
      const proto = registry.find(pr => pr.id === row.id)
      const key = (proto?.envioId) || row.id
      const x = mapX.get(key)
      if (x) {
        if (x.depositDaily !== undefined) row.depositDaily = x.depositDaily ?? null
        if (x.withdrawDaily !== undefined) row.withdrawDaily = x.withdrawDaily ?? null
      }
    }
  } catch {}
  return out
}

// List distinct protocolId values available in Envio DailyMetrics (debug/helper)
export async function listEnvioProtocolIds(): Promise<string[]> {
  const query = `
    query Distinct {
      DailyMetrics(distinct_on: protocolId, order_by: [{protocolId: asc}, {dateISO: desc}]) {
        protocolId
      }
    }
  `
  type Row = { protocolId: string }
  const data = await gql<{ DailyMetrics: Row[] }>(query, {})
  const ids = (data.DailyMetrics || []).map(r => r.protocolId).filter(Boolean)
  // De-duplicate defensively while preserving order
  return Array.from(new Set(ids))
}
