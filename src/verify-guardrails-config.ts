#!/usr/bin/env tsx
import { loadGuardrails, getGuardrailsConfigHash } from './guardrails'
import { createHash } from 'node:crypto'

// Recompute hash using same logic as loader (sorted keys) and compare with cached hash.

function stableHash(obj: any): string {
  const sorted = Object.keys(obj).sort().reduce((acc,k)=>{(acc as any)[k]=obj[k];return acc},{} as any)
  return '0x'+createHash('sha256').update(JSON.stringify(sorted)).digest('hex')
}

const cfg = loadGuardrails(true)
const runtimeHash = getGuardrailsConfigHash()
const recomputed = stableHash(cfg)
const ok = runtimeHash === recomputed
console.log('[verify-guardrails-config]', { ok, runtimeHash, recomputed })
process.exit(ok ? 0 : 1)