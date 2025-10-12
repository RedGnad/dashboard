import { computeSyntheticPrice } from '../features'
import { getGlobalSurge, initGlobalSurge } from '../oracles/switchboard'

export interface GlobalSpotResult { price: number; ts: number; source: string }

let INITIALIZED = false

// Minimal stablecoin classification. We currently only need USDC, but
// leaving the helper generic allows future extension without refactors.
const STABLE_SYMBOLS = new Set<string>(['USDC'])

export function isStableSymbol(symbol?: string): boolean {
  if (!symbol) return false
  return STABLE_SYMBOLS.has(symbol.toUpperCase())
}

export function initGlobalPriceInfra() {
  if (INITIALIZED) return
  INITIALIZED = true
  if (process.env.ENABLE_SWITCHBOARD === '1' || process.env.ENABLE_SWITCHBOARD === 'true') {
    const apiKey = process.env.SWITCHBOARD_API_KEY
    const symbolsEnv = process.env.SWITCHBOARD_SYMBOLS || 'WMON/USD'
    const symbols = symbolsEnv.split(',').map(s => s.trim()).filter(Boolean)
    if (apiKey && symbols.length) {
      initGlobalSurge({ apiKey, symbols, staleMs: process.env.SWITCHBOARD_STALE_MS ? Number(process.env.SWITCHBOARD_STALE_MS) : 15000 })
      console.log('[price] surge initialization requested', { symbols })
    } else {
      console.log('[price] surge disabled (missing apiKey or symbols)')
    }
  }
}

export function getSpot(symbol: string): GlobalSpotResult | null {
  // Stablecoins are treated as $1.00 by definition to avoid injecting synthetic
  // volatility or relying on external feeds for known stables.
  if (isStableSymbol(symbol)) {
    const ts = Date.now()
    return { price: 1, ts, source: 'stable-constant' }
  }
  const surge = getGlobalSurge()
  if (surge) {
    const symPair = symbol.toUpperCase().endsWith('/USD') ? symbol.toUpperCase() : `${symbol.toUpperCase()}/USD`
    const got = surge.getSpot(symPair)
    if (got) return { price: got.price, ts: got.ts, source: 'surge' }
  }
  // Fallback synthetic deterministic price (explicitly marked so audit can tell)
  const ts = Date.now()
  const synthetic = computeSyntheticPrice(ts)
  return { price: synthetic, ts, source: 'synthetic' }
}

// Configured base symbol for strategy price-derived features (e.g. MON vs WMON)
export function getConfiguredBaseSymbol(): string {
  const env = (process.env.PRICE_BASE_SYMBOL || '').trim()
  if (env) return env
  return 'WMON' // legacy default
}
