import { useEffect, useState } from 'react'
import { queryEnvio } from '../lib/envioClient'
import type { TokenMetrics } from '../lib/aiAgent'

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
          query: `query RecentSwaps($since: Int!) {
            SwapEvent(
              where: { blockTimestamp: { _gt: $since } }
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
          }`,
          variables: { since: Math.floor(Date.now() / 1000) - 86400 } // Last 24h
        }, abort.signal)

        // Get pair metrics for volatility/momentum
        const pairData = await queryEnvio<{ PairMetrics: Array<any> }>({
          query: `query PairMetrics($since: Int!) {
            PairMetrics(
              where: { lastUpdate: { _gt: $since } }
              order_by: { lastUpdate: desc }
              limit: 100
            ) {
              pairKey
              hour
              swapCount
              totalVolumeIn
              totalVolumeOut
              highPrice
              lowPrice
              openPrice
              closePrice
              lastUpdate
            }
          }`,
          variables: { since: Math.floor(Date.now() / 1000) - 86400 }
        }, abort.signal)

        const metrics = calculateTokenMetrics(swapsData.SwapEvent, pairData.PairMetrics)
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
  const tokens = ['USDC', 'CHOG', 'WMON']
  const metrics: TokenMetrics[] = []

  for (const token of tokens) {
    // Find relevant swaps for this token
    const tokenSwaps = swaps.filter(s => 
      s.tokenIn?.toLowerCase().includes(token.toLowerCase()) || 
      s.tokenOut?.toLowerCase().includes(token.toLowerCase())
    )

    if (tokenSwaps.length === 0) {
      // Default metrics if no data
      metrics.push({
        token,
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

    // Calculate current price (latest swap)
    const latestSwap = tokenSwaps[0]
    const currentPrice = latestSwap.price || 1.0

    // Calculate 24h price change
    const oldestSwap = tokenSwaps[tokenSwaps.length - 1]
    const oldPrice = oldestSwap.price || currentPrice
    const priceChange24h = oldPrice > 0 ? ((currentPrice - oldPrice) / oldPrice) * 100 : 0

    // Calculate volume
    const volume24h = tokenSwaps.reduce((sum, swap) => {
      return sum + (parseFloat(swap.amountIn) || 0)
    }, 0)

    // Calculate volatility (price standard deviation)
    const prices = tokenSwaps.map(s => s.price || 1.0).slice(0, 50) // Last 50 swaps
    const avgPrice = prices.reduce((sum, p) => sum + p, 0) / prices.length
    const variance = prices.reduce((sum, p) => sum + Math.pow(p - avgPrice, 2), 0) / prices.length
    const volatility = Math.sqrt(variance) / avgPrice * 100

    // Calculate momentum (short vs long term average)
    const recentPrices = prices.slice(0, 10)
    const olderPrices = prices.slice(10, 30)
    const recentAvg = recentPrices.reduce((sum, p) => sum + p, 0) / recentPrices.length
    const olderAvg = olderPrices.reduce((sum, p) => sum + p, 0) / olderPrices.length
    const momentum = olderAvg > 0 ? ((recentAvg - olderAvg) / olderAvg) * 100 : 0

    // Simple liquidity score based on swap count and volume
    const liquidityScore = Math.min(1, (tokenSwaps.length * volume24h) / 10000)

    // Determine trend
    let trend: 'bullish' | 'bearish' | 'sideways' = 'sideways'
    if (priceChange24h > 5 && momentum > 2) trend = 'bullish'
    else if (priceChange24h < -5 && momentum < -2) trend = 'bearish'

    metrics.push({
      token,
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
