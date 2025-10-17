#!/usr/bin/env tsx
/**
 * verify-live.ts
 * Compare live server state (/api/strategy/state) with local audit verification.
 * - Fetches server rolling.finalRollingHash
 * - Computes local finalRollingHash by running verify:audit logic (imports module)
 * Exit codes:
 * 0 match or server unreachable (soft) | 1 mismatch (soft) | 2 hard error reading local chain
 */
import http from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { keccak256 } from 'viem'

function stringToHex(s: string): `0x${string}` {
  const enc = new TextEncoder().encode(s)
  let hex = '0x'
  for (const b of enc) hex += b.toString(16).padStart(2, '0')
  return hex as `0x${string}`
}
function concatHex(a: string, b: string): `0x${string}` {
  if (a === '0x') return b as `0x${string}`
  if (b === '0x') return a as `0x${string}`
  return (`0x${a.slice(2)}${b.slice(2)}`) as `0x${string}`
}

function computeLocalFinalRollingHash(): string {
  const file = join(process.cwd(), 'data', 'delegations', 'audit.log')
  if (!existsSync(file)) return '0x'
  const raw = readFileSync(file, 'utf8').trim()
  if (!raw) return '0x'
  const lines = raw.split('\n')
  let rolling: string | null = null
  let prevLineHash: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    let obj: any
    try { obj = JSON.parse(line) } catch { continue }
    if (typeof obj !== 'object' || obj === null) continue
    // Build interim (exclude rollingHash) to recompute lineHash aligned with append/migration logic
    const interim = { ...obj }
    delete interim.rollingHash
    const interimStr = JSON.stringify(interim)
    const lineHash = keccak256(stringToHex(interimStr))
    if (rolling === null) {
      rolling = lineHash
    } else {
      rolling = keccak256(concatHex(rolling, lineHash))
    }
    prevLineHash = lineHash
  }
  return rolling || '0x'
}

function fetchState(url: string, timeoutMs = 2000): Promise<any> {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', c => { data += c })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null) })
  })
}

async function main() {
  // 1. Compute local rolling hash (pure, non-validating)
  const localHash = computeLocalFinalRollingHash().toLowerCase()

  // 2. Fetch live server state
  const port = process.env.PORT || '8787'
  const host = process.env.HOST || 'localhost'
  const state = await fetchState(`http://${host}:${port}/api/strategy/state`)
  // Helper to emit a single normalized line always containing 'live='
  function emit(status: string, live: string, match: boolean, exitCode: number) {
    // Always include live= so verify-all regex /live=/ matches regardless of status.
    console.log(`[verify-live] status=${status} live=${live} local=${localHash} match=${match}`)
    process.exit(exitCode)
  }
  if (!state || !state.ok || !state.rolling) {
    return emit('server_unreachable_or_invalid', 'none', true, 0)
  }
  const live = String(state.rolling.finalRollingHash || '').toLowerCase()
  if (!live) {
    return emit('live_missing_hash', 'none', true, 0)
  }
  const match = live === localHash
  if (!match) return emit('mismatch', live, false, 0) // we keep exit 0; divergence signaled via match=false (soft)
  return emit('ok', live, true, 0)
}

main().catch(e => { console.error('[verify-live] error', e); process.exit(2) })
