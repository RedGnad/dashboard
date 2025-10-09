// Numeric normalization helpers to ensure stable feature serialization & hashing.
// Centralizes rounding precision so tests and future hashing remain consistent.

export interface NormalizeOptions {
  decimals?: number // number of fractional decimals to keep (default 8)
  nullIfNaN?: boolean // return null instead of NaN (default true)
}

export function normalizeNumber(v: any, opts: NormalizeOptions = {}): number | null {
  const { decimals = 8, nullIfNaN = true } = opts
  if (v === null || v === undefined) return null
  const num = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(num)) return nullIfNaN ? null : num
  // Avoid negative zero artifact
  const fixed = Number(num.toFixed(decimals))
  return Object.is(fixed, -0) ? 0 : fixed
}

// Apply normalizeNumber to every numeric value of an object (non-recursive at this stage)
export function normalizeMetrics<T extends Record<string, any>>(metrics: T, decimals = 8): T {
  const out: Record<string, any> = {}
  for (const [k,v] of Object.entries(metrics)) {
    if (typeof v === 'number') out[k] = normalizeNumber(v, { decimals })
    else out[k] = v
  }
  return out as T
}
