import { appendEvents } from './hyperindex/eventStore'

// Inject a burst of synthetic 'transfer' events to trigger abnormalTransferFlag heuristics.
// Usage: ts-node src/simulate-hyperindex-anomaly.ts (or compiled node dist/...)

async function main() {
  const n = Number(process.env.COUNT || 60)
  const now = Date.now()
  const events = []
  for (let i=0;i<n;i++) {
    events.push({
      id: 'sim_transfer_'+now+'_'+i,
      ts: now - Math.floor(Math.random()* 5_000),
      chainId: 0,
      type: 'transfer',
      amountQuote: (Math.random()*10).toFixed(4),
      price: null,
    })
  }
  const added = appendEvents(events as any)
  console.log('[simulate-hyperindex-anomaly] appended', added, 'transfer events')
}

main().catch(e => { console.error(e); process.exit(1) })
