import EventEmitter from 'node:events'
import type { Surge, SurgeUpdate } from '@switchboard-xyz/on-demand'

// Lazy require to avoid breaking if dependency not installed yet during some scripts
let SurgeLib: any
try { SurgeLib = require('@switchboard-xyz/on-demand') } catch {}

export interface SpotPrice {
  symbol: string
  price: number
  ts: number // reception timestamp (ms)
  sourceTs?: number // original source_ts_ms from Surge (if provided)
  source: 'surge'
}

export interface SwitchboardSurgeAdapterOptions {
  staleMs?: number
  logPrefix?: string
}

export class SwitchboardSurgeAdapter extends EventEmitter {
  private apiKey: string
  private symbols: string[]
  private opts: Required<SwitchboardSurgeAdapterOptions>
  private surge: Surge | null = null
  private cache: Map<string, SpotPrice> = new Map()
  private connected = false
  private connecting = false

  constructor(apiKey: string, symbols: string[], opts?: SwitchboardSurgeAdapterOptions) {
    super()
    this.apiKey = apiKey
    this.symbols = symbols
    this.opts = { staleMs: opts?.staleMs ?? 15_000, logPrefix: opts?.logPrefix ?? '[surge]' }
  }

  async start(): Promise<void> {
    if (this.connected || this.connecting) return
    if (!SurgeLib) throw new Error('surge_dependency_missing')
    this.connecting = true
    try {
      this.surge = new SurgeLib.Surge({ apiKey: this.apiKey })
      const subs = this.symbols.map(s => ({ symbol: s }))
      await this.surge.connectAndSubscribe(subs)
      this.surge.on('update', (u: SurgeUpdate) => this.onUpdate(u))
      this.connected = true
      this.emit('ready')
      console.log(this.opts.logPrefix, 'connected', { symbols: this.symbols })
    } catch (e: any) {
      console.error(this.opts.logPrefix, 'connection_failed', e?.message || e)
      this.connecting = false
      // Retry simple backoff
      setTimeout(() => this.start().catch(()=>{}), 3000)
    }
  }

  private onUpdate(update: SurgeUpdate) {
    try {
      const sym = update?.data?.symbol
      const rawPrice = update?.data?.price
      if (!sym || typeof rawPrice !== 'number' || !Number.isFinite(rawPrice)) return
      const price = Number(rawPrice.toFixed(8))
      // Capture source timestamp if available on update.data.source_ts_ms
      const sourceTs = typeof (update as any)?.data?.source_ts_ms === 'number' ? (update as any).data.source_ts_ms : undefined
      const spot: SpotPrice = { symbol: sym, price, ts: Date.now(), sourceTs, source: 'surge' }
      this.cache.set(sym.toUpperCase(), spot)
      this.emit('price', spot)
    } catch {}
  }

  getSpot(symbol: string): SpotPrice | null {
    const key = symbol.toUpperCase()
    const val = this.cache.get(key)
    if (!val) return null
    if (Date.now() - val.ts > this.opts.staleMs) return null
    return val
  }
}

// Singleton pattern convenience (optional)
let _instance: SwitchboardSurgeAdapter | null = null
export function initGlobalSurge(opts: { apiKey?: string; symbols?: string[]; staleMs?: number }) {
  if (_instance) return _instance
  if (!opts.apiKey || !opts.symbols || !opts.symbols.length) return null
  _instance = new SwitchboardSurgeAdapter(opts.apiKey, opts.symbols, { staleMs: opts.staleMs })
  _instance.start().catch(()=>{})
  return _instance
}
export function getGlobalSurge(): SwitchboardSurgeAdapter | null { return _instance }
