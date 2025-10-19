import { useEffect, useMemo, useState } from 'react'
import { queryEnvio } from '../lib/envioClient'
import { USDC, WMON, TOKENS } from '../lib/tokens'

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
  const since = useMemo(() => Math.floor(Date.now() / 1000) - 30 * 86400, [])

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
    if (!envioEnabled) {
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
        const data = await queryEnvio<{ usdc: any[]; wmon: any[] }>({
          query: `query W($since:Int!, $usdc:String!, $usdcMin:numeric!, $wmon:String!, $wmonMin:numeric!) {
            usdc: TokenTransfer(where:{ tokenAddress:{ _eq:$usdc }, value:{ _gt:$usdcMin }, blockTimestamp:{ _gt:$since } }, order_by:{ blockTimestamp: desc }, limit: 20){ tokenAddress from to value blockTimestamp transactionHash }
            wmon: TokenTransfer(where:{ tokenAddress:{ _eq:$wmon }, value:{ _gt:$wmonMin }, blockTimestamp:{ _gt:$since } }, order_by:{ blockTimestamp: desc }, limit: 20){ tokenAddress from to value blockTimestamp transactionHash }
          }`,
          variables: {
            since,
            usdc: USDC.toLowerCase(),
            usdcMin: (10000n * 10n ** BigInt(TOKENS.USDC.decimals)).toString(),
            wmon: WMON.toLowerCase(),
            wmonMin: (10000n * 10n ** BigInt(TOKENS.WMON.decimals)).toString(),
          }
        }, abort.signal)
        const combined: WhaleAlert[] = []
        for (const t of [...data.usdc, ...data.wmon]) {
          combined.push({ token: t.tokenAddress, from: t.from, to: t.to, value: String(t.value), ts: Number(t.blockTimestamp), tx: t.transactionHash })
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
