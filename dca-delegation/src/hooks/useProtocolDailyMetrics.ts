import { useEffect, useMemo, useState, useCallback } from 'react'
import { queryEnvio } from '../lib/envioClient'

export type ProtocolMetricKey = 'txDaily' | 'usersDaily' | 'txCumulative' | 'avgTxPerUser' | 'avgFeeNative'

export type ProtocolSeries = { protocolId: string; points: Array<{ x: string; y: number }> }

function dateISO(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function useProtocolDailyMetrics(metric: ProtocolMetricKey, days = 30) {
  const [series, setSeries] = useState<ProtocolSeries[]>([])
  const [dates, setDates] = useState<string[]>([])
  const [allRows, setAllRows] = useState<Array<any>>([])
  const [loading, setLoading] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const envioEnabled = ((import.meta.env.VITE_ENVIO_ENABLED ?? 'true') === 'true')

  const since = useMemo(() => {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() - days)
    d.setUTCHours(0, 0, 0, 0)
    const result = dateISO(d)
    console.log(`[useProtocolDailyMetrics] since=${result}, days=${days}`)
    return result
  }, [days])

  useEffect(() => {
    if (!envioEnabled) {
      setSeries([])
      setDates([])
      setAllRows([])
      setLoading(false)
      setError(null)
      return
    }
    let abort = new AbortController()

    async function run() {
      if (!initialized) setLoading(true)
      setError(null)
      try {
        console.log(`[useProtocolDailyMetrics] Querying with since=${since}`)
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
        console.log(`[useProtocolDailyMetrics] Got ${data.DailyMetrics?.length || 0} records`)
        let rows = data.DailyMetrics || []
        if (!rows || rows.length === 0) {
          const fallback = await queryEnvio<{ DailyMetrics: Array<any> }>({
            query: `query Q2 { 
              DailyMetrics(order_by: { dateISO: desc }, limit: 365) {
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
          rows = fallback.DailyMetrics.slice().reverse()
        }

        setAllRows(rows)
        const allDatesSet = new Set(rows.map(r => String(r.dateISO)))
        const allDates = Array.from(allDatesSet).sort()
        setHasMore(true)

        const byProtocol: Record<string, Array<{ x: string; y: number }>> = {}
        for (const row of rows) {
          const x = String(row.dateISO)
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

  const loadOlder = useCallback(async () => {
    if (!envioEnabled || dates.length === 0) return
    const oldest = dates[0]
    try {
      const older = await queryEnvio<{ DailyMetrics: Array<any> }>({
        query: `query Older($before:String!, $limit:Int!) {
          DailyMetrics(where:{ dateISO: { _lt: $before } }, order_by:{ dateISO: desc }, limit: $limit) {
            dateISO protocolId txDaily usersDaily txCumulative avgTxPerUser avgFeeNative
          }
        }`,
        variables: { before: oldest, limit: 365 }
      })
      const olderRows = (older.DailyMetrics || []).slice().reverse()
      if (olderRows.length === 0) { setHasMore(false); return }
      const merged = olderRows.concat(allRows)
      setAllRows(merged)
      const allDatesSet = new Set(merged.map(r => String(r.dateISO)))
      const newDates = Array.from(allDatesSet).sort()
      setDates(newDates)
      const byProtocol: Record<string, Array<{ x: string; y: number }>> = {}
      for (const row of merged) {
        const x = String(row.dateISO)
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
      const seriesOut: ProtocolSeries[] = Object.entries(byProtocol).map(([protocolId, points]) => ({ protocolId, points }))
      setSeries(seriesOut)
    } catch {}
  }, [envioEnabled, dates, allRows, metric])

  return { series, dates, loading, error, loadOlder, hasMore }
}
