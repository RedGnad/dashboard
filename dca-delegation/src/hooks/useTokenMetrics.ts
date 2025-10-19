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
        // Gather tracked token addresses
        const tracked = Object.values(TOKENS)
          .filter(t => !t.isNative)
          .map(t => (t.address as string).toLowerCase())

        // Fetch recent swaps (UniversalRouter), Kuru trades + markets, and TokenMetrics in parallel
        const [swAndKuru, tmData] = await Promise.all([
          queryEnvio<{ SwapEvent: Array<any>; Kuru_Trade: Array<any>; Kuru_MarketRegistered: Array<any> }>({
            query: `query Recent {
              SwapEvent(order_by: { blockTimestamp: desc }, limit: 1000) {
                tokenIn tokenOut price amountIn amountOut blockTimestamp
              }
              Kuru_Trade(order_by: { blockTimestamp: desc }, limit: 1000) {
                market price filledSize isBuy blockTimestamp
              }
              Kuru_MarketRegistered(order_by: { blockTimestamp: desc }, limit: 200) {
                id market baseAsset quoteAsset pricePrecision
              }
            }`
          }, abort.signal),
          queryEnvio<{ TokenMetrics: Array<any> }>({
            query: `query TM($tokens:[String!]) {
              TokenMetrics(where:{ tokenAddress: { _in: $tokens } }){
                tokenAddress
                tokenSymbol
                hourlyVolume
                dailyVolume
                volatilityScore
                momentumScore
                transferCount
                lastTransferTime
              }
            }`,
            variables: { tokens: tracked }
          }, abort.signal)
        ])

        // Derive swap-like entries from Kuru trades if needed
        const regByMarket = new Map<string, any>()
        for (const r of (swAndKuru.Kuru_MarketRegistered || [])) {
          regByMarket.set(String(r.market).toLowerCase(), r)
        }
        const derivedFromKuru: Array<any> = []
        for (const t of (swAndKuru.Kuru_Trade || [])) {
          const market = String(t.market || '').toLowerCase()
          const reg = regByMarket.get(market)
          if (!reg) continue
          try {
            const base = String(reg.baseAsset)
            const quote = String(reg.quoteAsset)
            const priceRaw = BigInt(String(t.price))
            const filledRaw = BigInt(String(t.filledSize))
            const pricePrecision = Number(reg.pricePrecision || 0)
            const scale = BigInt(10) ** BigInt(isNaN(pricePrecision) ? 0 : pricePrecision)
            const quoteAmount = scale > 0n ? (filledRaw * priceRaw) / scale : (filledRaw * priceRaw)
            const isBuy = Boolean(t.isBuy)
            const tokenIn = isBuy ? quote : base
            const tokenOut = isBuy ? base : quote
            const amountIn = isBuy ? quoteAmount : filledRaw
            const amountOut = isBuy ? filledRaw : quoteAmount
            let price = 0
            try {
              const ain = amountIn as any as bigint
              const aout = amountOut as any as bigint
              if (ain !== 0n) {
                const SCALE = 10n ** 9n
                const q = (aout * SCALE) / ain
                price = Number(q) / 1e9
              } else {
                price = 0
              }
              if (!Number.isFinite(price) || Number.isNaN(price) || price <= 0) price = 0
            } catch { price = 0 }
            derivedFromKuru.push({
              tokenIn, tokenOut, price,
              amountIn: amountIn.toString(),
              amountOut: amountOut.toString(),
              blockTimestamp: t.blockTimestamp,
            })
          } catch {}
        }

        const swapsCombined = [
          ...(swAndKuru.SwapEvent || []),
          ...derivedFromKuru,
        ]

        const metrics = calculateTokenMetrics(swapsCombined, tmData.TokenMetrics)
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

