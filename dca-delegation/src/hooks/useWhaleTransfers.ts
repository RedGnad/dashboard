import { useEffect, useMemo, useState } from 'react'
import { queryEnvio } from '../lib/envioClient'
import { TOKENS, USDC as USDC_ADDR, WMON as WMON_ADDR } from '../lib/tokens'
import { quoteUsdcPerToken } from '../lib/quote'

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

// thresholds can be extended if needed; currently derived from env

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

// NOTE: thresholds reduced to WMON only in MON-only mode

export function useWhaleTransfers(days: number = 7) {
  const [moves, setMoves] = useState<WhaleMove[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const envioEnabled = ((import.meta.env.VITE_ENVIO_ENABLED ?? 'true') === 'true')
  const whaleEnabled = (import.meta.env.VITE_WHALE_NOTIFICATIONS !== 'false')
  const whaleMonOnly = ((import.meta.env.VITE_WHALE_MON_ONLY ?? 'false') === 'true')
  // Seuil en USDC: priorité au localStorage contrôlé via UI; défaut 10k
  const [usdcThreshold, setUsdcThreshold] = useState<number>(() => {
    try {
      const v = localStorage.getItem('whaleThresholdUsd')
      return v ? Number(v) : 10000
    } catch { return 10000 }
  })
  // Réagir aux changements du seuil émis par l'UI
  useEffect(() => {
    const handler = (e: any) => {
      const v = Number(e?.detail)
      if (Number.isFinite(v) && v > 0) setUsdcThreshold(v)
    }
    if (typeof window !== 'undefined') window.addEventListener('whale:threshold', handler as any)
    return () => { if (typeof window !== 'undefined') window.removeEventListener('whale:threshold', handler as any) }
  }, [])
  // Eviter le clignotement de "loading" après la première réussite
  const [initialized, setInitialized] = useState(false)

  // token metrics unused in current UI; keep hook minimal

  const since = useMemo(() => {
    const nowSec = Math.floor(Date.now() / 1000)
    return nowSec - days * 86400
  }, [days])

  useEffect(() => {
    if (!envioEnabled || !whaleEnabled) { setMoves([]); setLoading(false); setError(null); return }
    let abort = new AbortController()
    async function run() {
      setLoading(!initialized)
      setError(null)
      try {
        let tokenAddrs = Object.values(TOKENS)
          .filter(t => !t.isNative)
          .map(t => (t.address as string).toLowerCase())
        if (whaleMonOnly) {
          const w = Object.values(TOKENS).find(t => t.symbol === 'WMON')
          tokenAddrs = w ? [String(w.address).toLowerCase()] : []
        }
        // 1) Récupérer les transferts récents
        const res = await queryEnvio<{ TokenTransfer: Array<any> }>({
          query: `query Whale($since:Int!, $tokens:[String!]) { 
            TokenTransfer(where:{ blockTimestamp: { _gte: $since }, tokenAddress: { _in: $tokens } }, order_by:{ blockTimestamp: desc }, limit: 2000) {
              id tokenAddress from to value blockTimestamp transactionHash
            }
          }`,
          variables: { since, tokens: tokenAddrs }
        }, abort.signal)
        const rows = res.TokenTransfer || []
        // 2) Récupérer des swaps récents pour estimer les prix USDC
        const sincePrice = since
        const swapsRes = await queryEnvio<{ SwapEvent: Array<any> }>({
          query: `query Sw($since:Int!){
            SwapEvent(
              where:{ blockTimestamp:{ _gte:$since } }
              order_by:{ blockTimestamp: desc }
              limit: 3000
            ){
              tokenIn tokenOut amountIn amountOut blockTimestamp
            }
          }`,
          variables: { since: sincePrice }
        }, abort.signal)
  const swaps = (swapsRes.SwapEvent || []).slice().sort((a:any,b:any)=>Number(b.blockTimestamp||0)-Number(a.blockTimestamp||0))

        // Helpers de décimales et adresses normalisées
        const DEC = new Map<string, number>()
        for (const t of Object.values(TOKENS)) DEC.set((t.address as string).toLowerCase(), t.decimals)
        DEC.set('0x0000000000000000000000000000000000000000', 18)
        const USDC = (USDC_ADDR as string).toLowerCase()
        const WMON = (WMON_ADDR as string).toLowerCase()

        // Estime USDC/WMON
        const wmonUsdc: number[] = []
        const minUsdSample = Number((import.meta as any).env?.VITE_MIN_SAMPLE_USD ?? 50)
        const ZERO = '0x0000000000000000000000000000000000000000'
        for (const s of swaps) {
          const tin = String(s.tokenIn).toLowerCase(); const tout = String(s.tokenOut).toLowerCase()
          const ain = Number(s.amountIn); const aout = Number(s.amountOut)
          if (!Number.isFinite(ain) || !Number.isFinite(aout) || ain <= 0 || aout <= 0) continue
          const tinW = (tin === WMON || tin === ZERO)
          const toutW = (tout === WMON || tout === ZERO)
          if ((tinW && tout === USDC) || (tin === USDC && toutW)) {
            const din = DEC.get(tin) ?? 18; const dout = DEC.get(tout) ?? 18
            const px = (aout / Math.pow(10, dout)) / (ain / Math.pow(10, din))
            const usd = tin === USDC ? (ain / Math.pow(10, din)) : (aout / Math.pow(10, dout))
            if (px > 0 && Number.isFinite(px) && usd >= minUsdSample) wmonUsdc.push(tinW ? px : 1 / px)
          }
          if (wmonUsdc.length >= 100) break
        }
        let usdcPerWmon = wmonUsdc.length ? wmonUsdc.sort((a,b)=>a-b)[Math.floor(wmonUsdc.length/2)] : NaN
        const usdcPerWmonOverride = Number((import.meta as any).env?.VITE_WMON_USD)
        if (Number.isFinite(usdcPerWmonOverride) && usdcPerWmonOverride > 0) {
          usdcPerWmon = usdcPerWmonOverride
        }

        // Prix USDC par token (direct USDC si dispo, sinon via WMON)
  const priceUSDC = new Map<string, number>()
        priceUSDC.set(USDC, 1)
        if (Number.isFinite(usdcPerWmon) && usdcPerWmon > 0) priceUSDC.set(WMON, usdcPerWmon)

        // Construire estimateurs simples par token
        for (const s of swaps) {
          const tin = String(s.tokenIn).toLowerCase(); const tout = String(s.tokenOut).toLowerCase()
          const ain = Number(s.amountIn); const aout = Number(s.amountOut)
          const din = DEC.get(tin) ?? 18; const dout = DEC.get(tout) ?? 18
          if (!Number.isFinite(ain) || !Number.isFinite(aout) || ain <= 0 || aout <= 0) continue
          // direct USDC pair
          if (tin !== tout && (tin === USDC || tout === USDC)) {
            const px = (aout / Math.pow(10, dout)) / (ain / Math.pow(10, din))
            const usd = tin === USDC ? (ain / Math.pow(10, din)) : (aout / Math.pow(10, dout))
            if (usd >= minUsdSample) {
              if (tin === USDC) { // tokenOut per USDC => invert for tokenOut price
                const tok = tout; const p = px > 0 ? 1/px : NaN
                if (Number.isFinite(p) && p > 0) priceUSDC.set(tok, p)
              } else { // USDC per tokenIn
                const tok = tin; const p = px
                if (Number.isFinite(p) && p > 0) priceUSDC.set(tok, p)
              }
            }
          }
          // via WMON or native
          if ((tin === WMON || tout === WMON || tin === ZERO || tout === ZERO) && Number.isFinite(usdcPerWmon) && usdcPerWmon > 0) {
            const px = (aout / Math.pow(10, dout)) / (ain / Math.pow(10, din))
            const usd = (tin === WMON || tin === ZERO) ? (ain / Math.pow(10, din)) * (usdcPerWmon as number) : (aout / Math.pow(10, dout)) * (usdcPerWmon as number)
            if (usd >= minUsdSample) {
              if (tin === WMON || tin === ZERO) {
                const tok = tout; const wmonPerTok = px; const p = wmonPerTok * (usdcPerWmon as number)
                if (Number.isFinite(p) && p > 0) priceUSDC.set(tok, p)
              } else if (tout === WMON || tout === ZERO) {
                const tok = tin; const tokPerWmon = px; const p = (1 / tokPerWmon) * (usdcPerWmon as number)
                if (Number.isFinite(p) && p > 0) priceUSDC.set(tok, p)
              }
            }
          }
        }

        // Fallback: compléter les prix manquants via quotes routeur (USDC -> token)
        const needQuote = new Set<string>()
        for (const r of rows) {
          const addr = String(r.tokenAddress).toLowerCase()
          const sym = symbolFromAddress(addr)
          if (!sym) continue
          if (whaleMonOnly && sym !== 'WMON') continue
          if (addr === USDC) continue
          if (!priceUSDC.has(addr)) needQuote.add(addr)
        }
        if (needQuote.size > 0) {
          try {
            const tasks = Array.from(needQuote).map(async (a) => {
              try {
                const p = await quoteUsdcPerToken(a as `0x${string}`)
                if (Number.isFinite(p) && (p as number) > 0) priceUSDC.set(a, p as number)
              } catch {}
            })
            await Promise.all(tasks)
          } catch {}
        }

        // 3) Filtrer les whales par équivalent USDC
        const out: WhaleMove[] = []
        for (const r of rows) {
          const addr = String(r.tokenAddress).toLowerCase()
          const sym = symbolFromAddress(addr)
          if (!sym) continue
          try {
            const dec = decimalsForSymbol(sym)
            const val = BigInt(r.value)
            const amount = Number(val) / Math.pow(10, dec)
            if (!Number.isFinite(amount)) continue
            if (whaleMonOnly && sym !== 'WMON') continue
            const pUSDC = priceUSDC.get(addr)
            const usdcEq = pUSDC && pUSDC > 0 ? amount * pUSDC : (sym === 'USDC' ? amount : NaN)
            if (Number.isFinite(usdcEq) && usdcEq >= usdcThreshold) {
              out.push({
                id: r.id,
                token: sym,
                tokenAddress: r.tokenAddress,
                from: r.from,
                to: r.to,
                valueRaw: r.value,
                value: amount,
                blockTimestamp: Number(r.blockTimestamp),
                transactionHash: r.transactionHash,
              })
            }
          } catch {}
        }
  // Sort newest first for consistent UI
  out.sort((a, b) => b.blockTimestamp - a.blockTimestamp)
  setMoves(out)
  if (!initialized) setInitialized(true)
      } catch (e: any) {
        if (!abort.signal.aborted) setError(e.message || String(e))
      } finally {
        if (!abort.signal.aborted) setLoading(false)
      }
    }
    run()
    const id = setInterval(run, 60000)
    return () => { try { abort.abort('unmount') } catch { abort.abort() }; clearInterval(id) }
  }, [envioEnabled, whaleEnabled, whaleMonOnly, usdcThreshold, since, initialized])

  return { moves, loading, error }
}
