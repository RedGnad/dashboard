import { useEffect, useState } from 'react'
import { queryEnvio } from '../lib/envioClient'
import type { TokenMetrics } from '../lib/aiAgent'
import { TOKENS, USDC as USDC_ADDR, WMON as WMON_ADDR } from '../lib/tokens'

export function useTokenMetrics() {
  const [tokenMetrics, setTokenMetrics] = useState<TokenMetrics[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const envioEnabled = (import.meta.env.VITE_ENVIO_ENABLED === 'true')

  useEffect(() => {
    if (!envioEnabled) {
      setLoading(false)
      setError(null)
      setTokenMetrics([])
      return
    }
    let abort = new AbortController()
    
    async function fetchTokenMetrics() {
      setLoading(true)
      setError(null)
      
      try {
        // Get recent swap events for price/volume analysis
        const swapsData = await queryEnvio<{ SwapEvent: Array<any> }>({
          query: `query RecentSwaps {
            SwapEvent(
              order_by: { blockTimestamp: desc }
              limit: 500
            ) {
              pairKey
              tokenIn
              tokenOut
              price
              amountIn
              amountOut
              blockTimestamp
            }
          }`
        }, abort.signal)

        const metrics = calculateTokenMetrics(swapsData.SwapEvent, [])
        setTokenMetrics(metrics)
      } catch (e: any) {
        if (abort.signal.aborted) return
        setError(e.message || String(e))
      } finally {
        if (!abort.signal.aborted) setLoading(false)
      }
    }

    fetchTokenMetrics()
    const interval = setInterval(fetchTokenMetrics, 30000) // Update every 30s
    
    return () => {
      abort.abort()
      clearInterval(interval)
    }
  }, [envioEnabled])

  return { tokenMetrics, loading, error }
}

function calculateTokenMetrics(swaps: any[], _pairMetrics: any[]): TokenMetrics[] {
  const tokenList = Object.values(TOKENS)
    .filter(t => !t.isNative)
    .map(t => ({ symbol: t.symbol, address: t.address.toLowerCase() }))
  const metrics: TokenMetrics[] = []
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

  for (const t of tokenList) {
    const addr = t.address
    const usdc = (USDC_ADDR as string).toLowerCase()
    const wmon = (WMON_ADDR as string).toLowerCase()
    const swapsUsdc = swaps.filter(s => (
      (s.tokenIn?.toLowerCase?.() === addr && s.tokenOut?.toLowerCase?.() === usdc) ||
      (s.tokenIn?.toLowerCase?.() === usdc && s.tokenOut?.toLowerCase?.() === addr)
    ))
    const isWmonLike = (tok?: string) => {
      const x = tok?.toLowerCase?.()
      return x === wmon || x === ZERO_ADDR
    }
    const swapsWmon = swaps.filter(s => (
      (s.tokenIn?.toLowerCase?.() === addr && isWmonLike(s.tokenOut)) ||
      (isWmonLike(s.tokenIn) && s.tokenOut?.toLowerCase?.() === addr)
    ))

    const useUsdc = swapsUsdc.length > 0
    const baseSwaps = useUsdc ? swapsUsdc : swapsWmon

    if (baseSwaps.length === 0) {
      metrics.push({
        token: t.symbol,
        price: 1.0,
        priceChange24h: 0,
        volume24h: 0,
        volatility: 0,
        momentum: 0,
        liquidityScore: 0.5,
        trend: 'sideways'
      })
      continue
    }

    const normalizedPrices = baseSwaps.map((s: any) => {
      const p = Number(s.price || 0)
      if (!Number.isFinite(p) || p <= 0) return null
      // Handler price = amountOut / amountIn.
      // If tokenIn == addr and tokenOut == base => basePerToken = price
      // If tokenIn == base and tokenOut == addr => tokenPerBase = price, so basePerToken = 1/price
      if (useUsdc) {
        if (s.tokenIn?.toLowerCase?.() === addr) return p               // USDC per token
        if (s.tokenIn?.toLowerCase?.() === usdc) return p > 0 ? (1 / p) : null
      } else {
        if (s.tokenIn?.toLowerCase?.() === addr && isWmonLike(s.tokenOut)) return p               // MON/WMON per token
        if (isWmonLike(s.tokenIn) && s.tokenOut?.toLowerCase?.() === addr) return p > 0 ? (1 / p) : null
      }
      return null
    }).filter((x: number | null) => x != null) as number[]

    if (normalizedPrices.length === 0) {
      metrics.push({
        token: t.symbol,
        price: 1.0,
        priceChange24h: 0,
        volume24h: 0,
        volatility: 0,
        momentum: 0,
        liquidityScore: 0.3,
        trend: 'sideways'
      })
      continue
    }

    const latestPrice = normalizedPrices[0]
    const currentPrice = latestPrice || 1.0
    const oldestPrice = normalizedPrices[normalizedPrices.length - 1]
    const oldPrice = oldestPrice || currentPrice
    const priceChange24h = oldPrice > 0 ? ((currentPrice - oldPrice) / oldPrice) * 100 : 0
    const volume24h = baseSwaps.reduce((sum: number, swap: any) => sum + (parseFloat(swap.amountIn) || 0), 0)
    const prices = normalizedPrices.slice(0, 50)
    const avgPrice = prices.reduce((sum, p) => sum + p, 0) / prices.length
    const variance = prices.reduce((sum, p) => sum + Math.pow(p - avgPrice, 2), 0) / prices.length
    const volatility = avgPrice > 0 ? Math.sqrt(variance) / avgPrice * 100 : 0
    const recentPrices = prices.slice(0, 10)
    const olderPrices = prices.slice(10, 30)
    const recentAvg = recentPrices.length ? recentPrices.reduce((sum, p) => sum + p, 0) / recentPrices.length : avgPrice
    const olderAvg = olderPrices.length ? olderPrices.reduce((sum, p) => sum + p, 0) / olderPrices.length : avgPrice
    const momentum = olderAvg > 0 ? ((recentAvg - olderAvg) / olderAvg) * 100 : 0
    const liquidityScore = Math.min(1, (baseSwaps.length * volume24h) / 10000)
    let trend: 'bullish' | 'bearish' | 'sideways' = 'sideways'
    if (priceChange24h > 5 && momentum > 2) trend = 'bullish'
    else if (priceChange24h < -5 && momentum < -2) trend = 'bearish'

    metrics.push({
      token: t.symbol,
      price: currentPrice,
      priceChange24h,
      volume24h,
      volatility,
      momentum,
      liquidityScore,
      trend
    })
  }

  return metrics
}
