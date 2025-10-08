import { computeSyntheticPrice } from '../features'

// PriceProvider abstraction to allow future Switchboard or other oracle integration
// while keeping deterministic replay (providers must be pure for same inputs).

export interface PriceRequestContext {
  symbol: string
  ts: number // reference timestamp (ms)
}

export interface PriceProviderResult {
  symbol: string
  price: number | null
  source: string
  ts: number
  stale?: boolean
  error?: string
}

export interface PriceProvider {
  name(): string
  getSpot(ctx: PriceRequestContext): Promise<PriceProviderResult>
}

// Synthetic deterministic provider (current default) using oscillation function.
export class SyntheticPriceProvider implements PriceProvider {
  name() { return 'synthetic-deterministic-v1' }
  async getSpot(ctx: PriceRequestContext): Promise<PriceProviderResult> {
    try {
      const price = computeSyntheticPrice(ctx.ts)
      return { symbol: ctx.symbol, price, source: this.name(), ts: ctx.ts }
    } catch (e: any) {
      return { symbol: ctx.symbol, price: null, source: this.name(), ts: ctx.ts, error: e?.message || String(e) }
    }
  }
}

// Switchboard stub – placeholder for real oracle integration.
export class SwitchboardStubProvider implements PriceProvider {
  name() { return 'switchboard-stub' }
  async getSpot(ctx: PriceRequestContext): Promise<PriceProviderResult> {
    // For now, we just return null to indicate no data (forces fallback to synthetic)
    return { symbol: ctx.symbol, price: null, source: this.name(), ts: ctx.ts, stale: true }
  }
}

// Composite provider: query in order, first non-null price wins. Records provenance.
export class CompositePriceProvider implements PriceProvider {
  private providers: PriceProvider[]
  constructor(providers: PriceProvider[]) { this.providers = providers }
  name() { return 'composite' }
  async getSpot(ctx: PriceRequestContext): Promise<PriceProviderResult> {
    const errors: string[] = []
    for (const p of this.providers) {
      const r = await p.getSpot(ctx)
      if (r.price != null && Number.isFinite(r.price)) return r
      if (r.error) errors.push(`${p.name()}:${r.error}`)
    }
    return { symbol: ctx.symbol, price: null, source: this.name(), ts: ctx.ts, error: errors.join(';') || 'no-price' }
  }
}

// Helper to build the current default provider stack
export function buildDefaultPriceProvider(): PriceProvider {
  // Future order: Switchboard -> Synthetic -> LastKnownCache
  return new CompositePriceProvider([
    new SwitchboardStubProvider(),
    new SyntheticPriceProvider(),
  ])
}
