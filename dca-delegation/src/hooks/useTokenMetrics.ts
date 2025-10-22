import { useEffect, useState } from 'react'
import { queryEnvio } from '../lib/envioClient'
import type { TokenMetrics } from '../lib/aiAgent'
import { TOKENS, USDC as USDC_ADDR, WMON as WMON_ADDR } from '../lib/tokens'
import { quoteUsdcPerToken } from '../lib/quote'

// Local rolling price history (per session) to derive momentum/volatility
const PRICE_HISTORY: Map<string, Array<{ ts: number; p: number }>> = new Map()
function pushHistory(sym: string, p: number, ts: number) {
  if (!Number.isFinite(p) || p <= 0) return
  const arr = PRICE_HISTORY.get(sym) || []
  arr.push({ ts, p })
  const cutoff = ts - 3 * 3600 // keep ~3h window
  while (arr.length > 120) arr.shift()
  while (arr.length && arr[0].ts < cutoff) arr.shift()
  PRICE_HISTORY.set(sym, arr)
}
function volMomFromHistory(sym: string): { vol: number; mom: number } {
  const arr = PRICE_HISTORY.get(sym) || []
  if (arr.length < 5) return { vol: 0, mom: 0 }
  const last = arr.slice(-40)
  const prices = last.map(x => x.p).filter(x => Number.isFinite(x) && x > 0)
  if (prices.length < 5) return { vol: 0, mom: 0 }
  const avg = prices.reduce((a,b)=>a+b,0) / prices.length
  const variance = prices.reduce((s,p)=> s + Math.pow(p-avg,2), 0) / prices.length
  const vol = avg > 0 ? (Math.sqrt(variance) / avg) * 100 : 0
  const recent = prices.slice(-10)
  const older = prices.slice(-30, -10)
  const rAvg = recent.length ? recent.reduce((a,b)=>a+b,0)/recent.length : avg
  const oAvg = older.length ? older.reduce((a,b)=>a+b,0)/older.length : avg
  const mom = oAvg > 0 ? ((rAvg - oAvg) / oAvg) * 100 : 0
  return { vol, mom }
}

// --- Singleton polling store to avoid duplicate intervals across multiple consumers ---
type Subscriber = (state: { tokenMetrics: TokenMetrics[]; loading: boolean; error: string | null }) => void
let SUBS = new Set<Subscriber>()
let STATE: { tokenMetrics: TokenMetrics[]; loading: boolean; error: string | null } = { tokenMetrics: [], loading: false, error: null }
let POLL_ID: any = null
let IN_FLIGHT = false
let ABORT: AbortController | null = null
// Cooldowns to avoid hammering router fallback per token
const LAST_ROUTER_FALLBACK: Map<string, number> = new Map()
const ROUTER_FALLBACK_COOLDOWN_MS = Number(((import.meta as any).env?.VITE_ROUTER_FALLBACK_COOLDOWN_MS) ?? 300_000)
const ROUTER_SANITY_CHECK = ((import.meta as any).env?.VITE_PRICE_SANITY_ROUTER ?? 'false') === 'true'

