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

const WHALE_THRESHOLDS: Record<string, bigint> = {
  WMON: 10000n * 10n ** 18n,
  USDC: 30000n * 10n ** 6n,
  CHOG: 100000n * 10n ** 18n,
  YAKI: 100000n * 10n ** 18n,
  DAK: 100000n * 10n ** 18n,
  BEAN: 100000n * 10n ** 18n,
  WBTC: 1n * 10n ** 8n,
  DAKIMAKURA: 100000n * 10n ** 18n,
}

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

function thresholdForSymbol(sym: string): bigint {
  return WHALE_THRESHOLDS[sym] ?? (10n ** 30n)
}

export function useWhaleTransfers(days: number = 7) {
  const [moves, setMoves] = useState<WhaleMove[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const envioEnabled = (import.meta.env.VITE_ENVIO_ENABLED === 'true')

  const since = useMemo(() => {
    const nowSec = Math.floor(Date.now() / 1000)
    return nowSec - days * 86400
  }, [days])

  useEffect(() => {
    if (!envioEnabled) { setMoves([]); setLoading(false); setError(null); return }
    let abort = new AbortController()
    async function run() {
      setLoading(true)
      setError(null)
      try {
        const tokenAddrs = Object.values(TOKENS)
          .filter(t => !t.isNative)
          .map(t => (t.address as string).toLowerCase())
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
          const thr = thresholdForSymbol(sym)
          try {
            const val = BigInt(r.value)
            if (val >= thr) {
              const dec = decimalsForSymbol(sym)
              const norm = Number(val) / Math.pow(10, dec)
              out.push({
                id: r.id,
                token: sym,
                tokenAddress: r.tokenAddress,
                from: r.from,
                to: r.to,
                valueRaw: r.value,
                value: norm,
                blockTimestamp: Number(r.blockTimestamp),
                transactionHash: r.transactionHash,
              })
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
  }, [envioEnabled, since])

  return { moves, loading, error }
}
