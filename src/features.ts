import fs from 'node:fs'
import path from 'node:path'
import { keccak256 } from 'viem'
import { FEATURE_SET_VERSION } from './constants'
// Replaced default provider with Surge-aware global provider
import { getSpot, getConfiguredBaseSymbol } from './pricing/globalProvider'
import { quantizePrice } from './pricing/quantize'
// NEW: Envio data adapter for enhanced on-chain metrics
import { envioAdapter } from './adapters/envio-data-adapter'

// Core deterministic feature set (MVP) separate from hyperindex metrics.
// Features (order fixed):
// 1. balanceStableRatio
// 2. balanceTargetRatio
// 3. allocationDeviation
// 4. timeSinceLastTradeMins
// 5. executionsLast24h
// 6. volatilitySimple

export interface CoreFeatures {
  balanceStableRatio: number | null
  balanceTargetRatio: number | null
  allocationDeviation: number | null
  timeSinceLastTradeMins: number | null
  executionsLast24h: number
  volatilitySimple: number | null
}

export interface FeatureResult {
  schemaVersion: number
  asOfTs: number
  features: CoreFeatures
  order: string[]
  featureHash: string
  featureHashV2?: string
  // Price context (not part of hashing order v1/v2 to preserve backward determinism)
  snapshotPrice?: number | null
  priceSource?: string
  snapshotPriceTs?: number | null // source timestamp (prefer oracle source_ts_ms; fallback reception/reference)
  // Extended (non-hash) experimental features
  momentumShortMinusLong?: number | null
  // Hint to UI: whether Envio provided the balances for this features capture
  usedEnvioBalances?: boolean
  // Hint: whether Envio provided price series used for vol/momentum
  usedEnvioPrices?: boolean
}

const FEATURE_SCHEMA_VERSION = 1
const ORDER = [
  'balanceStableRatio',
  'balanceTargetRatio',
  'allocationDeviation',
  'timeSinceLastTradeMins',
  'executionsLast24h',
  'volatilitySimple',
]

// Stable subset for featureHashV2: exclude fast-drifting fields and coarsen where needed
// - Exclude timeSinceLastTradeMins (drifts every second)
// - Keep executionsLast24h (changes rarely) and allocationDeviation (core to strategy)
// - Coarsen volatilitySimple to reduce micro-drift sensitivity
const STABLE_ORDER_V2 = [
  'balanceStableRatio',
  'balanceTargetRatio',
  'allocationDeviation',
  'executionsLast24h',
  'volatilitySimple',
]

function coarsenVolatilityForStable(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null
  // Coarsen to 4 decimals for stable hashing
  return Number(v.toFixed(4))
}

// Helpers
function toFixedOrNull(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null
  return Number(v.toFixed(8))
}

interface BalancesLike { stable?: number; target?: number; other?: number }

// Opportunistic on-chain read: return approximate USD-normalized balances
async function readBalancesUSDOnChain(delegator: string): Promise<BalancesLike> {
  try {
    const addr = (delegator || '').toLowerCase()
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return { stable: 0, target: 0, other: 0 }
    const { publicClient } = await import('./clients')
    const { USDC, WMON } = await import('./constants')
    const erc20Abi = [
      { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
    ] as const
    const [usdcRaw, wmonRaw, monRaw] = await Promise.all([
      (publicClient as any).readContract({ address: USDC as any, abi: erc20Abi as any, functionName: 'balanceOf', args: [addr] }) as Promise<bigint>,
      (publicClient as any).readContract({ address: WMON as any, abi: erc20Abi as any, functionName: 'balanceOf', args: [addr] }) as Promise<bigint>,
      (publicClient as any).getBalance({ address: addr as any }) as Promise<bigint>,
    ])
    const base = getConfiguredBaseSymbol()
    const spot = getSpot(base)
    const price = spot && typeof (spot as any).price === 'number' ? (spot as any).price : 0
    const usdc = Number(usdcRaw) / 1_000_000
    const monTotal = Number(wmonRaw) / 1e18 + Number(monRaw) / 1e18
    const targetUsd = price > 0 ? monTotal * price : 0
    return { stable: Number(usdc.toFixed(8)), target: Number(targetUsd.toFixed(8)), other: 0 }
  } catch {
    return { stable: 0, target: 0, other: 0 }
  }
}

// Load balances from snapshot file if present for determinism (future: on-chain viem integration).
// Expected JSON: { "stable": number, "target": number, "other": number }
function loadBalances(delegator: string): BalancesLike {
  try {
    const file = path.join(process.cwd(), 'data', 'balances', `${delegator.toLowerCase()}.json`)
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      return {
        stable: Number.isFinite(parsed.stable) ? Number(parsed.stable) : 0,
        target: Number.isFinite(parsed.target) ? Number(parsed.target) : 0,
        other: Number.isFinite(parsed.other) ? Number(parsed.other) : 0,
      }
    }
    // Fallback: opportunistic on-chain sampling (sync wrapper)
    try {
      const fallback = awaitMaybe(readBalancesUSDOnChain(delegator))
      if (fallback && ((fallback.stable ?? 0) > 0 || (fallback.target ?? 0) > 0)) {
        return fallback
      }
    } catch {}
  } catch {}
  return { stable: 0, target: 0, other: 0 }
}

