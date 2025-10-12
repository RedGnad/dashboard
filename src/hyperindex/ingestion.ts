// HyperIndex / Envio ingestion stub
// Objectif: fournir une structure claire pour le futur module Python ou pipeline externe.
// Ce module Node servira de couche d'adaptation (optionnel) si on souhaite déclencher ingestion côté backend.

export interface RawEvent {
  id: string
  ts: number // epoch ms
  blockNumber: number
  txHash?: string
  kind: string // e.g. 'swap' | 'transfer' | 'fill'
  pair?: string
  baseToken?: string
  quoteToken?: string
  price?: number // prix unitaire base/quote
  amountBase?: string
  amountQuote?: string
  raw?: any
}

export interface FeatureWindowSpec {
  fromTs: number
  toTs: number
  pair?: string
}

export interface ComputedFeatures {
  featureHash: string
  windowFromTs: number
  windowToTs: number
  priceChangePct15m?: number
  priceChangePct1h?: number
  volatility1h?: number
  momentum5m?: number
  rawCount: number
  computedAt: number
}

// TODO (future): remplacer par stockage sqlite / repository
const _EVENTS: RawEvent[] = []

export function ingestEvents(events: RawEvent[]) {
  // append-only
  for (const e of events) {
    if (!_EVENTS.find((x) => x.id === e.id)) _EVENTS.push(e)
  }
  _EVENTS.sort((a, b) => a.ts - b.ts)
}

export function listEvents(opts?: { limit?: number; sinceTs?: number }): RawEvent[] {
  let arr = _EVENTS
  if (opts?.sinceTs) arr = arr.filter((e) => e.ts >= opts.sinceTs!)
  const lim = opts?.limit ?? 500
  return arr.slice(-lim)
}

export function computeBasicFeatures(windowMs: number): ComputedFeatures | null {
  const now = Date.now()
  const fromTs = now - windowMs
  const slice = _EVENTS.filter((e) => e.ts >= fromTs)
  if (!slice.length) return null
  // Naive price change = (last.price - first.price) / first.price
  const first = slice[0]
  const last = slice[slice.length - 1]
  let priceChangePct15m: number | undefined
  if (first.price != null && last.price != null && first.price > 0) {
    priceChangePct15m = ((last.price - first.price) / first.price) * 100
  }
  const features: ComputedFeatures = {
    featureHash: '0x', // calculé plus tard via hash canonique
    windowFromTs: fromTs,
    windowToTs: now,
    priceChangePct15m,
    rawCount: slice.length,
    computedAt: now,
  }
  return features
}

// Placeholder: hashing fait côté stratégie quand serialization stabilisée.
