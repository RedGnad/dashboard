import { buildFeatureSet, FeatureSet } from './schema'
import { queryEvents } from './eventStore'
import { normalizeNumber, normalizeMetrics } from '../utils/normalize'

// Compute rolling metrics over multiple windows.
// Windows: 15m, 1h, 6h, 24h (phase 1).

const WINDOWS = [
  { label: '15m', durationMs: 15 * 60_000 },
  { label: '1h', durationMs: 60 * 60_000 },
  { label: '6h', durationMs: 6 * 60 * 60_000 },
  { label: '24h', durationMs: 24 * 60 * 60_000 },
]

export interface FeatureComputationOptions {
  now?: number
  typeFilter?: string[]
}

export function computeFeatureSet(opts: FeatureComputationOptions = {}): FeatureSet | null {
  const now = opts.now ?? Date.now()
  // Load events up to 24h back (largest window) + small buffer
  const maxWindow = WINDOWS[WINDOWS.length - 1].durationMs
  const sinceTs = now - maxWindow - 5_000
  const events = queryEvents({ sinceTs, typeIn: opts.typeFilter })
  if (!events.length) return null

  // Helper to filter by window
  function evts(windowMs: number) {
    const fromTs = now - windowMs
    return events.filter(e => e.ts >= fromTs)
  }

  // Basic metrics examples (placeholder formulas):
  const e15 = evts(15 * 60_000)
  const e1h = evts(60 * 60_000)
  const e6h = evts(6 * 60 * 60_000)
  const e24h = evts(24 * 60 * 60_000)

  function priceChange(slice: typeof events) {
    if (slice.length < 2) return null
    const first = slice[0]
    const last = slice[slice.length - 1]
    if (first.price == null || last.price == null || first.price <= 0) return null
    return ((last.price - first.price) / first.price) * 100
  }

  function avgNotional(slice: typeof events) {
    let total = 0, n = 0
    for (const e of slice) {
      if (e.amountQuote && !isNaN(Number(e.amountQuote))) { total += Number(e.amountQuote); n++ }
    }
    if (!n) return null
    return total / n
  }

  function volatility(slice: typeof events) {
    const prices = slice.map(e => e.price).filter(p => typeof p === 'number') as number[]
    if (prices.length < 3) return null
    const mean = prices.reduce((a,b)=>a+b,0)/prices.length
    const variance = prices.reduce((a,b)=> a + (b-mean)**2, 0)/prices.length
    return Math.sqrt(variance)
  }

  const metricsRaw: Record<string, number | string | null> = {
    priceChangePct_15m: priceChange(e15),
    priceChangePct_1h: priceChange(e1h),
    priceChangePct_6h: priceChange(e6h),
    priceChangePct_24h: priceChange(e24h),
    avgNotional_1h: avgNotional(e1h),
    avgNotional_6h: avgNotional(e6h),
    avgNotional_24h: avgNotional(e24h),
    volatility_1h: volatility(e1h),
    volatility_6h: volatility(e6h),
    events_15m: e15.length,
    events_1h: e1h.length,
    events_6h: e6h.length,
    events_24h: e24h.length,
  }

  // Normalize numeric precision for deterministic hashing (8 decimals default)
  const metrics: Record<string, number | string | null> = {}
  for (const [k,v] of Object.entries(metricsRaw)) {
    if (typeof v === 'number') metrics[k] = normalizeNumber(v, { decimals: 8 })
    else metrics[k] = v
  }

  return buildFeatureSet({ metrics, windows: WINDOWS, now })
}