function scanAuditForExecutionStats(referenceNow: number, cutoffTs?: number): { lastExecutionTs?: number; executions24h: number; priceSeries: { ts: number; price: number }[] } {
  const file = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
  let lastExecutionTs: number | undefined
  let executions24h = 0
  const priceSeries: { ts: number; price: number }[] = []
  const since24h = referenceNow - 24 * 60 * 60 * 1000
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim()
      if (raw) for (const line of raw.split('\n')) {
        if (!line) continue
        try {
          const j = JSON.parse(line)
          if (cutoffTs != null && j.ts > cutoffTs) break
          if (j.action === 'execute' && j.userOperationHash) {
            if (!lastExecutionTs || j.ts > lastExecutionTs) lastExecutionTs = j.ts
            if (j.ts >= since24h) executions24h++
          }
          // If later we snapshot price in ai_decision lines we can collect here; stub for now
          if (j.action === 'ai_decision' && typeof j.snapshotPrice === 'number') {
            priceSeries.push({ ts: j.ts, price: j.snapshotPrice })
          }
        } catch {}
      }
    } catch {}
  }
  return { lastExecutionTs, executions24h, priceSeries }
}

function computeSimpleVolatility(priceSeries: { ts: number; price: number }[]): number | null {
  if (priceSeries.length < 3) return null
  const prices = priceSeries.map(p => p.price).filter(p => Number.isFinite(p))
  if (prices.length < 3) return null
  const mean = prices.reduce((a,b)=>a+b,0) / prices.length
  const variance = prices.reduce((a,b)=> a + (b-mean)**2, 0) / prices.length
  const vol = Math.sqrt(variance)
  return Number(vol.toFixed(8))
}