async function pollOnce() {
  if (IN_FLIGHT) return
  IN_FLIGHT = true
  try { ABORT?.abort('unmount') } catch { ABORT?.abort() }
  ABORT = new AbortController()
  const envioEnabled = ((import.meta as any).env?.VITE_ENVIO_ENABLED ?? 'true') === 'true'
  const priceSource = String(((import.meta as any).env?.VITE_PRICE_SOURCE ?? 'AUTO')).toUpperCase()
  const forceRouter = priceSource === 'ROUTER'
  const setState = (patch: Partial<typeof STATE>) => {
    STATE = { ...STATE, ...patch }
    SUBS.forEach(fn => fn(STATE))
  }
  if (!envioEnabled) {
    setState({ loading: false, error: null, tokenMetrics: [] })
    IN_FLIGHT = false
    return
  }
  try {
    setState({ loading: true, error: null })
    const nowSec = Math.floor(Date.now() / 1000)
    const sinceSec = nowSec - 24 * 3600
    const tracked = Object.values(TOKENS)
      .filter(t => !t.isNative && t.symbol !== 'gMON')
      .map(t => (t.address as string).toLowerCase())

    const [swAndKuru, tmData] = await Promise.all([
      forceRouter ? Promise.resolve({ SwapEvent: [], Kuru_Trade: [], Kuru_MarketRegistered: [] }) :
        queryEnvio<{ SwapEvent: Array<any>; Kuru_Trade: Array<any>; Kuru_MarketRegistered: Array<any> }>({
          query: `query Recent($since:Int!) {
            SwapEvent(where:{ blockTimestamp:{ _gte:$since } }, order_by: { blockTimestamp: desc }, limit: 2000) {
              tokenIn tokenOut price amountIn amountOut blockTimestamp
            }
            Kuru_Trade(where:{ blockTimestamp:{ _gte:$since } }, order_by: { blockTimestamp: desc }, limit: 2000) {
              market price filledSize isBuy blockTimestamp
            }
            Kuru_MarketRegistered(order_by: { blockTimestamp: desc }, limit: 200) {
              id market baseAsset quoteAsset pricePrecision
            }
          }`,
          variables: { since: sinceSec }
        }, ABORT.signal),
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
      }, ABORT.signal)
    ])

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
        const pp = reg.pricePrecision != null ? BigInt(String(reg.pricePrecision)) : 1n
        const scale = pp === 0n ? 1n : pp
        const quoteAmount = (filledRaw * priceRaw) / scale
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
          } else { price = 0 }
          if (!Number.isFinite(price) || Number.isNaN(price) || price <= 0) price = 0
        } catch { price = 0 }
        derivedFromKuru.push({ tokenIn, tokenOut, price, amountIn: amountIn.toString(), amountOut: amountOut.toString(), blockTimestamp: t.blockTimestamp })
      } catch {}
    }
    const swapsCombined = forceRouter ? [] : ([...(swAndKuru.SwapEvent || []), ...derivedFromKuru] as any[]).filter(s=> Number(s.blockTimestamp||0) >= sinceSec)
    const debugPricing = ((import.meta as any).env?.VITE_DEBUG_PRICING ?? 'false') === 'true'
    const metrics = await calculateTokenMetrics(swapsCombined, tmData.TokenMetrics, debugPricing, forceRouter)
    setState({ tokenMetrics: metrics, error: null })
  } catch (e: any) {
    if (!ABORT?.signal.aborted) {
      SUBS.forEach(()=>{})
      STATE.error = e?.message || String(e)
    }
  } finally {
    if (!ABORT?.signal.aborted) STATE.loading = false
    SUBS.forEach(fn => fn(STATE))
    IN_FLIGHT = false
  }
}

function ensurePolling() {
  if (POLL_ID) return
  const pollMs = Number((import.meta as any).env?.VITE_ENVIO_POLL_MS ?? 15000)
  // Kick immediately then poll (do not reduce below prior behavior)
  pollOnce()
  POLL_ID = setInterval(pollOnce, Math.max(5000, pollMs))
}

export function useTokenMetrics() {
  const [local, setLocal] = useState(STATE)
  useEffect(() => {
    SUBS.add(setLocal)
    ensurePolling()
    return () => {
      SUBS.delete(setLocal)
      if (SUBS.size === 0 && POLL_ID) {
        clearInterval(POLL_ID)
        POLL_ID = null
        try { ABORT?.abort('unmount') } catch { ABORT?.abort() }
        ABORT = null
      }
    }
  }, [])
  return local
}

