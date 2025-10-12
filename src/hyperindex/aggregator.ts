import { keccak256 } from 'viem'
import { queryEvents } from './eventStore'
import { IngestedEvent } from './schema'

// HyperIndex Aggregator (Priorité 2)
// Objectif: produire un hash déterministe (eventSetHash) d'un sous-ensemble d'événements récents
// et calculer des métriques agrégées (hyperMetrics) indépendantes des core features actuelles.
// Ces données sont injectées de manière passive dans les lignes ai_decision (pas incluses dans featureHashV2).

export interface AggregatedHyperIndex {
  asOfTs: number
  rangeMs: number
  eventCount: number
  eventSetHash: string
  hyperMetrics: Record<string, number | string | null>
  // Optionnel: debug serialization pour vérifications (non loggé en prod si on veut minimiser)
  _canonical?: string
}

// Fenêtre max d'agrégation (24h) – pourra être paramétrée plus tard.
const DEFAULT_RANGE_MS = 24 * 60 * 60 * 1000

// Champs retenus dans la canonicalisation (ordre fixe). But: stabilité & sobriété.
const CANON_FIELDS: (keyof Pick<IngestedEvent,'id'|'ts'|'type'|'price'|'amountQuote'>)[] = [
  'id','ts','type','price','amountQuote'
]

// Helper: format value pour ligne canonique
function fmt(v: any): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'null'
    return Number(v.toFixed(8)).toString()
  }
  return String(v)
}

// Compute basic derived metrics (placeholder heuristics)
function computeMetrics(events: IngestedEvent[]): Record<string, number | string | null> {
  if (!events.length) return {}
  // Tri par ts croissant pour calculs
  const sorted = [...events].sort((a,b)=> a.ts - b.ts)
  const prices = sorted.map(e => typeof e.price === 'number' ? e.price : null).filter((p): p is number => p != null)
  let priceChangePct_24h: number | null = null
  if (prices.length >= 2 && prices[0] > 0) {
    priceChangePct_24h = ((prices[prices.length-1] - prices[0]) / prices[0]) * 100
  }
  // Volatilité simple (écart-type des prix)
  let volatility_24h: number | null = null
  if (prices.length >= 3) {
    const mean = prices.reduce((a,b)=>a+b,0)/prices.length
    const variance = prices.reduce((a,b)=> a + (b-mean)**2, 0)/prices.length
    volatility_24h = Math.sqrt(variance)
  }
  // Compter événements par type
  const counts: Record<string, number> = {}
  for (const e of events) counts[e.type] = (counts[e.type]||0)+1
  const metrics: Record<string, number | string | null> = {
    events_total_24h: events.length,
    priceChangePct_24h: priceChangePct_24h == null ? null : Number(priceChangePct_24h.toFixed(6)),
    volatility_24h: volatility_24h == null ? null : Number(volatility_24h.toFixed(8)),
  }
  for (const [k,v] of Object.entries(counts)) metrics[`events_${k}_24h`] = v
  return metrics
}

export interface AggregateOptions {
  now?: number
  rangeMs?: number
  includeCanonical?: boolean
  typeIn?: string[]
}

export function aggregateHyperIndex(opts: AggregateOptions = {}): AggregatedHyperIndex | null {
  const now = opts.now ?? Date.now()
  const rangeMs = opts.rangeMs ?? DEFAULT_RANGE_MS
  const sinceTs = now - rangeMs
  const events = queryEvents({ sinceTs, typeIn: opts.typeIn })
  if (!events.length) return null
  // Canonicalisation: trier par (ts,id) pour stabilité; ignorer champs hors liste.
  const ordered = [...events].sort((a,b)=> (a.ts - b.ts) || a.id.localeCompare(b.id))
  const lines: string[] = []
  lines.push(`v=1`)
  lines.push(`rangeMs=${rangeMs}`)
  lines.push(`asOfTs=${now}`)
  for (const e of ordered) {
    const parts: string[] = []
    for (const f of CANON_FIELDS) parts.push(fmt((e as any)[f]))
    lines.push(parts.join('|'))
  }
  const canonical = lines.join('\n')
  // Hex encode puis keccak (mirroir des autres hash utilitaires du projet)
  const enc = new TextEncoder().encode(canonical)
  let hex = '0x'
  for (const b of enc) hex += b.toString(16).padStart(2,'0')
  const eventSetHash = keccak256(hex as `0x${string}`)
  const hyperMetrics = computeMetrics(ordered)
  return {
    asOfTs: now,
    rangeMs,
    eventCount: ordered.length,
    eventSetHash,
    hyperMetrics,
    _canonical: opts.includeCanonical ? canonical : undefined,
  }
}
