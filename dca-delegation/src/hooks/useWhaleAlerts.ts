import { useEffect, useMemo, useState } from 'react'
import { queryEnvio } from '../lib/envioClient'
import { USDC, TOKENS } from '../lib/tokens'
import { useTokenMetrics } from './useTokenMetrics'

export type WhaleAlert = {
  token: string
  from: string
  to: string
  value: string
  ts: number
  tx: string
}

const LS_KEY = 'whale_seen_v1'

function loadSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return new Set()
    const arr: string[] = JSON.parse(raw)
    return new Set(arr)
  } catch {
    return new Set()
  }
}

function saveSeen(set: Set<string>) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(Array.from(set)))
  } catch {}
}

export function useWhaleAlerts() {
  const [alerts, setAlerts] = useState<WhaleAlert[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const envioEnabled = (import.meta.env.VITE_ENVIO_ENABLED === 'true')
  const whaleEnabled = (import.meta.env.VITE_WHALE_NOTIFICATIONS !== 'false')
  const whaleMonOnly = (import.meta.env.VITE_WHALE_MON_ONLY !== 'false')
  const monThreshold = Number(import.meta.env.VITE_WHALE_MON_THRESHOLD ?? 10000)
  const usdThreshold = Number(import.meta.env.VITE_WHALE_USD_THRESHOLD ?? 30000)
  const minUsd = Number(import.meta.env.VITE_WHALE_MIN_USD ?? 100)
  const since = useMemo(() => Math.floor(Date.now() / 1000) - 7 * 86400, [])
  const { tokenMetrics } = useTokenMetrics()
  const priceBySymbol = useMemo(() => {
    const m: Record<string, number> = {}
    for (const tm of tokenMetrics) {
      if (Number.isFinite(tm.price) && tm.price > 0) m[tm.token] = tm.price
    }
    return m
  }, [tokenMetrics])

  const [seen, setSeen] = useState<Set<string>>(() => loadSeen())
  const unseen = useMemo(() => alerts.filter(a => !seen.has(a.tx)), [alerts, seen])

  useEffect(() => { saveSeen(seen) }, [seen])

  function markSeen(tx: string) {
    setSeen(prev => new Set(prev).add(tx))
  }

  // Optimistic dismiss: mark as seen and prune from current alerts for instant UI close
  function dismiss(tx: string) {
    setSeen(prev => {
      const next = new Set(prev)
      next.add(tx)
      return next
    })
    setAlerts(prev => prev.filter(a => a.tx !== tx))
  }

  useEffect(() => {
    if (!envioEnabled || !whaleEnabled) {
      setAlerts([])
      setLoading(false)
      setError(null)
      return
    }
    let abort = new AbortController()

    async function run() {
      setLoading(true)
      setError(null)
      try {
        // Build tracked token list from TOKENS
        let tracked = Object.values(TOKENS)
          .map(t => (t.address as string).toLowerCase())
        if (whaleMonOnly) {
          const wmon = Object.values(TOKENS).find(t => t.symbol === 'WMON')
          tracked = wmon ? [String(wmon.address).toLowerCase()] : []
        }

        // Fetch recent transfers across our tokens
        const data = await queryEnvio<{ TokenTransfer: any[] }>({
          query: `query W($since:Int!, $tokens:[String!]) {
            TokenTransfer(
              where:{ tokenAddress:{ _in:$tokens }, blockTimestamp:{ _gt:$since } }
              order_by:{ blockTimestamp: desc }
              limit: 200
            ){
              tokenAddress from to value blockTimestamp transactionHash
            }
          }`,
          variables: { since, tokens: tracked }
        }, abort.signal)

        // Convert to USD-equivalent using tokenMetrics price when available
        const combined: WhaleAlert[] = []
        const seenKeys = new Set<string>()
        for (const t of data.TokenTransfer) {
          const key = `${String(t.transactionHash).toLowerCase()}:${String(t.tokenAddress).toLowerCase()}`
          if (seenKeys.has(key)) continue
          seenKeys.add(key)

          const addr = String(t.tokenAddress).toLowerCase()
          const tok = Object.values(TOKENS).find(x => (x.address as string).toLowerCase() === addr)
          if (!tok) continue
          const decimals = tok.decimals || 18
          const amount = Number(String(t.value)) / Math.pow(10, decimals)
          if (!Number.isFinite(amount)) continue

          const isWMon = tok.symbol === 'WMON'
          if (whaleMonOnly && !isWMon) continue

          let eqUSDC = 0
          if (!isWMon) {
            if ((tok.address as string).toLowerCase() === USDC.toLowerCase()) {
              eqUSDC = amount
            } else {
              const price = priceBySymbol[tok.symbol]
              if (!Number.isFinite(price) || price <= 0) continue
              eqUSDC = amount * price
            }
            if (eqUSDC < minUsd) continue
          }

          const isWhale = isWMon ? (amount >= monThreshold) : (eqUSDC >= usdThreshold)
          if (isWhale) {
            combined.push({ token: t.tokenAddress, from: t.from, to: t.to, value: String(t.value), ts: Number(t.blockTimestamp), tx: t.transactionHash })
          }
        }
        // Sort by ts desc
        combined.sort((a, b) => b.ts - a.ts)
        setAlerts(combined)
      } catch (e: any) {
        if (!abort.signal.aborted) setError(e.message || String(e))
      } finally {
        if (!abort.signal.aborted) setLoading(false)
      }
    }

    run()
    const id = setInterval(run, 20000)
    return () => { abort.abort(); clearInterval(id) }
  }, [since, envioEnabled])

  return { alerts, unseen, loading, error, markSeen, dismiss }
}
