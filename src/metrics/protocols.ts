import 'dotenv/config'
import { Address } from 'viem'
import { publicClient } from '../clients'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type ProtocolId = string

export interface ProtocolDef {
  id: ProtocolId
  name: string
  addresses: Address[] // contracts to consider as protocol touchpoints (router, core)
  startBlock?: number // optional, to compute cumulative metrics later
  envioEndpoint?: string // optional GraphQL endpoint (Envio)
}

export interface DailyProtocolMetrics {
  id: ProtocolId
  dateISO: string // YYYY-MM-DD (UTC)
  usersDaily: number
  txDaily: number
  txCumulative: number | null // null if not computed
  avgTxPerUser: number
  avgFeeNative?: number | null // average fee in native token (MON)
  // Optional enriched counters when available from indexer
  depositDaily?: number | null
  withdrawDaily?: number | null
}

const DATA_DIR = join(process.cwd(), 'data', 'metrics')
const REGISTRY_FILE = join(process.cwd(), 'data', 'protocols.json')

function ensureMetricsDir() {
  try { mkdirSync(DATA_DIR, { recursive: true }) } catch {}
}

export function loadRegistry(): ProtocolDef[] {
  // Prefer external file if present for real protocols; otherwise provide a minimal default example.
  if (existsSync(REGISTRY_FILE)) {
    try {
      const json = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'))
      if (Array.isArray(json)) return json
    } catch {}
  }
  // Fallback: include only UniswapV2 Router02 if constants exist in env (optional)
  try {
    const { UNISWAP_V2_ROUTER02 } = require('../constants')
    const reg = [] as ProtocolDef[]
    // Include FortyTwo Core as a starter protocol (addresses list for reference; Envio will be used for metrics)
    try { reg.push({ id: 'fortytwo', name: 'FortyTwo Core', addresses: ['0xDf26B347a02e74cd8bf6F562454826CD49CC6CB1'] as any }) } catch {}
    if (UNISWAP_V2_ROUTER02) {
      reg.push({ id: 'uniswapv2-router', name: 'Uniswap V2 Router (example)', addresses: [UNISWAP_V2_ROUTER02] })
    }
    if (reg.length > 0) return reg
  } catch {}
  return []
}

function parseHours(hours?: any, def = 24): number {
  const n = Number(hours)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(168, Math.max(1, Math.floor(n))) // clamp 1..168h
}

function getBlockTimeSec(): number {
  const raw = process.env.MONAD_BLOCK_TIME_SEC
  const v = raw ? Number(raw) : NaN
  return Number.isFinite(v) && v > 0 ? v : 2 // default ~2s
}

export interface RpcDailyOpts {
  hours?: number
  maxBlocksScan?: number
  withFees?: boolean
}

export async function computeDailyMetricsRPC(proto: ProtocolDef, opts: RpcDailyOpts = {}): Promise<DailyProtocolMetrics> {
  const hours = parseHours(opts.hours, 24)
  const blockTime = getBlockTimeSec()
  const latest = await publicClient.getBlockNumber()
  const approxBlocks = BigInt(Math.ceil((hours * 3600) / blockTime))
  const fromBlock = latest > approxBlocks ? (latest - approxBlocks) : 0n
  const toBlock = latest
  const maxBlocks = Math.max(100, Number(opts.maxBlocksScan ?? 3000))
  const span = Number(toBlock - fromBlock)
  if (span > maxBlocks) {
    // Reduce window to last maxBlocks
    const adjFrom = toBlock - BigInt(maxBlocks)
    return computeDailyMetricsRPC(proto, { ...opts, hours: Math.ceil((maxBlocks * blockTime) / 3600), maxBlocksScan: maxBlocks })
  }

  let txCount = 0
  const users = new Set<string>()
  let feeSum: bigint = 0n
  let feeCount = 0

  for (let bn = fromBlock; bn <= toBlock; bn++) {
    const block = await publicClient.getBlock({ blockNumber: bn, includeTransactions: true })
    // Filter transactions where "to" is one of protocol addresses
    const addrs = new Set(proto.addresses.map(a => a.toLowerCase()))
    for (const tx of block.transactions) {
      const to = (tx.to || '').toLowerCase()
      if (to && addrs.has(to)) {
        txCount++
        if (tx.from) users.add(tx.from.toLowerCase())
        if (opts.withFees) {
          try {
            const rcpt = await publicClient.getTransactionReceipt({ hash: tx.hash })
            // Prefer effectiveGasPrice if available; else gasPrice
            const price = (rcpt.effectiveGasPrice ?? (tx as any).gasPrice ?? 0n) as bigint
            const fee = price * rcpt.gasUsed
            feeSum += fee
            feeCount++
          } catch {}
        }
      }
    }
  }

  const usersDaily = users.size
  const avgTxPerUser = usersDaily > 0 ? txCount / usersDaily : 0
  const avgFeeNative = feeCount > 0 ? Number(feeSum) / feeCount : null
  const dateISO = new Date().toISOString().slice(0,10)
  return {
    id: proto.id,
    dateISO,
    usersDaily,
    txDaily: txCount,
    txCumulative: null, // not computed in RPC quick mode
    avgTxPerUser,
    avgFeeNative,
    depositDaily: null,
    withdrawDaily: null,
  }
}

export async function computeDailyForAllRPC(registry: ProtocolDef[], opts?: RpcDailyOpts): Promise<DailyProtocolMetrics[]> {
  const out: DailyProtocolMetrics[] = []
  for (const p of registry) {
    try { out.push(await computeDailyMetricsRPC(p, opts)) } catch (e) {
      out.push({ id: p.id, dateISO: new Date().toISOString().slice(0,10), usersDaily: 0, txDaily: 0, txCumulative: null, avgTxPerUser: 0, avgFeeNative: null, depositDaily: null, withdrawDaily: null })
    }
  }
  return out
}

// Optional Envio adapter (outline). Implement later when endpoints are known.
export async function computeDailyViaEnvio(_proto: ProtocolDef, _dateISO?: string): Promise<DailyProtocolMetrics | null> {
  // Placeholder: requires protocol-specific Envio GraphQL
  return null
}
