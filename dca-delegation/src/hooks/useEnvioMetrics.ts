import { useEffect, useMemo, useState } from 'react'
import { queryEnvio, getEnvioUrl } from '../lib/envioClient'
import { TOKENS, USDC } from '../lib/tokens'
import { useTokenMetrics } from './useTokenMetrics'

function startOfDayEpoch(): number {
  // Use UTC start of day to avoid local timezone mismatches with indexer timestamps
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

function toMon(wei: bigint): number {
  return Number(wei) / 1e18
}

export interface EnvioMetrics {
  txToday: number
  feesTodayMon: number
  whales24h: Array<{ token: string; from: string; to: string; value: string; ts: number; tx: string }>
  lastUpdated?: number
}

export function useEnvioMetrics(saAddress?: string) {
  const [metrics, setMetrics] = useState<EnvioMetrics>({ txToday: 0, feesTodayMon: 0, whales24h: [], lastUpdated: undefined })
  // Start in loading=true to avoid consumers reading default zeros before first fetch completes
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const envioEnabled = ((import.meta.env.VITE_ENVIO_ENABLED ?? 'true') === 'true')
  const debugEnvio = (((import.meta as any).env?.VITE_DEBUG_ENVIO ?? 'true') === 'true')
  // Thresholds: use per-user override via localStorage ('whaleThresholdUsd') with a code default; ignore env to avoid confusion
  const minUsd = Number((import.meta as any).env?.VITE_WHALE_MIN_USD ?? 100)

  const tracked = useMemo(() => Object.values(TOKENS).map(t => (t.address as string).toLowerCase()), [])
  const since = useMemo(() => startOfDayEpoch(), [])
  const sinceWhale = useMemo(() => Math.floor(Date.now() / 1000) - 7 * 86400, [])
  const { tokenMetrics } = useTokenMetrics()
  const priceBySymbol = useMemo(() => {
    const m: Record<string, number> = {}
    for (const tm of tokenMetrics) {
      if (Number.isFinite(tm.price) && tm.price > 0) m[tm.token] = tm.price
    }
    return m
  }, [tokenMetrics])

  // Hydrate from cache quickly to avoid "pending" feel at startup
  useEffect(() => {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('envio:metrics') : null
      if (raw) {
        const cached = JSON.parse(raw)
        if (cached && typeof cached === 'object') {
          setMetrics({
            txToday: Number(cached.txToday) || 0,
            feesTodayMon: Number(cached.feesTodayMon) || 0,
            whales24h: Array.isArray(cached.whales24h) ? cached.whales24h : [],
            lastUpdated: Number(cached.lastUpdated) || Date.now(),
          })
          setLoading(false)
        }
      }
    } catch {}
  }, [])

  useEffect(() => {
    // Even without saAddress we still compute global market activity and whales
    if (!envioEnabled) {
      // Disable Envio polling entirely to avoid CORS/network noise
      setLoading(false)
      setError(null)
      setMetrics({ txToday: 0, feesTodayMon: 0, whales24h: [], lastUpdated: Date.now() })
      return
    }

    let consecutiveErrors = 0
    const hadFreshCache = !!metrics?.lastUpdated && (Date.now() - (metrics.lastUpdated || 0) < 30 * 1000)
    let currentAbort: AbortController | null = null
    
    async function run() {
      // Create fresh AbortController for each request batch
      if (currentAbort) {
        try { currentAbort.abort('new-request') } catch {}
      }
      currentAbort = new AbortController()
      const abort = currentAbort
      
      // Si on a un cache frais, ne pas remettre en "loading" ni effacer l'erreur tout de suite
      if (!hadFreshCache) {
        setLoading(true)
        setError(null)
      }
      try {
        // 1) Global market activity today from multiple sources (unique tx hashes)
        // Séparer les requêtes car les données sont sur des endpoints différents
        const [preciseData, fastData] = await Promise.all([
          // PRECISE endpoint : SwapEvent + Kuru_Trade
          queryEnvio<{ SwapEvent: Array<any>; Kuru_Trade: Array<any> }>({
            query: `query PreciseActivity($since:Int!){
              SwapEvent(where:{ blockTimestamp: { _gt: $since } }, order_by:{ blockTimestamp: desc }, limit: 1000){ transactionHash }
              Kuru_Trade(where:{ blockTimestamp: { _gt: $since } }, order_by:{ blockTimestamp: desc }, limit: 1000){ transactionHash }
            }`,
            variables: { since }
          }, abort.signal, 'PRECISE'),
          
          // FAST endpoint : TokenTransfer
          queryEnvio<{ TokenTransfer: Array<any> }>({
            query: `query FastActivity($since:Int!,$tokens:[String!]){
              TokenTransfer(where:{ tokenAddress: { _in: $tokens }, blockTimestamp: { _gt: $since } }, order_by:{ blockTimestamp: desc }, limit: 1000){ transactionHash }
            }`,
            variables: { since, tokens: tracked }
          }, abort.signal, 'FAST')
        ])
        
        const uniq = new Set<string>()
        for (const e of (preciseData?.SwapEvent ?? [])) if (e?.transactionHash) uniq.add(String(e.transactionHash))
        for (const e of (preciseData?.Kuru_Trade ?? [])) if (e?.transactionHash) uniq.add(String(e.transactionHash))
        for (const e of (fastData?.TokenTransfer ?? [])) if (e?.transactionHash) uniq.add(String(e.transactionHash))
        const txCount = uniq.size
        
        console.log(`[useEnvioMetrics] Activity data:`, {
          swapEvents: preciseData?.SwapEvent?.length ?? 0,
          kuruTrades: preciseData?.Kuru_Trade?.length ?? 0, 
          tokenTransfers: fastData?.TokenTransfer?.length ?? 0,
          uniqueTxCount: txCount
        })

        // 2) Fees Today from SA-specific transfers (optional if saAddress provided)
        let feeWei = 0n
        if (saAddress) {
          const from = (saAddress as string).toLowerCase()
          const transfers = await queryEnvio<{ TokenTransfer: Array<any> }>({
            query: `query T($from:String!,$since:Int!){
              TokenTransfer(
                where: { from: { _eq: $from }, blockTimestamp: { _gt: $since } }
                order_by: { blockTimestamp: desc }
                limit: 1000
              ){
                tokenAddress from to value blockTimestamp transactionHash gasUsed gasPrice
              }
            }`,
            variables: { from, since }
          }, abort.signal, 'FAST')
          const uniqTx = new Map<string, { gasUsed: bigint; gasPrice: bigint }>()
          for (const t of transfers.TokenTransfer) {
            if (!tracked.includes(String(t.tokenAddress).toLowerCase())) continue
            const txh: string = t.transactionHash
            if (!uniqTx.has(txh)) {
              uniqTx.set(txh, { gasUsed: BigInt(t.gasUsed ?? 0), gasPrice: BigInt(t.gasPrice ?? 0) })
            }
          }
          uniqTx.forEach(({ gasUsed, gasPrice }) => { feeWei += gasUsed * gasPrice })
        }

  const whales: Array<{ token: string; from: string; to: string; value: string; ts: number; tx: string }> = []
        const tokenList = Object.values(TOKENS)
          .map(t => (t.address as string).toLowerCase())
        const wdata = await queryEnvio<{ TokenTransfer: Array<any> }>({
          query: `query W($tokens:[String!],$since:Int!){
            TokenTransfer(
              where: { tokenAddress: { _in: $tokens }, blockTimestamp: { _gt: $since } }
              order_by: { blockTimestamp: desc }
              limit: 200
            ){
              tokenAddress from to value blockTimestamp transactionHash
            }
          }`,
          variables: { tokens: tokenList, since: sinceWhale }
        }, abort.signal, 'FAST')
  // Read the latest user-defined threshold (if any) at fetch-time for real-time effect
  const userOverrideRaw = typeof localStorage !== 'undefined' ? localStorage.getItem('whaleThresholdUsd') : null
  const whaleUsdThreshold = Number(userOverrideRaw ?? 10000)
  for (const t of wdata.TokenTransfer) {
          const addr = String(t.tokenAddress).toLowerCase()
          const tok = Object.values(TOKENS).find(x => (x.address as string).toLowerCase() === addr)
          if (!tok) continue
          const decimals = tok.decimals || 18
          const amount = Number(String(t.value)) / Math.pow(10, decimals)
          if (!Number.isFinite(amount)) continue
          let eqUSDC = 0
          if ((tok.address as string).toLowerCase() === USDC.toLowerCase()) eqUSDC = amount
          else {
            const price = priceBySymbol[tok.symbol]
            if (!Number.isFinite(price) || price <= 0) continue
            eqUSDC = amount * price
          }
          if (eqUSDC < minUsd) continue
          if (eqUSDC >= whaleUsdThreshold) {
            whales.push({ token: t.tokenAddress, from: t.from, to: t.to, value: String(t.value), ts: Number(t.blockTimestamp), tx: t.transactionHash })
          }
        }

  const nowTs = Date.now()
  const next = { txToday: txCount, feesTodayMon: toMon(feeWei), whales24h: whales, lastUpdated: nowTs }
  setMetrics(next)
  try { if (typeof localStorage !== 'undefined') localStorage.setItem('envio:metrics', JSON.stringify(next)) } catch {}
        if (debugEnvio) {
          const endpoint = getEnvioUrl()
          console.info('[envio] metrics-ready', {
            endpoint,
            txToday: txCount,
            whales: whales.length,
            feesTodayMon: toMon(feeWei),
            sinceUTC: new Date(startOfDayEpoch()*1000).toISOString().slice(0,19)+'Z',
            lastUpdatedISO: new Date(nowTs).toISOString()
          })
        }
      } catch (e: any) {
        if (abort.signal.aborted) return
        consecutiveErrors++
        // Politique "gracieuse": si on a un cache frais, ne pas passer en Offline dès la 1ère erreur
        if (!hadFreshCache || consecutiveErrors > 1) {
          setError(e.message || String(e))
          setLoading(false)
        } else {
          // réessayer rapidement sans basculer l'UI
          setTimeout(() => { if (!abort.signal.aborted) run() }, 1500)
          return
        }
      } finally {
        if (!abort.signal.aborted) setLoading(false)
      }
    }

    run()
    const pollMs = Number((import.meta as any).env?.VITE_ENVIO_POLL_MS ?? 5000)
    const id = setInterval(run, Math.max(2000, pollMs))
    return () => { 
      try { 
        if (currentAbort) currentAbort.abort('unmount') 
      } catch { 
        if (currentAbort) currentAbort.abort() 
      }; 
      clearInterval(id) 
    }
  }, [saAddress, tracked, since, sinceWhale, envioEnabled])

  return { metrics, loading, error }
}