export function computeCoreFeatures(delegator: string, opts?: { referenceNow?: number; cutoffTs?: number; priceSeriesOverride?: { ts: number; price: number }[] }): FeatureResult {
  const referenceNow = opts?.referenceNow && Number.isFinite(opts.referenceNow) ? Number(opts.referenceNow) : Date.now()
  const cutoffTs = opts?.cutoffTs && Number.isFinite(opts.cutoffTs) ? Number(opts.cutoffTs) : undefined
  console.log('[features] computeCoreFeatures invoked', { delegator, referenceNow, cutoffTs })
  const now = referenceNow
  const balances = loadBalances(delegator)
  const { lastExecutionTs, executions24h, priceSeries: auditPriceSeries } = scanAuditForExecutionStats(referenceNow, cutoffTs)
  const priceSeries = Array.isArray(opts?.priceSeriesOverride) ? opts!.priceSeriesOverride : auditPriceSeries
  const stable = balances.stable ?? 0
  const target = balances.target ?? 0
  const other = balances.other ?? 0
  const denom = Math.max(1, stable + target + other)
  const balanceStableRatio = (stable + target + other) > 0 ? toFixedOrNull(stable / denom) : null
  const balanceTargetRatio = (stable + target + other) > 0 ? toFixedOrNull(target / denom) : null
  let allocationDeviation: number | null = null
  if (balanceTargetRatio != null) {
    const targetAlloc = 0.5 // placeholder long-term allocation target
    allocationDeviation = toFixedOrNull(balanceTargetRatio - targetAlloc)
  }
  const timeSinceLastTradeMins = lastExecutionTs ? Number(((now - lastExecutionTs) / 60000).toFixed(4)) : null
  const volatilitySimple = computeSimpleVolatility(priceSeries)
  // (Experimental) price sampling for future momentum / quantized price features
  let snapshotPrice: number | null = null
  let priceSource: string | undefined
  let snapshotPriceTs: number | null = null
  try {
    const baseSymbol = getConfiguredBaseSymbol()
    const pr = getSpot(baseSymbol)
    if (pr && pr.price != null) {
      snapshotPrice = quantizePrice(pr.price)
      priceSource = pr.source
      // Prefer underlying oracle source timestamp if adapter provided it
      snapshotPriceTs = (pr as any).sourceTs && Number.isFinite((pr as any).sourceTs) ? (pr as any).sourceTs : pr.ts || now
    }
  } catch { /* non-blocking */ }

  // --- Experimental momentum feature (SMA short vs long) -----------------------------------
  // We intentionally DO NOT include momentum in hashed ORDER until FEATURE_SET_VERSION >= 3.
  // Method: use historical priceSeries from audit (ai_decision lines) only (exclude current snapshot)
  // to keep determinism stable across replays even if live snapshot differs slightly.
  // SMA short window: 5, long window: 20. Require full long window; else null.
  let momentumShortMinusLong: number | null = null
  try {
    const SERIES_FOR_MOM = priceSeries.slice() // historical only
    if (SERIES_FOR_MOM.length >= 20) {
      const last20 = SERIES_FOR_MOM.slice(-20).map(p => p.price).filter(p => Number.isFinite(p))
      const last5 = SERIES_FOR_MOM.slice(-5).map(p => p.price).filter(p => Number.isFinite(p))
      if (last20.length === 20 && last5.length === 5) {
        const smaLong = last20.reduce((a,b)=>a+b,0) / 20
        const smaShort = last5.reduce((a,b)=>a+b,0) / 5
        momentumShortMinusLong = toFixedOrNull(smaShort - smaLong)
      }
    }
  } catch { /* non-blocking */ }

  const features: CoreFeatures = {
    balanceStableRatio,
    balanceTargetRatio,
    allocationDeviation,
    timeSinceLastTradeMins,
    executionsLast24h: executions24h,
    volatilitySimple,
  }
  // Serialization strategies by FEATURE_SET_VERSION for forward compatibility
  // v1: include capture timestamp in canonical hash (legacy) -> featureHash only
  // v2: dual publication; featureHash (with ts) + featureHashV2 (without ts)
  // v3+: placeholder (will extend values set & may publish featureHashV3)

  let featureHash: string
  let featureHashV2: string | undefined

  // Always compute v1 (with timestamp) for backward compatibility when version >=1
  const partsV1: string[] = []
  partsV1.push(`v=${FEATURE_SCHEMA_VERSION}`)
  partsV1.push(`ts=${now}`)
  for (const k of ORDER) {
    const v = (features as any)[k]
    partsV1.push(`${k}=${v === null || v === undefined ? 'null' : v}`)
  }
  const serV1 = partsV1.join('\n')
  const encV1 = new TextEncoder().encode(serV1)
  let hexV1 = '0x'
  for (const b of encV1) hexV1 += b.toString(16).padStart(2, '0')
  const hashV1 = keccak256(hexV1 as `0x${string}`)

  if (FEATURE_SET_VERSION === 1) {
    featureHash = hashV1
  } else {
    // Compute stable (without timestamp) and with reduced drift sensitivity
    const partsStable: string[] = []
    partsStable.push(`v=${FEATURE_SCHEMA_VERSION}`)
    for (const k of STABLE_ORDER_V2) {
      let v = (features as any)[k]
      if (k === 'volatilitySimple') {
        v = coarsenVolatilityForStable(v)
      }
      partsStable.push(`${k}=${v === null || v === undefined ? 'null' : v}`)
    }
    const serStable = partsStable.join('\n')
    const encStable = new TextEncoder().encode(serStable)
    let hexStable = '0x'
    for (const b of encStable) hexStable += b.toString(16).padStart(2, '0')
    const hashStable = keccak256(hexStable as `0x${string}`)
    featureHash = hashV1 // retain original naming for legacy
    featureHashV2 = hashStable
  }

  // Future: if FEATURE_SET_VERSION >=3 add extended features & compute featureHashV3

  return { schemaVersion: FEATURE_SCHEMA_VERSION, asOfTs: now, features, order: ORDER.slice(), featureHash, featureHashV2, snapshotPrice, priceSource, snapshotPriceTs, momentumShortMinusLong }
}

