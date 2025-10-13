import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DelegatorCoverageStats {
  delegator: string
  totalExecutions: number
  settledExecutions: number
  pendingExecutions: number
  settlementRatio: number
  avgSettlementLatencyMs: number | null
  medianSettlementLatencyMs: number | null
  firstExecutionTs: number | null
  lastExecutionTs: number | null
  uniqueStructHashes: number
  lastRollingHash?: string | null
}

export interface GlobalCoverageStats {
  delegators: number
  totalExecutions: number
  settledExecutions: number
  pendingExecutions: number
  avgSettlementLatencyMs: number | null
  medianSettlementLatencyMs: number | null
  entries: DelegatorCoverageStats[]
  lastRollingHash?: string | null
}

interface ExecRecord { runId?: string; ts: number; structHash: string; userOperationHash?: string; rollingHash?: string }
interface SettledRecord { runId?: string; ts: number; userOperationHash?: string; txHash?: string; blockNumber?: string; rollingHash?: string }

function parseAuditLines(): any[] {
  const file = join(process.cwd(), 'data', 'delegations', 'audit.log')
  if (!existsSync(file)) return []
  const raw = readFileSync(file, 'utf8').trim()
  if (!raw) return []
  const out: any[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch {}
  }
  return out
}

export function computeDelegatorCoverage(addr: string): DelegatorCoverageStats {
  const delegator = addr.toLowerCase()
  const lines = parseAuditLines()
  const executes: ExecRecord[] = []
  const settled: SettledRecord[] = []
  let lastRolling: string | null = null
  const structSet = new Set<string>()
  for (const l of lines) {
    if (l.rollingHash) lastRolling = l.rollingHash
    if ((l.delegator || '').toLowerCase() !== delegator) continue
    if (l.structHash) structSet.add(String(l.structHash).toLowerCase())
    if (l.action === 'execute') {
      executes.push({ ts: l.ts, structHash: l.structHash, runId: l.runId, userOperationHash: l.userOperationHash, rollingHash: l.rollingHash })
    } else if (l.action === 'userop_settled') {
      settled.push({ ts: l.ts, runId: l.runId, userOperationHash: l.userOperationHash, txHash: l.txHash, blockNumber: l.blockNumber, rollingHash: l.rollingHash })
    }
  }
  // Map userOperationHash -> settlement ts
  const settlementTs = new Map<string, number>()
  for (const s of settled) {
    if (s.userOperationHash) settlementTs.set(s.userOperationHash.toLowerCase(), s.ts)
  }
  const latencies: number[] = []
  let firstTs: number | null = null
  let lastTs: number | null = null
  let settledCount = 0
  for (const e of executes) {
    if (firstTs === null || e.ts < firstTs) firstTs = e.ts
    if (lastTs === null || e.ts > lastTs) lastTs = e.ts
    if (e.userOperationHash) {
      const st = settlementTs.get(e.userOperationHash.toLowerCase())
      if (st !== undefined) {
        settledCount++
        latencies.push(st - e.ts)
      }
    }
  }
  latencies.sort((a,b)=>a-b)
  const totalExecutions = executes.length
  const pendingExecutions = totalExecutions - settledCount
  const avgLatency = latencies.length ? (latencies.reduce((a,b)=>a+b,0) / latencies.length) : null
  const medianLatency = latencies.length ? latencies[Math.floor(latencies.length/2)] : null
  return {
    delegator,
    totalExecutions,
    settledExecutions: settledCount,
    pendingExecutions,
    settlementRatio: totalExecutions === 0 ? 0 : settledCount / totalExecutions,
    avgSettlementLatencyMs: avgLatency,
    medianSettlementLatencyMs: medianLatency,
    firstExecutionTs: firstTs,
    lastExecutionTs: lastTs,
    uniqueStructHashes: structSet.size,
    lastRollingHash: lastRolling,
  }
}

export function computeGlobalCoverage(): GlobalCoverageStats {
  const lines = parseAuditLines()
  const perDelegator = new Map<string, { executes: ExecRecord[]; settled: SettledRecord[] }>()
  let lastRolling: string | null = null
  for (const l of lines) {
    if (l.rollingHash) lastRolling = l.rollingHash
    const delegator = (l.delegator || '').toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(delegator)) continue
    if (!perDelegator.has(delegator)) perDelegator.set(delegator, { executes: [], settled: [] })
    const rec = perDelegator.get(delegator)!
    if (l.action === 'execute') rec.executes.push({ ts: l.ts, structHash: l.structHash, runId: l.runId, userOperationHash: l.userOperationHash, rollingHash: l.rollingHash })
    else if (l.action === 'userop_settled') rec.settled.push({ ts: l.ts, runId: l.runId, userOperationHash: l.userOperationHash, txHash: l.txHash, blockNumber: l.blockNumber, rollingHash: l.rollingHash })
  }
  let globalExec = 0, globalSettled = 0
  const allLatencies: number[] = []
  const entries: DelegatorCoverageStats[] = []
  for (const [delegator, rec] of perDelegator.entries()) {
    const settlementTs = new Map<string, number>()
    for (const s of rec.settled) if (s.userOperationHash) settlementTs.set(s.userOperationHash.toLowerCase(), s.ts)
    let settledCount = 0
    const latencies: number[] = []
    let firstTs: number | null = null
    let lastTs: number | null = null
    const structSet = new Set<string>()
    for (const e of rec.executes) {
      if (firstTs === null || e.ts < firstTs) firstTs = e.ts
      if (lastTs === null || e.ts > lastTs) lastTs = e.ts
      structSet.add(String(e.structHash).toLowerCase())
      if (e.userOperationHash) {
        const st = settlementTs.get(e.userOperationHash.toLowerCase())
        if (st !== undefined) { settledCount++; latencies.push(st - e.ts); allLatencies.push(st - e.ts) }
      }
    }
    latencies.sort((a,b)=>a-b)
    const totalExecutions = rec.executes.length
    globalExec += totalExecutions
    globalSettled += settledCount
    const avg = latencies.length ? latencies.reduce((a,b)=>a+b,0)/latencies.length : null
    const median = latencies.length ? latencies[Math.floor(latencies.length/2)] : null
    entries.push({
      delegator,
      totalExecutions,
      settledExecutions: settledCount,
      pendingExecutions: totalExecutions - settledCount,
      settlementRatio: totalExecutions === 0 ? 0 : settledCount / totalExecutions,
      avgSettlementLatencyMs: avg,
      medianSettlementLatencyMs: median,
      firstExecutionTs: firstTs,
      lastExecutionTs: lastTs,
      uniqueStructHashes: structSet.size,
      lastRollingHash: lastRolling,
    })
  }
  entries.sort((a,b)=> b.totalExecutions - a.totalExecutions)
  allLatencies.sort((a,b)=>a-b)
  const globalAvg = allLatencies.length ? allLatencies.reduce((a,b)=>a+b,0)/allLatencies.length : null
  const globalMedian = allLatencies.length ? allLatencies[Math.floor(allLatencies.length/2)] : null
  return {
    delegators: entries.length,
    totalExecutions: globalExec,
    settledExecutions: globalSettled,
    pendingExecutions: globalExec - globalSettled,
    avgSettlementLatencyMs: globalAvg,
    medianSettlementLatencyMs: globalMedian,
    entries,
    lastRollingHash: lastRolling,
  }
}
