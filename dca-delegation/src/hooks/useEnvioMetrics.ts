import { useEffect, useMemo, useState } from 'react'
import { queryEnvio } from '../lib/envioClient'
import { USDC, WMON, CHOG } from '../lib/tokens'

function startOfDayEpoch(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

function toMon(wei: bigint): number {
  return Number(wei) / 1e18
}

export interface EnvioMetrics {
  txToday: number
  feesTodayMon: number
  whales24h: Array<{ token: string; from: string; to: string; value: string; ts: number; tx: string }>
}

export function useEnvioMetrics(saAddress?: string) {
  const [metrics, setMetrics] = useState<EnvioMetrics>({ txToday: 0, feesTodayMon: 0, whales24h: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const envioEnabled = (import.meta.env.VITE_ENVIO_ENABLED === 'true')

  const tracked = useMemo(() => [USDC.toLowerCase(), WMON.toLowerCase(), CHOG.toLowerCase()], [])
  const since = useMemo(() => startOfDayEpoch(), [])
  const sinceWhale = useMemo(() => Math.floor(Date.now() / 1000) - 86400, [])

  useEffect(() => {
    if (!saAddress) return
    if (!envioEnabled) {
      // Disable Envio polling entirely to avoid CORS/network noise
      setLoading(false)
      setError(null)
      setMetrics({ txToday: 0, feesTodayMon: 0, whales24h: [] })
      return
    }

    let abort = new AbortController()
    async function run() {
      setLoading(true)
      setError(null)
      try {
        const from = (saAddress as string).toLowerCase()
        const transfers = await queryEnvio<{ TokenTransfer: Array<any> }>({
          query: `query T($from:String!,$since:Int!){
            TokenTransfer(filter:{ from:{eq:$from}, blockTimestamp:{gt:$since} }, orderBy:{blockTimestamp:DESC}, limit:1000){
              tokenAddress from to value blockTimestamp transactionHash gasUsed gasPrice
            }
          }`,
          variables: { from, since }
        }, abort.signal)

        const uniqTx = new Map<string, { gasUsed: bigint; gasPrice: bigint }>()
        let txCount = 0
        for (const t of transfers.TokenTransfer) {
          if (!tracked.includes(String(t.tokenAddress).toLowerCase())) continue
          const txh: string = t.transactionHash
          if (!uniqTx.has(txh)) {
            uniqTx.set(txh, { gasUsed: BigInt(t.gasUsed ?? 0), gasPrice: BigInt(t.gasPrice ?? 0) })
            txCount += 1
          }
        }
        let feeWei = 0n
        uniqTx.forEach(({ gasUsed, gasPrice }) => { feeWei += gasUsed * gasPrice })

        const whales: Array<{ token: string; from: string; to: string; value: string; ts: number; tx: string }> = []
        const whaleQueries = [
          { token: USDC.toLowerCase(), min: (10000n * 10n ** 6n).toString() },
          { token: WMON.toLowerCase(), min: (10000n * 10n ** 18n).toString() },
          { token: CHOG.toLowerCase(), min: (100000n * 10n ** 18n).toString() },
        ]
        for (const w of whaleQueries) {
          const data = await queryEnvio<{ TokenTransfer: Array<any> }>({
            query: `query W($token:String!,$min:BigInt!,$since:Int!){
              TokenTransfer(filter:{ tokenAddress:{eq:$token}, value:{gt:$min}, blockTimestamp:{gt:$since} }, orderBy:{blockTimestamp:DESC}, limit:20){
                tokenAddress from to value blockTimestamp transactionHash
              }
            }`,
            variables: { token: w.token, min: w.min, since: sinceWhale }
          }, abort.signal)
          for (const t of data.TokenTransfer) {
            whales.push({ token: t.tokenAddress, from: t.from, to: t.to, value: String(t.value), ts: Number(t.blockTimestamp), tx: t.transactionHash })
          }
        }

        setMetrics({ txToday: txCount, feesTodayMon: toMon(feeWei), whales24h: whales })
      } catch (e: any) {
        if (abort.signal.aborted) return
        setError(e.message || String(e))
      } finally {
        if (!abort.signal.aborted) setLoading(false)
      }
    }

    run()
    const id = setInterval(run, 15000)
    return () => { abort.abort(); clearInterval(id) }
  }, [saAddress, tracked, since, sinceWhale, envioEnabled])

  return { metrics, loading, error }
}