// Async variant: ensures balances use on-chain fallback when no local snapshot exists.
export async function computeCoreFeaturesAsync(delegator: string, opts?: { referenceNow?: number; cutoffTs?: number; priceSeriesOverride?: { ts: number; price: number }[] }): Promise<FeatureResult> {
  const referenceNow = opts?.referenceNow && Number.isFinite(opts.referenceNow) ? Number(opts.referenceNow) : Date.now()
  const cutoffTs = opts?.cutoffTs && Number.isFinite(opts.cutoffTs) ? Number(opts.cutoffTs) : undefined
  console.log('[features] computeCoreFeaturesAsync invoked', { delegator, referenceNow, cutoffTs })
  const now = referenceNow
  // --- balances (async with on-chain fallback if file missing) ---
  let balances: BalancesLike = { stable: 0, target: 0, other: 0 }
  let usedEnvioBalances = false
  try {
    const file = path.join(process.cwd(), 'data', 'balances', `${delegator.toLowerCase()}.json`)
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      balances = { stable: Number(parsed.stable||0), target: Number(parsed.target||0), other: Number(parsed.other||0) }
    } else {
      // Prefer Envio if configured
  let usedEnvio = false
      try {
        if (process.env.ENVIO_GRAPHQL_URL) {
          const { fetchAccountBalancesEnvio } = await import('./metrics/envioAccount')
          const { USDC, WMON } = await import('./constants')
          const b = await fetchAccountBalancesEnvio(delegator, { usdc: USDC, wmon: WMON })
          if (b) {
            const baseSymbol = getConfiguredBaseSymbol()
            const pr = getSpot(baseSymbol)
            const price = pr && pr.price != null ? Number(pr.price) : 0
            const usdc = Number((b.usdc || 0) / 1_000_000)
            const monUsd = price > 0 ? Number((b.wmon || 0) / 1e18) * price : 0
            balances = { stable: Number(usdc.toFixed(8)), target: Number(monUsd.toFixed(8)), other: 0 }
            usedEnvio = true
          }
        }
      } catch {}
      if (!usedEnvio) {
        balances = await readBalancesUSDOnChain(delegator)
      }
      usedEnvioBalances = usedEnvio
    }
  } catch {}
  const { lastExecutionTs, executions24h, priceSeries: auditPriceSeries } = scanAuditForExecutionStats(referenceNow, cutoffTs)
  let priceSeries = Array.isArray(opts?.priceSeriesOverride) ? opts!.priceSeriesOverride : auditPriceSeries
  let usedEnvioPrices = false
  // Try Envio price series for the base asset vs USDC
  try {
    if (process.env.ENVIO_GRAPHQL_URL) {
      const { USDC, WMON } = await import('./constants')
      const { fetchPriceSeriesEnvio } = await import('./metrics/envioPrices')
      const ps = await fetchPriceSeriesEnvio({ baseToken: WMON, quoteToken: USDC, windowMinutes: 180, maxPoints: 400 })
      if (ps && ps.length >= 5) {
        priceSeries = ps
        usedEnvioPrices = true
      }
    }
  } catch {}

  // NEW: Enhanced metrics from Envio wildcards
  let envioEnhancedFeatures = {}
  try {
    const envioFeatures = await envioAdapter.generateAIFeatures()
    if (envioFeatures && envioFeatures.dataSource === 'envio') {
      envioEnhancedFeatures = {
        // Enhanced volatility from real DEX data
        volatilitySimpleEnhanced: envioFeatures.volatilitySimple || null,
        // Momentum from actual trading pairs
        momentumShortMinusLongEnhanced: envioFeatures.momentumShortMinusLong || null,
        // Volume deviation metric
        volumeDeviation: envioFeatures.volumeDeviation || null,
        // Recent price change from swaps
        priceChangePct: envioFeatures.priceChangePct || null,
        // Transfer activity level
        transferActivity: envioFeatures.transferActivity || null,
        // Meta
        envioLastUpdate: envioFeatures.lastUpdate || null,
      }
      console.log('[features] Enhanced with Envio metrics:', envioEnhancedFeatures)
      usedEnvioPrices = true // Mark as using enhanced data
    }
  } catch (error) {
    console.warn('[features] Failed to fetch Envio enhanced metrics:', error)
  }
  const stable = balances.stable ?? 0
  const target = balances.target ?? 0
  const other = balances.other ?? 0
  const denom = Math.max(1, stable + target + other)
  const balanceStableRatio = (stable + target + other) > 0 ? toFixedOrNull(stable / denom) : null
  const balanceTargetRatio = (stable + target + other) > 0 ? toFixedOrNull(target / denom) : null
  let allocationDeviation: number | null = null
  if (balanceTargetRatio != null) {
    const targetAlloc = 0.5
    allocationDeviation = toFixedOrNull(balanceTargetRatio - targetAlloc)
  }
  const timeSinceLastTradeMins = lastExecutionTs ? Number(((now - lastExecutionTs) / 60000).toFixed(4)) : null
  const volatilitySimple = computeSimpleVolatility(priceSeries)
  // price snapshot
  let snapshotPrice: number | null = null
  let priceSource: string | undefined
  let snapshotPriceTs: number | null = null
  try {
    const baseSymbol = getConfiguredBaseSymbol()
    const pr = getSpot(baseSymbol)
    if (pr && pr.price != null) {
      snapshotPrice = quantizePrice(pr.price)
      priceSource = pr.source
      snapshotPriceTs = (pr as any).sourceTs && Number.isFinite((pr as any).sourceTs) ? (pr as any).sourceTs : pr.ts || now
    }
  } catch {}
  // momentum
  let momentumShortMinusLong: number | null = null
  try {
    const SERIES_FOR_MOM = priceSeries.slice()
    if (SERIES_FOR_MOM.length >= 20) {
      const last20 = SERIES_FOR_MOM.slice(-20).map(p => p.price).filter(p => Number.isFinite(p))
      const last5 = SERIES_FOR_MOM.slice(-5).map(p => p.price).filter(p => Number.isFinite(p))
      if (last20.length === 20 && last5.length === 5) {
        const smaLong = last20.reduce((a,b)=>a+b,0) / 20
        const smaShort = last5.reduce((a,b)=>a+b,0) / 5
        momentumShortMinusLong = toFixedOrNull(smaShort - smaLong)
      }
    }
  } catch {}
  const features: CoreFeatures = {
    balanceStableRatio,
    balanceTargetRatio,
    allocationDeviation,
    timeSinceLastTradeMins,
    executionsLast24h: executions24h,
    volatilitySimple,
  }
  // hashing v1/v2
  const partsV1: string[] = []
  partsV1.push(`v=${FEATURE_SCHEMA_VERSION}`)
  partsV1.push(`ts=${now}`)
  for (const k of ORDER) {
    const v = (features as any)[k]
    partsV1.push(`${k}=${v === null || v === undefined ? 'null' : v}`)
  }
  const serV1 = partsV1.join('\n')
  const encV1 = new TextEncoder().encode(serV1)
  let hexV1 = '0x'
  for (const b of encV1) hexV1 += b.toString(16).padStart(2, '0')
  const hashV1 = keccak256(hexV1 as `0x${string}`)
  let featureHash: string
  let featureHashV2: string | undefined
  if (FEATURE_SET_VERSION === 1) {
    featureHash = hashV1
  } else {
    const partsStable: string[] = []
    partsStable.push(`v=${FEATURE_SCHEMA_VERSION}`)
    for (const k of STABLE_ORDER_V2) {
      let v = (features as any)[k]
      if (k === 'volatilitySimple') v = coarsenVolatilityForStable(v)
      partsStable.push(`${k}=${v === null || v === undefined ? 'null' : v}`)
    }
    const serStable = partsStable.join('\n')
    const encStable = new TextEncoder().encode(serStable)
    let hexStable = '0x'
    for (const b of encStable) hexStable += b.toString(16).padStart(2, '0')
    const hashStable = keccak256(hexStable as `0x${string}`)
    featureHash = hashV1
    featureHashV2 = hashStable
  }
  return { schemaVersion: FEATURE_SCHEMA_VERSION, asOfTs: now, features, order: ORDER.slice(), featureHash, featureHashV2, snapshotPrice, priceSource, snapshotPriceTs, momentumShortMinusLong, usedEnvioBalances, usedEnvioPrices }
}
// Minimal promise unwrap helper (avoid top-level async refactor for now)
function awaitMaybe<T>(p: Promise<T>): T | undefined {
  let val: T | undefined
  let err: any
  let done = false
  p.then(v => { val = v; done = true }).catch(e => { err = e; done = true })
  // Busy wait VERY briefly (not ideal, but computeCoreFeatures currently sync; future refactor to async)
  const start = Date.now()
  while (!done && (Date.now() - start) < 5) { /* spin up to 5ms */ }
  if (err) return undefined
  return val
}

// Record a deterministic snapshot price (for future volatility). This is optional and idempotent.
// Price chosen upstream (e.g. oracle); here we just append to audit via ai_decision lines, so this helper is minimal.
export function computeSyntheticPrice(ts: number): number {
  // Deterministic oscillation around 1.0 (+/- 0.04) with 10-minute period segments.
  const minute = Math.floor(ts / 60000)
  const phase = (minute % 10) - 5 // -5..4
  const price = 1 + (phase / 250) // range approx 0.98 - 1.04
  return Number(price.toFixed(6))
}