function calculateTokenMetrics(swaps: any[], tokenMetricsRaw: any[]): TokenMetrics[] {
  const tokenList = Object.values(TOKENS)
    .filter(t => !t.isNative)
    .map(t => ({ symbol: t.symbol, address: t.address.toLowerCase() }))
  const metrics: TokenMetrics[] = []
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
  const tmByAddr = new Map<string, any>()
  for (const m of (tokenMetricsRaw || [])) {
    tmByAddr.set(String(m.tokenAddress).toLowerCase(), m)
  }

  // Compute USDC per WMON from recent swaps if available
  const usdc = (USDC_ADDR as string).toLowerCase()
  const wmon = (WMON_ADDR as string).toLowerCase()
  const wmonUsdcSamples: number[] = []
  for (const s of swaps) {
    const tin = s.tokenIn?.toLowerCase?.()
    const tout = s.tokenOut?.toLowerCase?.()
    const p = Number(s.price || 0)
    if (!Number.isFinite(p) || p <= 0) continue
    if (tin === wmon && tout === usdc) {
      wmonUsdcSamples.push(p) // USDC per WMON
    } else if (tin === usdc && tout === wmon) {
      wmonUsdcSamples.push(1 / p) // invert to USDC per WMON
    }
    if (wmonUsdcSamples.length >= 50) break
  }
  const usdcPerWmon = wmonUsdcSamples.length ? (wmonUsdcSamples.reduce((a,b)=>a+b,0) / wmonUsdcSamples.length) : NaN

  for (const t of tokenList) {
    const addr = t.address
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

    const tm = tmByAddr.get(addr)
    const tokenMeta = TOKENS[t.symbol as keyof typeof TOKENS]
    const decimals = tokenMeta?.decimals ?? 18
    const vol24FromTM = tm ? (Number(tm.dailyVolume || 0) / Math.pow(10, decimals)) : 0
    const volScore = tm ? Number(tm.volatilityScore || 0) : 0
    const momScore = tm ? Number(tm.momentumScore || 0) : 0
    const liquidityScore = Math.min(1, (Number(tm?.transferCount || 0) + vol24FromTM) / 1000)

    if (baseSwaps.length === 0) {
      metrics.push({
        token: t.symbol,
        price: 1.0,
        priceChange24h: 0,
        volume24h: vol24FromTM,
        volatility: volScore,
        momentum: momScore,
        liquidityScore,
        trend: (momScore > 2 ? 'bullish' : momScore < -2 ? 'bearish' : 'sideways')
      })
      continue
    }

    let normalizedPrices = baseSwaps.map((s: any) => {
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

    // If using WMON base, convert to USDC using usdcPerWmon when available
    if (!useUsdc && Number.isFinite(usdcPerWmon) && usdcPerWmon > 0) {
      normalizedPrices = normalizedPrices.map(v => v * usdcPerWmon)
    }

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
    const volume24h = vol24FromTM || baseSwaps.reduce((sum: number, swap: any) => sum + (parseFloat(swap.amountIn) || 0), 0)
    const prices = normalizedPrices.slice(0, 50)
    const avgPrice = prices.reduce((sum, p) => sum + p, 0) / prices.length
    const variance = prices.reduce((sum, p) => sum + Math.pow(p - avgPrice, 2), 0) / prices.length
    const volatility = (volScore || (avgPrice > 0 ? Math.sqrt(variance) / avgPrice * 100 : 0))
    const recentPrices = prices.slice(0, 10)
    const olderPrices = prices.slice(10, 30)
    const recentAvg = recentPrices.length ? recentPrices.reduce((sum, p) => sum + p, 0) / recentPrices.length : avgPrice
    const olderAvg = olderPrices.length ? olderPrices.reduce((sum, p) => sum + p, 0) / olderPrices.length : avgPrice
    const momentum = (momScore || (olderAvg > 0 ? ((recentAvg - olderAvg) / olderAvg) * 100 : 0))
    const liquidityScoreCalc = Math.min(1, (baseSwaps.length * volume24h) / 10000)
    const liq = liquidityScore || liquidityScoreCalc
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
      liquidityScore: liq,
      trend
    })
  }

  return metrics
}
