import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type DcaRunEvent = {
  ts: number
  delegator: string
  amountInUSDC?: string
  amountOutToken?: string
  unwrap?: boolean
  userOperationHash?: string
  strategy?: string
  skipped?: boolean
  skipReason?: string
  gas?: { maxFeePerGas?: string; maxPriorityFeePerGas?: string }
  structHashes?: string[] // une ou plusieurs délégations consommées
}

const HISTORY_DIR = join(process.cwd(), 'data', 'history')

function fileFor(delegator: string) {
  const addr = delegator.toLowerCase()
  return join(HISTORY_DIR, `${addr}.json`)
}

export function appendRunEvent(e: DcaRunEvent) {
  try {
    mkdirSync(HISTORY_DIR, { recursive: true })
    const f = fileFor(e.delegator)
    let arr: DcaRunEvent[] = []
    if (existsSync(f)) {
      try { arr = JSON.parse(readFileSync(f, 'utf8')) } catch { arr = [] }
    }
    arr.push(e)
    // hard cap to last 500 events per delegator to limit file growth
    if (arr.length > 500) arr = arr.slice(-500)
    writeFileSync(f, JSON.stringify(arr, null, 2))
  } catch (err) {
    // silent fail to avoid breaking core flow
    console.warn('[history] append failed', (err as any)?.message)
  }
}

export function readRunHistory(delegator: string, limit = 100): DcaRunEvent[] {
  try {
    const f = fileFor(delegator)
    if (!existsSync(f)) return []
    const arr = JSON.parse(readFileSync(f, 'utf8')) as DcaRunEvent[]
    return arr.slice(-limit)
  } catch { return [] }
}

export function summarizeRunHistory(delegator: string) {
  const events = readRunHistory(delegator, 500)
  let totalIn = 0n
  let totalOut = 0n
  for (const e of events) {
    if (e.amountInUSDC) {
      try { totalIn += BigInt(e.amountInUSDC) } catch {}
    }
    if (e.amountOutToken) {
      try { totalOut += BigInt(e.amountOutToken) } catch {}
    }
  }
  return {
    count: events.length,
    totalInUSDC: totalIn.toString(),
    totalOutToken: totalOut.toString(),
    lastTs: events.at(-1)?.ts || null,
  }
}

// Retourne toutes les exécutions (tous délégateurs) contenant un structHash donné
export function findRunsByStructHash(targetStructHash: string): DcaRunEvent[] {
  const fs = require('node:fs') as typeof import('node:fs')
  const out: DcaRunEvent[] = []
  try {
    if (!fs.existsSync(HISTORY_DIR)) return []
    const files = fs.readdirSync(HISTORY_DIR).filter((f: string) => f.endsWith('.json'))
    for (const f of files) {
      try {
        const arr = JSON.parse(fs.readFileSync(join(HISTORY_DIR, f), 'utf8')) as DcaRunEvent[]
        for (const ev of arr) {
          if (ev.structHashes && ev.structHashes.some((h) => h.toLowerCase() === targetStructHash.toLowerCase())) {
            out.push(ev)
          }
        }
      } catch {}
    }
  } catch {}
  return out
}
