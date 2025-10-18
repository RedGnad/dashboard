import { useEffect, useMemo, useState } from 'react'
import { queryEnvio } from '../lib/envioClient'

export type TodayMetricKey = 'usersDaily' | 'txDaily'

export type ProtocolToday = {
  protocolId: string
  usersDaily: number
  txDaily: number
}

export type ProtocolLatest = {
  protocolId: string
  txCumulative: number
  avgTxPerUser: number
  avgFeeNative: number | null
}

function dateISO(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function useTodayProtocolMetrics(daysFallbackScan = 300) {
  const [todayData, setTodayData] = useState<ProtocolToday[]>([])
  const [latestData, setLatestData] = useState<ProtocolLatest[]>([])
  const [loading, setLoading] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const envioEnabled = ((import.meta.env.VITE_ENVIO_ENABLED ?? 'true') === 'true')

  const today = useMemo(() => {
    const d = new Date()
    d.setUTCHours(0, 0, 0, 0)
    return dateISO(d)
  }, [])

  useEffect(() => {
    if (!envioEnabled) {
      setTodayData([])
      setLatestData([])
      setLoading(false)
      setError(null)
      return
    }
    let abort = new AbortController()

    async function run() {
      if (!initialized) setLoading(true)
      setError(null)
      try {
        // Today-only rows
        const t = await queryEnvio<{ DailyMetrics: Array<any> }>({
          query: `query T($today: String!) {
            DailyMetrics(
              where: { dateISO: { _eq: $today } }
              order_by: { protocolId: asc }
              limit: 1000
            ) {
              protocolId
              dateISO
              usersDaily
              txDaily
              txCumulative
              avgTxPerUser
              avgFeeNative
            }
          }`,
          variables: { today }
        }, abort.signal)

        // Fallback for latest cumulative per protocol: take last seen row per protocol from descending scan
        const f = await queryEnvio<{ DailyMetrics: Array<any> }>({
          query: `query L { 
            DailyMetrics(order_by: { dateISO: desc }, limit: ${daysFallbackScan}) {
              protocolId
              dateISO
              usersDaily
              txDaily
              txCumulative
              avgTxPerUser
              avgFeeNative
            }
          }`
        }, abort.signal)

        const todayOut: ProtocolToday[] = (t.DailyMetrics || []).map(row => ({
          protocolId: String(row.protocolId),
          usersDaily: Number(row.usersDaily || 0),
          txDaily: Number(row.txDaily || 0),
        }))

        const latestByProtocol = new Map<string, any>()
        for (const row of (f.DailyMetrics || [])) {
          const pid = String(row.protocolId)
          if (!latestByProtocol.has(pid)) latestByProtocol.set(pid, row)
        }
        const latestOut: ProtocolLatest[] = Array.from(latestByProtocol.entries()).map(([protocolId, row]) => ({
          protocolId,
          txCumulative: Number(row.txCumulative || 0),
          avgTxPerUser: Number(row.avgTxPerUser || 0),
          avgFeeNative: (row.avgFeeNative == null ? null : Number(row.avgFeeNative)),
        }))

        setTodayData(todayOut)
        setLatestData(latestOut)
        if (!initialized) setInitialized(true)
      } catch (e: any) {
        if (!abort.signal.aborted) setError(e.message || String(e))
      } finally {
        if (!abort.signal.aborted && !initialized) setLoading(false)
      }
    }

    run()
    const id = setInterval(run, 20000)
    return () => { abort.abort(); clearInterval(id) }
  }, [today, envioEnabled, daysFallbackScan, initialized])

  return { today, todayData, latestData, loading, error }
}