export async function calculateTokenMetrics(swaps: any[], tokenMetricsRaw: any[], debug = false, routerOnly = false): Promise<TokenMetrics[]> {
  const tokenList = Object.values(TOKENS)
    .filter(t => !t.isNative && t.symbol !== 'gMON')
    .map(t => ({ symbol: t.symbol, address: t.address.toLowerCase() }))
  const metrics: TokenMetrics[] = []
  const ZERO_ADDR_LOCAL = '0x0000000000000000000000000000000000000000'
  const tmByAddr = new Map<string, any>()
  for (const m of (tokenMetricsRaw || [])) {
    tmByAddr.set(String(m.tokenAddress).toLowerCase(), m)
  }

  // Build decimals map for quick lookup
  const DECIMALS = new Map<string, number>()
  for (const tok of Object.values(TOKENS)) {
    DECIMALS.set((tok.address as string).toLowerCase(), tok.decimals || 18)
  }
  DECIMALS.set('0x0000000000000000000000000000000000000000', 18) // native MON

  function safePriceRatio(numer: bigint, denom: bigint, scale: bigint = 10n ** 9n): number {
    if (denom === 0n) return 0
    try {
      const q = (numer * scale) / denom
      const v = Number(q) / Number(scale)
      return Number.isFinite(v) && v > 0 ? v : 0
    } catch { return 0 }
  }

  function median(values: number[]): number {
    if (!values.length) return 0
    const a = values.slice().sort((x, y) => x - y)
    const mid = Math.floor(a.length / 2)
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
  }

  // Compute USDC per WMON from recent swaps if available (amount-based, decimals-aware)
  const usdc = (USDC_ADDR as string).toLowerCase()
  const wmon = (WMON_ADDR as string).toLowerCase()
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
  const wmonUsdcSamples: number[] = []
  for (const s of swaps) {
    const tin = s.tokenIn?.toLowerCase?.()
    const tout = s.tokenOut?.toLowerCase?.()
    if (!tin || !tout) continue
  const isWmonLike = (addr: string) => addr === wmon || addr === ZERO_ADDR_LOCAL
    if (!((isWmonLike(tin) && tout === usdc) || (tin === usdc && isWmonLike(tout)))) continue
    try {
      const ain = BigInt(String(s.amountIn ?? '0'))
      const aout = BigInt(String(s.amountOut ?? '0'))
      if (ain === 0n || aout === 0n) continue
      if (isWmonLike(tin) && tout === usdc) {
        // USDC per WMON = (aout/1e6)/(ain/1e18)
        const num = aout * (10n ** 18n)
        const den = ain * (10n ** 6n)
        const p = safePriceRatio(num, den)
        if (p > 0) wmonUsdcSamples.push(p)
      } else if (tin === usdc && isWmonLike(tout)) {
        // USDC per WMON = inverse of (aout/1e18)/(ain/1e6)
        const num = ain * (10n ** 18n)
        const den = aout * (10n ** 6n)
        const p = safePriceRatio(num, den)
        if (p > 0) wmonUsdcSamples.push(p)
      }
    } catch {}
    if (wmonUsdcSamples.length >= 50) break
  }
  let usdcPerWmon = wmonUsdcSamples.length ? (wmonUsdcSamples.reduce((a,b)=>a+b,0) / wmonUsdcSamples.length) : NaN
  const usdcPerWmonOverride = Number((import.meta as any).env?.VITE_WMON_USD)
  if (Number.isFinite(usdcPerWmonOverride) && usdcPerWmonOverride > 0) {
    usdcPerWmon = usdcPerWmonOverride
  }

  const missing: string[] = []
  for (const t of tokenList) {
    const addr = t.address
    const swapsUsdc = routerOnly ? [] : swaps.filter(s => (
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
  const baseSwapsAll = routerOnly ? [] : (useUsdc ? swapsUsdc : swapsWmon).slice().sort((a: any, b: any) => Number(b.blockTimestamp || 0) - Number(a.blockTimestamp || 0))
  const MAX_SAMPLES = Number((import.meta as any).env?.VITE_MAX_PRICE_SAMPLES ?? 200)
  const baseSwaps = baseSwapsAll.slice(0, Math.max(20, Math.min(MAX_SAMPLES, baseSwapsAll.length)))

  const tm = tmByAddr.get(addr)
    const tokenMeta = TOKENS[t.symbol as keyof typeof TOKENS]
    const decimals = tokenMeta?.decimals ?? 18
    const vol24FromTM = tm ? (Number(tm.dailyVolume || 0) / Math.pow(10, decimals)) : 0
    const volScore = tm ? Number(tm.volatilityScore || 0) : 0
    const momScore = tm ? Number(tm.momentumScore || 0) : 0
    const liquidityScore = Math.min(1, (Number(tm?.transferCount || 0) + vol24FromTM) / 1000)

  // No mock prices: either compute from swaps/router or skip token
  if (routerOnly) {
      try {
        const quoted = await quoteUsdcPerToken(addr as `0x${string}`)
        if (Number.isFinite(quoted) && (quoted as number) > 0 && (quoted as number) < 1e9) {
          // Update rolling history to compute vol/mom locally when TM is empty
          pushHistory(t.symbol, quoted!, Math.floor(Date.now()/1000))
          let vol = volScore
          let mom = momScore
          if ((!Number.isFinite(vol) || vol === 0) || (!Number.isFinite(mom) || mom === 0)) {
            const v = volMomFromHistory(t.symbol)
            if (!Number.isFinite(vol) || vol === 0) vol = v.vol
            if (!Number.isFinite(mom) || mom === 0) mom = v.mom
          }
          metrics.push({
            token: t.symbol,
            price: quoted!,
            priceChange24h: 0,
            volume24h: vol24FromTM,
            volatility: vol,
            momentum: mom,
            liquidityScore,
            trend: 'sideways'
          })
          continue
        }
      } catch {}
      missing.push(t.symbol)
      continue
    }

    // Compute normalized USDC price per token using amounts and decimals,
    // filter out dust trades by notional value, and build recent sample window
  const minUsdSample = Number((import.meta as any).env?.VITE_MIN_SAMPLE_USD ?? 5)
    type Sample = { p: number; usd: number; ts: number }
    const samples: Sample[] = []
    for (const s of baseSwaps) {
      const tin = s.tokenIn?.toLowerCase?.()
      const tout = s.tokenOut?.toLowerCase?.()
      if (!tin || !tout) continue
      try {
        const ain = BigInt(String(s.amountIn ?? '0'))
        const aout = BigInt(String(s.amountOut ?? '0'))
        if (ain === 0n || aout === 0n) continue
        const ts = Number(s.blockTimestamp || 0)
        if (useUsdc) {
          if (tin === addr && tout === usdc) {
            // USDC per token = (aout/1e6)/(ain/10^dec)
            const num = aout * (BigInt(10) ** BigInt(DECIMALS.get(addr) ?? 18))
            const den = ain * (10n ** 6n)
            const p = safePriceRatio(num, den)
            const usd = Number(aout) / 1e6
            if (p > 0 && usd >= minUsdSample) samples.push({ p, usd, ts })
          }
          if (tin === usdc && tout === addr) {
            // USDC per token = (ain/1e6)/(aout/10^dec)
            const num = ain * (BigInt(10) ** BigInt(DECIMALS.get(addr) ?? 18))
            const den = aout * (10n ** 6n)
            const p = safePriceRatio(num, den)
            const usd = Number(ain) / 1e6
            if (p > 0 && usd >= minUsdSample) samples.push({ p, usd, ts })
          }
        } else {
          // Pair vs WMON/MON, convert to USDC
          if (tin === addr && isWmonLike(tout)) {
            // WMON per token = (aout/1e18)/(ain/10^dec)
            const num = aout * (BigInt(10) ** BigInt(DECIMALS.get(addr) ?? 18))
            const den = ain * (10n ** 18n)
            const wmonPerToken = safePriceRatio(num, den)
            if (Number.isFinite(usdcPerWmon) && usdcPerWmon > 0) {
              const p = wmonPerToken * (usdcPerWmon as number)
              const usd = (Number(aout) / 1e18) * (usdcPerWmon as number)
              if (p > 0 && usd >= minUsdSample) samples.push({ p, usd, ts })
            }
          }
          if (isWmonLike(tin) && tout === addr) {
            // WMON per token = (ain/1e18)/(aout/10^dec)
            const num = ain * (BigInt(10) ** BigInt(DECIMALS.get(addr) ?? 18))
            const den = aout * (10n ** 18n)
            const wmonPerToken = safePriceRatio(num, den)
            if (Number.isFinite(usdcPerWmon) && usdcPerWmon > 0) {
              const p = wmonPerToken * (usdcPerWmon as number)
              const usd = (Number(ain) / 1e18) * (usdcPerWmon as number)
              if (p > 0 && usd >= minUsdSample) samples.push({ p, usd, ts })
            }
          }
        }
      } catch {}
    }
    // Nettoyer les échantillons: supprimer NaN/0 et valeurs absurdes
    const normalizedPrices = samples
      .map(s => s.p)
      .filter(p => Number.isFinite(p) && p > 0 && p < 1e9)

    if (normalizedPrices.length === 0) {
      if (debug) console.info('[pricing]', t.symbol, 'no-samples: using fallbacks (router/BFS)')
      // Try on-chain router quote fallback (optional; RPC-only)
      try {
        const last = LAST_ROUTER_FALLBACK.get(addr) || 0
        if (Date.now() - last < ROUTER_FALLBACK_COOLDOWN_MS) throw new Error('cooldown')
        const addrChecksum = (addr as `0x${string}`)
        const quoted = await quoteUsdcPerToken(addrChecksum)
        if (Number.isFinite(quoted) && (quoted as number) > 0 && (quoted as number) < 1e9) {
          if (debug) console.info('[pricing]', t.symbol, 'fallback=router', 'price=', quoted)
          // Update rolling history and derive vol/mom if indexer TM empty
          pushHistory(t.symbol, quoted!, Math.floor(Date.now()/1000))
          let vol = volScore
          let mom = momScore
          if ((!Number.isFinite(vol) || vol === 0) || (!Number.isFinite(mom) || mom === 0)) {
            const v = volMomFromHistory(t.symbol)
            if (!Number.isFinite(vol) || vol === 0) vol = v.vol
            if (!Number.isFinite(mom) || mom === 0) mom = v.mom
          }
          metrics.push({
            token: t.symbol,
            price: quoted!,
            priceChange24h: 0,
            volume24h: vol24FromTM,
            volatility: vol,
            momentum: mom,
            liquidityScore,
            trend: 'sideways'
          })
          LAST_ROUTER_FALLBACK.set(addr, Date.now())
          continue
        }
      } catch {}
      // Fallback: multi-hop price graph (up to 3 hops) built from all swaps
      const rates: Map<string, Map<string, number>> = new Map()
      const ensure = (a: string) => { const k = a.toLowerCase(); if (!rates.has(k)) rates.set(k, new Map()); return rates.get(k)! }
      const ZERO = '0x0000000000000000000000000000000000000000'
      const isWmonLike = (x: string) => x === wmon || x === ZERO
      const addEdge = (a: string, b: string, r: number) => {
        if (!Number.isFinite(r) || r <= 0) return
        ensure(a).set(b, r)
      }
  const minUsdSample = Number((import.meta as any).env?.VITE_MIN_SAMPLE_USD ?? 5)
      for (const s of swaps) {
        const tin = s.tokenIn?.toLowerCase?.(); const tout = s.tokenOut?.toLowerCase?.();
        if (!tin || !tout) continue
        try {
          const ain = BigInt(String(s.amountIn ?? '0'))
          const aout = BigInt(String(s.amountOut ?? '0'))
          if (ain === 0n || aout === 0n) continue
          const din = BigInt(DECIMALS.get(tin) ?? (tin === ZERO ? 18 : 18))
          const dout = BigInt(DECIMALS.get(tout) ?? (tout === ZERO ? 18 : 18))
          // normalize to token units
          const inDec = 10n ** din; const outDec = 10n ** dout
          const rate = safePriceRatio((aout * inDec), (ain * outDec))
          // Filter dust only if we can estimate USD notional from USDC or WMON leg
          let ok = true
          if (tin === usdc) {
            const usd = Number(ain) / 1e6
            ok = usd >= minUsdSample
          } else if (tout === usdc) {
            const usd = Number(aout) / 1e6
            ok = usd >= minUsdSample
          } else if ((isWmonLike(tin) || isWmonLike(tout)) && Number.isFinite(usdcPerWmon) && usdcPerWmon > 0) {
            const usd = isWmonLike(tin) ? (Number(ain) / 1e18) * (usdcPerWmon as number) : (Number(aout) / 1e18) * (usdcPerWmon as number)
            ok = usd >= minUsdSample
          }
          if (!ok) continue
          addEdge(tin, tout, rate)
          addEdge(tout, tin, rate > 0 ? 1 / rate : 0)
        } catch {}
      }
  const USDC = usdc
      const start = addr
      if (start !== USDC) {
        // BFS up to 3 hops maximizing reliability using median-like by preferring more direct recent edges implicitly
        type Node = { token: string; price: number; depth: number }
        const q: Node[] = [{ token: start, price: 1, depth: 0 }]
        const seen = new Map<string, number>()
        let foundPrice: number | null = null
        while (q.length) {
          const cur = q.shift()!
          if (cur.depth > 3) continue
          if (cur.token === USDC) { foundPrice = cur.price; break }
          const nbrs = rates.get(cur.token)
          if (!nbrs) continue
          for (const [nb, r] of nbrs) {
            const nextPrice = cur.price * r
            if (!Number.isFinite(nextPrice) || nextPrice <= 0) continue
            if (seen.has(nb) && (seen.get(nb)! >= nextPrice) && cur.depth + 1 >= 2) continue
            seen.set(nb, nextPrice)
            q.push({ token: nb, price: nextPrice, depth: cur.depth + 1 })
          }
        }
      if (foundPrice && Number.isFinite(foundPrice) && foundPrice > 0) {
          if (debug) console.info('[pricing]', t.symbol, 'fallback=BFS', 'price=', foundPrice)
          metrics.push({
            token: t.symbol,
            price: foundPrice,
            priceChange24h: 0,
            volume24h: vol24FromTM,
            volatility: volScore,
            momentum: momScore,
            liquidityScore,
            trend: 'sideways',
          })
          continue
        }
      }
      // No reliable price → skip token and mark missing
      missing.push(t.symbol)
      continue
    }

  const windowNow = normalizedPrices.slice(0, 10)
  if (debug) console.info('[pricing]', t.symbol, 'samples=', normalizedPrices.length, 'latestWindow=', windowNow.length)
  const currentPrice = windowNow.length ? median(windowNow) : (normalizedPrices[0] || 1.0)
    // also track into rolling history for continuity across paths
    pushHistory(t.symbol, currentPrice, Math.floor(Date.now()/1000))
    const oldestPrice = normalizedPrices[normalizedPrices.length - 1]
    const oldPrice = oldestPrice || currentPrice
  const windowOld = normalizedPrices.slice(10, 30)
  const oldRef = windowOld.length ? median(windowOld) : oldPrice
  const priceChange24h = oldRef > 0 ? ((currentPrice - oldRef) / oldRef) * 100 : 0
    // Compute 24h volume in USDC using amounts and decimals
    let volume24hCalc = 0
    for (const s of baseSwaps) {
      const tin = s.tokenIn?.toLowerCase?.()
      const tout = s.tokenOut?.toLowerCase?.()
      if (!tin || !tout) continue
      try {
        const ain = BigInt(String(s.amountIn ?? '0'))
        const aout = BigInt(String(s.amountOut ?? '0'))
        if (ain === 0n && aout === 0n) continue
        if (useUsdc) {
          if (tin === usdc) {
            volume24hCalc += Number(ain) / 1e6
          } else if (tout === usdc) {
            volume24hCalc += Number(aout) / 1e6
          }
        } else {
          // via WMON conversion
          if (Number.isFinite(usdcPerWmon) && usdcPerWmon > 0) {
            if (isWmonLike(tin)) {
              volume24hCalc += (Number(ain) / 1e18) * usdcPerWmon
            } else if (isWmonLike(tout)) {
              volume24hCalc += (Number(aout) / 1e18) * usdcPerWmon
            }
          }
        }
      } catch {}
    }
    const volume24h = vol24FromTM > 0 ? vol24FromTM : volume24hCalc
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

    // Sanity-check via router quote: si l'écart est > 10x, on privilégie la quote on-chain
    if (ROUTER_SANITY_CHECK) {
      try {
        const quoted = await quoteUsdcPerToken(addr as `0x${string}`)
        if (Number.isFinite(quoted) && (quoted as number) > 0 && (quoted as number) < 1e9) {
        const q = quoted as number
        const ratio = currentPrice > 0 ? (q > currentPrice ? q / currentPrice : currentPrice / q) : Infinity
        if (!Number.isFinite(currentPrice) || currentPrice <= 0 || ratio > 10) {
          if (debug) console.info('[pricing]', t.symbol, 'sanity=router', 'router=', q, 'computed=', currentPrice)
          metrics.push({
            token: t.symbol,
            price: q,
            priceChange24h: 0,
            volume24h,
            volatility: volScore,
            momentum: momScore,
            liquidityScore: liq,
            trend: 'sideways'
          })
          continue
        }
        }
      } catch {}
    }

    if (debug) {
      console.info('[pricing]', t.symbol, 'samples=', normalizedPrices.length, 'price=', currentPrice, 'vol24h=', volume24h)
    }
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
  // Surface an error if some tokens have no live price
  if (missing.length && debug) console.warn('[pricing] missing live price for:', missing.join(','))
  return metrics
}
