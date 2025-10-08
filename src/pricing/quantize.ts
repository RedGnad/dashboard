// Deterministic price quantization to reduce floating drift and hash instability.
// Strategy: clamp to positive finite, then round to 6 decimals.

export function quantizePrice(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw)) return null
  if (raw <= 0) return null
  return Number(raw.toFixed(6))
}

// Simple test helper (not using vitest yet) to ensure deterministic behavior
if (process.env.RUN_QUANTIZE_SELFTEST === '1') {
  const samples = [1, 1.00000049, 0.99999951, 1.123456789, -1, Infinity, NaN]
  for (const s of samples) {
    console.log('[quantize:selftest]', s, '->', quantizePrice(s as any))
  }
}
