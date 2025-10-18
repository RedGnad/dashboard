import { useEffect, useMemo, useState } from 'react'
import { queryEnvio } from '../lib/envioClient'

export type ProtocolMetricKey = 'txDaily' | 'usersDaily' | 'txCumulative' | 'avgTxPerUser' | 'avgFeeNative'

export type ProtocolSeries = { protocolId: string; points: Array<{ x: string; y: number }> }

function dateISO(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function useProtocolDailyMetrics(metric: ProtocolMetricKey, days = 30) {
  const [series, setSeries] = useState<ProtocolSeries[]>([])
  const [dates, setDates] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const envioEnabled = ((import.meta.env.VITE_ENVIO_ENABLED ?? 'true') === 'true')

  const since = useMemo(() => {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() - days)
    d.setUTCHours(0, 0, 0, 0)
    return dateISO(d)
  }, [days])

  useEffect(() => {
    if (!envioEnabled) {
      setSeries([])
      setDates([])
      setLoading(false)
      setError(null)
      return
    }
    let abort = new AbortController()

    async function run() {
      if (!initialized) setLoading(true)
      setError(null)
      try {
        let data = await queryEnvio<{ DailyMetrics: Array<any> }>({
          query: `query Q($since: String!) {
            DailyMetrics(
              where: { dateISO: { _gte: $since } }
              order_by: { dateISO: asc }
              limit: 10000
            ) {
              dateISO
              protocolId
              txDaily
              usersDaily
              txCumulative
              avgTxPerUser
              avgFeeNative
            }
          }`,
          variables: { since }
        }, abort.signal)

        // Fallback: if no recent days, fetch latest 30 rows by date desc
        if (!data.DailyMetrics || data.DailyMetrics.length === 0) {
          const fallback = await queryEnvio<{ DailyMetrics: Array<any> }>({
            query: `query Q2 { 
              DailyMetrics(order_by: { dateISO: desc }, limit: 300) {
                dateISO
                protocolId
                txDaily
                usersDaily
                txCumulative
                avgTxPerUser
                avgFeeNative
              }
            }`
          }, abort.signal)
          data = { DailyMetrics: fallback.DailyMetrics.slice().reverse() }
        }

        const byProtocol: Record<string, Array<{ x: string; y: number }>> = {}
        const allDatesSet = new Set<string>()
        for (const row of data.DailyMetrics) {
          const x = String(row.dateISO)
          allDatesSet.add(x)
          const key = String(row.protocolId)
          let yRaw: any = null
          switch (metric) {
            case 'txDaily': yRaw = row.txDaily; break
            case 'usersDaily': yRaw = row.usersDaily; break
            case 'txCumulative': yRaw = row.txCumulative; break
            case 'avgTxPerUser': yRaw = row.avgTxPerUser; break
            case 'avgFeeNative': yRaw = row.avgFeeNative; break
          }
          const y = typeof yRaw === 'string' ? Number(yRaw) : Number(yRaw ?? 0)
          if (!byProtocol[key]) byProtocol[key] = []
          byProtocol[key].push({ x, y })
        }
        const allDates = Array.from(allDatesSet).sort()
        const seriesOut: ProtocolSeries[] = Object.entries(byProtocol).map(([protocolId, points]) => ({ protocolId, points }))
        setSeries(seriesOut)
        setDates(allDates)
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
  }, [metric, since, envioEnabled, initialized])

  return { series, dates, loading, error }
}
