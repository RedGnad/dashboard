// Source Adapter abstraction for multi-chain / multi-source feature & price ingestion.
// Initial skeleton focuses on Monad testnet; future adapters can plug additional chains or data providers.

export interface BlockRef {
  number: number
  hash?: string
  timestamp?: number
}

export interface MarketSnapshot {
  chainId: number
  asOfTs: number
  block?: BlockRef
  prices: Record<string, string> // symbol -> price (string to avoid float drift)
  liquidityHints?: Record<string, any>
}

export interface TradeEventLike {
  id: string
  ts: number
  chainId: number
  type: string // 'swap' | 'transfer' | etc.
  price?: number
  amountQuote?: string
  amountBase?: string
  txHash?: string
  blockNumber?: number
  meta?: any
}

export interface SourceAdapterContext {
  // room for caching, auth, env, etc.
}

export interface SourceAdapter {
  readonly id: string
  readonly chainId: number
  kind(): string
  init?(ctx: SourceAdapterContext): Promise<void> | void
  fetchLatestBlock?(): Promise<BlockRef | null>
  fetchMarketSnapshot(symbols: string[]): Promise<MarketSnapshot>
  ingestExternalEvents?(events: TradeEventLike[]): Promise<{ accepted: number; skipped: number }>
}

export class MonadTestnetAdapter implements SourceAdapter {
  readonly id = 'monad-testnet'
  readonly chainId = 10143
  kind() { return 'evm-testnet' }

  async fetchMarketSnapshot(symbols: string[]): Promise<MarketSnapshot> {
    const asOfTs = Date.now()
    // Placeholder: static prices until oracle integration. Future: fetch via on-chain call or external API.
    const prices: Record<string,string> = {}
    for (const s of symbols) prices[s] = s === 'USDC' ? '1' : '0'
    return { chainId: this.chainId, asOfTs, prices }
  }
}

// Simple registry for adapters (singleton pattern acceptable here)
const registry = new Map<string, SourceAdapter>()

export function registerAdapter(adapter: SourceAdapter) {
  registry.set(adapter.id, adapter)
}

export function getAdapter(id: string): SourceAdapter | undefined {
  return registry.get(id)
}

export function listAdapters(): SourceAdapter[] { return [...registry.values()] }

// Auto-register monad testnet adapter
registerAdapter(new MonadTestnetAdapter())
