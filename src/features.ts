import fs from 'node:fs'
import path from 'node:path'
import { keccak256 } from 'viem'

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

function loadBalances(_delegator: string): BalancesLike {
  // Placeholder: integrate on-chain reads or cached snapshot later.
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
  const features: CoreFeatures = {
    balanceStableRatio,
    balanceTargetRatio,
    allocationDeviation,
    timeSinceLastTradeMins,
    executionsLast24h: executions24h,
    volatilitySimple,
  }
  // Canonical serialization v1: version|asOfTs|k=v (order fixed)
  const parts: string[] = []
  parts.push(`v=${FEATURE_SCHEMA_VERSION}`)
  parts.push(`ts=${now}`)
  for (const k of ORDER) {
    const v = (features as any)[k]
    parts.push(`${k}=${v === null || v === undefined ? 'null' : v}`)
  }
  const ser = parts.join('\n')
  const enc = new TextEncoder().encode(ser)
  let hex = '0x'
  for (const b of enc) hex += b.toString(16).padStart(2, '0')
  const featureHash = keccak256(hex as `0x${string}`)
  // v2: exclude volatile asOfTs to make hash insensitive to capture timestamp; only values
  const partsV2: string[] = []
  partsV2.push(`v=${FEATURE_SCHEMA_VERSION}`)
  for (const k of ORDER) {
    const v = (features as any)[k]
    partsV2.push(`${k}=${v === null || v === undefined ? 'null' : v}`)
  }
  const serV2 = partsV2.join('\n')
  const enc2 = new TextEncoder().encode(serV2)
  let hex2 = '0x'
  for (const b of enc2) hex2 += b.toString(16).padStart(2, '0')
  const featureHashV2 = keccak256(hex2 as `0x${string}`)
  return { schemaVersion: FEATURE_SCHEMA_VERSION, asOfTs: now, features, order: ORDER.slice(), featureHash, featureHashV2 }
}
