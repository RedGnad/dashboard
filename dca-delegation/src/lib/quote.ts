import { createPublicClient, http, getContract, parseAbi, type Address } from 'viem'

const RPC = (import.meta as any).env?.VITE_RPC_URL as string
const CHAIN_ID = 10143 // Monad testnet

// UniswapV2 Router minimal ABI
const V2_ROUTER_ABI = parseAbi([
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)'
])

// Candidate routers provided in tokens registry
import { ROUTER_V2_CANDIDATES, USDC as USDC_ADDR, WMON as WMON_ADDR, TOKENS, PREFERRED_PAIRS, PAIR_WMON_USDC } from './tokens'

const client = createPublicClient({ chain: { id: CHAIN_ID, name: 'monad-testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } }, transport: http(RPC) })

type QuoteKey = `${string}->${string}`
const cache = new Map<QuoteKey, { t: number; p: number }>()
const TTL_MS = Number(((import.meta as any).env?.VITE_QUOTE_TTL_MS) ?? 10_000)
const DEBUG = ((import.meta as any).env?.VITE_DEBUG_PRICING ?? 'false') === 'true'
const MIN_PAIR_USD = Number(((import.meta as any).env?.VITE_MIN_PAIR_USD) ?? 500)
type AggMode = 'RESERVES' | 'ROUTER' | 'MEDIAN'
const QUOTE_AGG: AggMode = (String((import.meta as any).env?.VITE_QUOTE_AGGREGATION ?? 'RESERVES').toUpperCase() as AggMode)

function now() { return Date.now() }

async function tryPath(router: Address, amountIn: bigint, path: Address[]): Promise<readonly bigint[] | null> {
  try {
    const contract = getContract({ address: router, abi: V2_ROUTER_ABI, client })
    const out: readonly bigint[] = await contract.read.getAmountsOut([amountIn, path])
    if (!out || out.length < 2) return null
    return out
  } catch { return null }
}

function pow10(n: number): bigint { return 10n ** BigInt(n) }
function ratioToNumber(numer: bigint, denom: bigint, scale: bigint = 10n ** 12n): number {
  if (denom === 0n) return 0
  try {
    const q = (numer * scale) / denom
    const v = Number(q) / Number(scale)
    return Number.isFinite(v) && v > 0 ? v : 0
  } catch { return 0 }
}

export async function quoteUsdcPerToken(token: Address): Promise<number | null> {
  // Do not quote gMON (stake token) — not tradeable; avoid unnecessary RPC
  try {
    const gmonAddr = (TOKENS.gMON?.address as string | undefined)?.toLowerCase()
    if (gmonAddr && String(token).toLowerCase() === gmonAddr) return null
  } catch {}
  const USDC = USDC_ADDR as Address
  const WMON = WMON_ADDR as Address
  // Décimales tokens
  const DEC = new Map<string, number>()
  for (const t of Object.values(TOKENS)) DEC.set((t.address as string).toLowerCase(), t.decimals)
  const key: QuoteKey = `${USDC}->${token}`
  const c = cache.get(key)
  if (c && (now() - c.t) < TTL_MS) return c.p
  const candidates: Array<{ src: string; price: number }> = []
  const reservesCandidates: Array<{ src: string; price: number }>=[]
  const routerCandidates: Array<{ src: string; price: number }>=[]

  // 0) Try preferred pair via reserves (most robust)
  try {
    const pref = PREFERRED_PAIRS[String(token).toLowerCase()]
    if (pref) {
      // helper to read reserves
      const PAIR_ABI = parseAbi([
        'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
        'function token0() view returns (address)',
        'function token1() view returns (address)'
      ])
      const readReserves = async (pair: Address) => {
        const pairC = getContract({ address: pair, abi: PAIR_ABI, client })
        const [r0, r1] = await pairC.read.getReserves()
        const t0 = await pairC.read.token0()
        const t1 = await pairC.read.token1()
        return { r0: BigInt(r0 as any), r1: BigInt(r1 as any), t0: String(t0).toLowerCase(), t1: String(t1).toLowerCase() }
      }
      // USDC pair direct (price = (rUSDC / 1e6) / (rTOK / 10^decTok))
      if (pref.usdcPair) {
        const { r0, r1, t0, t1 } = await readReserves(pref.usdcPair as Address)
        const tok = String(token).toLowerCase()
        const decTok = DEC.get(tok) ?? 18
        let usdcPerToken: number | null = null
        if (t0 === tok && t1 === (USDC as string).toLowerCase()) {
          usdcPerToken = ratioToNumber(r1 * pow10(decTok), r0 * 10n ** 6n)
          const usdcReserve = Number(r1) / 1e6
          if (usdcReserve < MIN_PAIR_USD) usdcPerToken = null
        } else if (t1 === tok && t0 === (USDC as string).toLowerCase()) {
          usdcPerToken = ratioToNumber(r0 * pow10(decTok), r1 * 10n ** 6n)
          const usdcReserve = Number(r0) / 1e6
          if (usdcReserve < MIN_PAIR_USD) usdcPerToken = null
        }
        if (usdcPerToken && Number.isFinite(usdcPerToken) && usdcPerToken > 0 && usdcPerToken < 1e9) {
          const cand = { src: `reserves:usdcPair:${pref.usdcPair}`, price: usdcPerToken }
          candidates.push(cand); reservesCandidates.push(cand)
          if (DEBUG) console.info('[quote] reserves USDC pair', { token, pair: pref.usdcPair, price: usdcPerToken })
        }
      }
      // WMON pair + WMON/USDC from preferred pair (usdcPerToken = wmonPerToken * usdcPerWmon)
      if (pref.wmonPair) {
        const { r0, r1, t0, t1 } = await readReserves(pref.wmonPair as Address)
        const tok = String(token).toLowerCase()
        const decTok = DEC.get(tok) ?? 18
        let wmonPerToken: number | null = null
        if (t0 === tok && t1 === (WMON as string).toLowerCase()) {
          wmonPerToken = ratioToNumber(r1 * pow10(decTok), r0 * 10n ** 18n)
        } else if (t1 === tok && t0 === (WMON as string).toLowerCase()) {
          wmonPerToken = ratioToNumber(r0 * pow10(decTok), r1 * 10n ** 18n)
        }
        // WMON/USDC via preferred WMON/USDC pair reserves
        const pairWU = getContract({ address: PAIR_WMON_USDC as Address, abi: PAIR_ABI, client })
        const [wr0, wr1] = await pairWU.read.getReserves()
        const wu0 = (await pairWU.read.token0()) as any as string
        const wu1 = (await pairWU.read.token1()) as any as string
        let usdcPerWmon: number | null = null
        const waddr = (WMON as string).toLowerCase(); const uaddr = (USDC as string).toLowerCase()
        if (wu0.toLowerCase() === waddr && wu1.toLowerCase() === uaddr) {
          usdcPerWmon = ratioToNumber((wr1 as any as bigint) * 10n ** 18n, (wr0 as any as bigint) * 10n ** 6n)
        } else if (wu1.toLowerCase() === waddr && wu0.toLowerCase() === uaddr) {
          usdcPerWmon = ratioToNumber((wr0 as any as bigint) * 10n ** 18n, (wr1 as any as bigint) * 10n ** 6n)
        }
        if (wmonPerToken && usdcPerWmon && wmonPerToken > 0 && usdcPerWmon > 0) {
          // Also require sufficient USD liquidity on the WMON side
          let usdReserve = 0
          try {
            const wIsT1 = t1 === (WMON as string).toLowerCase()
            const wReserve = wIsT1 ? r1 : r0
            usdReserve = (Number(wReserve) / 1e18) * (usdcPerWmon as number)
          } catch { usdReserve = 0 }
          let usdcPerToken = wmonPerToken * usdcPerWmon
          if (usdReserve < MIN_PAIR_USD) usdcPerToken = NaN
          if (Number.isFinite(usdcPerToken) && usdcPerToken > 0 && usdcPerToken < 1e9) {
            const cand = { src: `reserves:wmonPair:${pref.wmonPair}`, price: usdcPerToken }
            candidates.push(cand); reservesCandidates.push(cand)
            if (DEBUG) console.info('[quote] reserves WMON pair', { token, pair: pref.wmonPair, price: usdcPerToken, wmonPerToken, usdcPerWmon })
          }
        }
      }
    }
  } catch {}

  // On utilise 100 USDC en entrée pour un notional robuste
  const usdcIn = BigInt(100n * 10n ** 6n)
  // Helper: BigInt-safe conversion from getAmountsOut (USDC -> TOKEN)
  const usdcPerTokenFromAmounts = (ain: bigint, aout: bigint, decTok: number): number => {
    // usdcPerToken = (ain/1e6) / (aout/10^decTok) = (ain * 10^decTok) / (aout * 1e6)
    return ratioToNumber(ain * pow10(decTok), aout * 10n ** 6n)
  }

  // Try direct USDC -> TOKEN (gives token per USDC; invert to get USDC per token)
  for (const r of ROUTER_V2_CANDIDATES) {
    const amounts = await tryPath(r as Address, usdcIn, [USDC, token])
    if (amounts && amounts.length >= 2) {
      const ain = amounts[0] // bigint USDC raw
      const aout = amounts[1] // bigint TOKEN raw
      const decTok = DEC.get(String(token).toLowerCase()) ?? 18
      const usdcPerToken = usdcPerTokenFromAmounts(ain as bigint, aout as bigint, decTok)
      // garde-fous simples: rejeter valeurs absurdes et lisser les outliers
      if (!Number.isFinite(usdcPerToken) || usdcPerToken <= 0) continue
      if (usdcPerToken > 1e9) continue // > 1 milliard USDC par token improbable
      if (usdcPerToken < 1e-9) continue // < 1e-9 USDC par token, outlier
  const cand = { src: `router:direct:${r}`, price: usdcPerToken }
  candidates.push(cand); routerCandidates.push(cand)
      if (DEBUG) console.info('[quote] router direct', { token, router: r, price: usdcPerToken })
    }
  }
  // Try USDC -> WMON -> TOKEN (invert appropriately)
  for (const r of ROUTER_V2_CANDIDATES) {
    const amounts = await tryPath(r as Address, usdcIn, [USDC, WMON, token])
    if (amounts && amounts.length >= 3) {
      const ain = amounts[0] as bigint // USDC raw
      const aout = amounts[2] as bigint // TOKEN raw
      const decTok = DEC.get(String(token).toLowerCase()) ?? 18
      const usdcPerToken = usdcPerTokenFromAmounts(ain, aout, decTok)
      if (!Number.isFinite(usdcPerToken) || usdcPerToken <= 0) continue
      if (usdcPerToken > 1e9) continue
      if (usdcPerToken < 1e-9) continue
  const cand = { src: `router:wmon:${r}`, price: usdcPerToken }
  candidates.push(cand); routerCandidates.push(cand)
      if (DEBUG) console.info('[quote] router via WMON', { token, router: r, price: usdcPerToken })
    }
  }
  // Choose per aggregation mode to avoid flip-flopping
  const choose = (arr: Array<{src:string;price:number}>) => {
    if (!arr.length) return null
    // Prefer the first added by our priority order (reserves USDC, reserves WMON, router direct, router via WMON)
    return arr[0].price
  }
  let chosen: number | null = null
  if (QUOTE_AGG === 'RESERVES') {
    chosen = choose(reservesCandidates) ?? choose(routerCandidates)
  } else if (QUOTE_AGG === 'ROUTER') {
    chosen = choose(routerCandidates) ?? choose(reservesCandidates)
  } else if (candidates.length) {
    const sorted = [...candidates].sort((a,b)=>a.price-b.price)
    const mid = Math.floor(sorted.length/2)
    chosen = sorted.length % 2 === 1 ? sorted[mid].price : (sorted[mid-1].price + sorted[mid].price)/2
    if (DEBUG) console.info('[quote] chosen median', { token, candidates, chosen })
  }
  if (Number.isFinite(chosen as number) && (chosen as number) > 0) {
    cache.set(key, { t: now(), p: chosen as number })
    return chosen as number
  }
  return null
}
