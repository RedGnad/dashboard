import fs from 'node:fs'
import path from 'node:path'
import { keccak256 } from 'viem'
import { FEATURE_SET_VERSION } from './constants'
import { buildDefaultPriceProvider } from './pricing/provider'
import { quantizePrice } from './pricing/quantize'

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

// Helpers
function toFixedOrNull(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null
  return Number(v.toFixed(8))
}

interface BalancesLike { stable?: number; target?: number; other?: number }

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

export function computeCoreFeatures(delegator: string, opts?: { referenceNow?: number; cutoffTs?: number }): FeatureResult {
  const referenceNow = opts?.referenceNow && Number.isFinite(opts.referenceNow) ? Number(opts.referenceNow) : Date.now()
  const cutoffTs = opts?.cutoffTs && Number.isFinite(opts.cutoffTs) ? Number(opts.cutoffTs) : undefined
  console.log('[features] computeCoreFeatures invoked', { delegator, referenceNow, cutoffTs })
  const now = referenceNow
  const balances = loadBalances(delegator)
  const { lastExecutionTs, executions24h, priceSeries } = scanAuditForExecutionStats(referenceNow, cutoffTs)
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
  try {
    const priceProvider = buildDefaultPriceProvider()
    const pr = awaitMaybe(priceProvider.getSpot({ symbol: 'WMON', ts: now }))
    if (pr && pr.price != null) snapshotPrice = quantizePrice(pr.price)
  } catch {}

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
    // Compute stable (without timestamp)
    const partsStable: string[] = []
    partsStable.push(`v=${FEATURE_SCHEMA_VERSION}`)
    for (const k of ORDER) {
      const v = (features as any)[k]
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

  return { schemaVersion: FEATURE_SCHEMA_VERSION, asOfTs: now, features, order: ORDER.slice(), featureHash, featureHashV2 }
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
