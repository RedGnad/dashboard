import { useEffect, useMemo, useState } from 'react'
import { queryEnvio } from '../lib/envioClient'
import { TOKENS } from '../lib/tokens'

export type WhaleMove = {
  id: string
  token: string
  tokenAddress: `0x${string}`
  from: string
  to: string
  valueRaw: string
  value: number
  blockTimestamp: number
  transactionHash: string
}

// thresholds can be extended if needed; currently derived from env

function symbolFromAddress(addr: string): string | null {
  const a = addr.toLowerCase()
  for (const t of Object.values(TOKENS)) {
    if ((t.address as string).toLowerCase() === a) return t.symbol
  }
  return null
}

function decimalsForSymbol(sym: string): number {
  const t = TOKENS[sym as keyof typeof TOKENS]
  return t?.decimals ?? 18
}

// NOTE: thresholds reduced to WMON only in MON-only mode

export function useWhaleTransfers(days: number = 7) {
  const [moves, setMoves] = useState<WhaleMove[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const envioEnabled = (import.meta.env.VITE_ENVIO_ENABLED === 'true')
  const whaleEnabled = (import.meta.env.VITE_WHALE_NOTIFICATIONS !== 'false')
  const whaleMonOnly = (import.meta.env.VITE_WHALE_MON_ONLY !== 'false')
  const monThreshold = Number(import.meta.env.VITE_WHALE_MON_THRESHOLD ?? 10000)

  // token metrics unused in current UI; keep hook minimal

  const since = useMemo(() => {
    const nowSec = Math.floor(Date.now() / 1000)
    return nowSec - days * 86400
  }, [days])

  useEffect(() => {
    if (!envioEnabled || !whaleEnabled) { setMoves([]); setLoading(false); setError(null); return }
    let abort = new AbortController()
    async function run() {
      setLoading(true)
      setError(null)
      try {
        let tokenAddrs = Object.values(TOKENS)
          .filter(t => !t.isNative)
          .map(t => (t.address as string).toLowerCase())
        if (whaleMonOnly) {
          const w = Object.values(TOKENS).find(t => t.symbol === 'WMON')
          tokenAddrs = w ? [String(w.address).toLowerCase()] : []
        }
        const res = await queryEnvio<{ TokenTransfer: Array<any> }>({
          query: `query Whale($since:Int!, $tokens:[String!]) { 
            TokenTransfer(where:{ blockTimestamp: { _gte: $since }, tokenAddress: { _in: $tokens } }, order_by:{ blockTimestamp: desc }, limit: 2000) {
              id tokenAddress from to value blockTimestamp transactionHash
            }
          }`,
          variables: { since, tokens: tokenAddrs }
        }, abort.signal)
        const rows = res.TokenTransfer || []
        const out: WhaleMove[] = []
        for (const r of rows) {
          const sym = symbolFromAddress(r.tokenAddress)
          if (!sym) continue
          try {
            const dec = decimalsForSymbol(sym)
            const val = BigInt(r.value)
            const amount = Number(val) / Math.pow(10, dec)
            if (!Number.isFinite(amount)) continue
            if (whaleMonOnly && sym !== 'WMON') continue
            if (sym === 'WMON') {
              if (amount >= monThreshold) {
                out.push({
                  id: r.id,
                  token: sym,
                  tokenAddress: r.tokenAddress,
                  from: r.from,
                  to: r.to,
                  valueRaw: r.value,
                  value: amount,
                  blockTimestamp: Number(r.blockTimestamp),
                  transactionHash: r.transactionHash,
                })
              }
            }
          } catch {}
        }
        setMoves(out)
      } catch (e: any) {
        if (!abort.signal.aborted) setError(e.message || String(e))
      } finally {
        if (!abort.signal.aborted) setLoading(false)
      }
    }
    run()
    const id = setInterval(run, 60000)
    return () => { abort.abort(); clearInterval(id) }
  }, [envioEnabled, whaleEnabled, whaleMonOnly, monThreshold, since])

  return { moves, loading, error }
}
