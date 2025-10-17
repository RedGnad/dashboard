import fs from 'node:fs'
import path from 'node:path'
import { IngestedEvent, EventRecord } from './schema'

// Simple append-only JSONL event store (phase 1). Not optimized; acceptable for prototype scale.
// File: data/hyperindex/events.log

const DATA_DIR = path.join(process.cwd(), 'data', 'hyperindex')
const EVENTS_FILE = path.join(DATA_DIR, 'events.log')

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
}

export function appendEvents(evts: IngestedEvent[]): number {
  if (!evts.length) return 0
  ensureDir()
  const lines = evts.map(e => JSON.stringify(e))
  fs.appendFileSync(EVENTS_FILE, lines.join('\n') + '\n')
  return evts.length
}

export interface QueryEventsOpts {
  sinceTs?: number
  limit?: number
  typeIn?: string[]
}

export function queryEvents(opts: QueryEventsOpts = {}): EventRecord[] {
  if (!fs.existsSync(EVENTS_FILE)) return []
  const raw = fs.readFileSync(EVENTS_FILE, 'utf8')
  if (!raw.trim()) return []
  const lines = raw.trim().split('\n')
  const out: EventRecord[] = []
  for (let i = lines.length - 1; i >= 0; i--) { // reverse iterate for recent-first
    const l = lines[i]
    if (!l) continue
    try {
      const j = JSON.parse(l)
      if (opts.sinceTs && j.ts < opts.sinceTs) continue
      if (opts.typeIn && !opts.typeIn.includes(j.type)) continue
      out.push(j)
      if (opts.limit && out.length >= opts.limit) break
    } catch {}
  }
  return out.reverse() // chronological order
}

export function loadAllEvents(): EventRecord[] {
  if (!fs.existsSync(EVENTS_FILE)) return []
  const raw = fs.readFileSync(EVENTS_FILE, 'utf8').trim()
  if (!raw) return []
  const lines = raw.split('\n')
  const out: EventRecord[] = []
  for (const l of lines) {
    if (!l) continue
    try { out.push(JSON.parse(l)) } catch {}
  }
  return out
}

export function countEvents(): number {
  if (!fs.existsSync(EVENTS_FILE)) return 0
  const raw = fs.readFileSync(EVENTS_FILE, 'utf8').trim()
  if (!raw) return 0
  return raw.split('\n').filter(Boolean).length
}
