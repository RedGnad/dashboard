import { describe, it, expect } from 'vitest'
import { appendEvents, loadAllEvents } from '../hyperindex/eventStore'
import { aggregateHyperIndex } from '../hyperindex/aggregator'
import fs from 'node:fs'
import path from 'node:path'

function withIsolatedHyperindex(fn: () => void) {
  const dir = path.join(process.cwd(), 'data', 'hyperindex')
  const backup = path.join(process.cwd(), 'data', 'hyperindex.backup')
  const had = fs.existsSync(dir)
  if (had) {
    fs.rmSync(backup, { recursive: true, force: true })
    fs.renameSync(dir, backup)
  }
  try {
    fn()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    if (had) fs.renameSync(backup, dir)
    else fs.rmSync(backup, { recursive: true, force: true })
  }
}

describe('hyperindex eventSetHash', () => {
  it('is deterministic across reorder of identical event multiset', () => {
    withIsolatedHyperindex(() => {
      const baseTs = Date.now() - 10000
      appendEvents([
        { id: 'a', ts: baseTs + 1, chainId: 1, type: 'swap', price: 1.01, amountQuote: '10' },
        { id: 'b', ts: baseTs + 2, chainId: 1, type: 'transfer', price: 1.02, amountQuote: '5' },
        { id: 'c', ts: baseTs + 3, chainId: 1, type: 'swap', price: 1.05, amountQuote: '8' },
      ] as any)
      const agg1 = aggregateHyperIndex({ now: baseTs + 5000, includeCanonical: true })
      expect(agg1).toBeTruthy()
      const h1 = agg1!.eventSetHash
      // rewrite reversed order
      const events = loadAllEvents().reverse()
      const dir = path.join(process.cwd(), 'data', 'hyperindex')
      const file = path.join(dir, 'events.log')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n')
  const agg2 = aggregateHyperIndex({ now: baseTs + 5000, includeCanonical: true })
  expect(agg2, 'second aggregation should not be null').toBeTruthy()
  expect(agg2!.eventSetHash).toEqual(h1)
    })
  })
})
