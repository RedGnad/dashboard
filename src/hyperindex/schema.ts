// Canonical event & feature schema definitions (phase 1 ingestion)
// This file documents and exports deterministic types + serialization helpers.
// Goal: stable hashing of feature vectors used by AI decisions.

import { keccak256 } from 'viem'

// 1. Raw chain/indexer event as ingested (already somewhat normalized)
export interface IngestedEvent {
  id: string            // unique (txHash:logIndex or indexer uuid)
  ts: number            // epoch ms
  chainId: number
  type: 'swap' | 'transfer' | 'execution' | 'price' | 'deposit' | 'withdrawal'
  // Standard token value context
  baseToken?: string
  quoteToken?: string
  amountBase?: string   // raw units string
  amountQuote?: string  // raw units string or usd notionally
  price?: number        // price base/quote or usd
  txHash?: string
  blockNumber?: number
  meta?: Record<string, any>
}

// 2. Persisted record (append-only JSONL). For now identical to IngestedEvent.
export type EventRecord = IngestedEvent

// 3. Feature windows we compute (rolling back from now)
export interface FeatureSet {
  schemaVersion: number
  asOfTs: number
  windowSpecs: { label: string; fromTs: number; toTs: number }[]
  metrics: Record<string, number | string | null>
  featureHash: string  // keccak256 over canonical serialization
}

export const CURRENT_FEATURE_SCHEMA_VERSION = 1

// Deterministic ordering: sort metric keys lexicographically, join as key=value lines.
export function serializeFeatures(fs: Omit<FeatureSet, 'featureHash'>): string {
  const lines: string[] = []
  lines.push(`schemaVersion=${fs.schemaVersion}`)
  lines.push(`asOfTs=${fs.asOfTs}`)
  for (const w of fs.windowSpecs) {
    lines.push(`window:${w.label}:${w.fromTs}:${w.toTs}`)
  }
  const metricKeys = Object.keys(fs.metrics).sort()
  for (const k of metricKeys) {
    const v = fs.metrics[k]
    lines.push(`m:${k}=${v === null || v === undefined ? 'null' : String(v)}`)
  }
  return lines.join('\n')
}

export function hashFeatureSet(fs: Omit<FeatureSet, 'featureHash'>): string {
  const ser = serializeFeatures(fs)
  const enc = new TextEncoder().encode(ser)
  let hex = '0x'
  for (const b of enc) hex += b.toString(16).padStart(2, '0')
  return keccak256(hex as `0x${string}`)
}

// Helper to build a FeatureSet from metrics + window labels
export function buildFeatureSet(params: {
  metrics: Record<string, number | string | null>
  windows: { label: string; durationMs: number }[]
  now?: number
}): FeatureSet {
  const now = params.now ?? Date.now()
  const windowSpecs = params.windows.map(w => ({ label: w.label, fromTs: now - w.durationMs, toTs: now }))
  const base: Omit<FeatureSet, 'featureHash'> = {
    schemaVersion: CURRENT_FEATURE_SCHEMA_VERSION,
    asOfTs: now,
    windowSpecs,
    metrics: params.metrics,
  }
  return { ...base, featureHash: hashFeatureSet(base) }
}
