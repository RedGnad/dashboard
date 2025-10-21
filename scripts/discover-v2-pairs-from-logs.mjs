#!/usr/bin/env node
// Discover UniswapV2-style Pair addresses from logs and filter to pairs against USDC/WMON and our tracked tokens.
// Usage:
//   node scripts/discover-v2-pairs-from-logs.mjs [--from <startBlock>] [--to <endBlock>] [--range <blocks>] \
//        [--factory <addr1,addr2,...>]
// Notes:
// - If no --from/--to provided, scans [latest - range, latest]
// - If no --factory provided, scans chain-wide for PairCreated topics (more expensive)

import { ethers } from 'ethers'

const RPC_URL = 'https://monad-testnet.g.alchemy.com/v2/aTJRGO9wVfbt3feglwTpq'

const TOKENS = {
  USDC: { address: '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea', decimals: 6 },
  WMON: { address: '0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701', decimals: 18 },
  BEAN: { address: '0x268e4e24e0051ec27b3d27a95977e71ce6875a05', decimals: 18 },
  CHOG: { address: '0xe0590015a873bf326bd645c3e1266d4db41c4e6b', decimals: 18 },
  DAK:  { address: '0x0f0bdebf0f83cd1ee3974779bcb7315f9808c714', decimals: 18 },
  YAKI: { address: '0xfe140e1dCe99Be9F4F15d657CD9b7BF622270C50', decimals: 18 },
  WBTC: { address: '0xcf5a6076cfa32686c0Df13aBaDa2b40dec133F1d', decimals: 8 },
  PINGU:{ address: '0xA2426cD97583939E79Cfc12aC6E9121e37D0904d', decimals: 18 },
  OCTO: { address: '0xCa9A4F46Faf5628466583486FD5ACE8AC33ce126', decimals: 18 },
  KB:   { address: '0x34d1ae6076aee4072f54e1156d2e507dd564a355', decimals: 18 },
  WSOL: { address: '0x5387C85A4965769f6B0Df430638a1388493486F1', decimals: 9 },
}

const TRACKED = Object.values(TOKENS).map(t => ethers.getAddress(t.address))
const USDC = ethers.getAddress(TOKENS.USDC.address)
const WMON = ethers.getAddress(TOKENS.WMON.address)

const IF_PAIR = new ethers.Interface([
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint)',
])
const IF_V2PAIR = new ethers.Interface([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
])

function parseArgs() {
  const args = process.argv.slice(2)
  const out = { from: null, to: null, range: 500000, factories: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--from') out.from = parseInt(args[++i])
    else if (a === '--to') out.to = parseInt(args[++i])
    else if (a === '--range') out.range = parseInt(args[++i])
    else if (a === '--factory') out.factories = String(args[++i]).split(',').map(s => s.trim()).filter(Boolean)
  }
  return out
}

function overlapsTracked(a, b) {
  return (a === USDC || a === WMON || TRACKED.includes(a)) && (b === USDC || b === WMON || TRACKED.includes(b))
}

async function queryPairCreated(provider, fromBlock, toBlock, factories) {
  const topic = ethers.id('PairCreated(address,address,address,uint256)')
  const filter = { fromBlock, toBlock, topics: [topic] }
  const logs = []
  if (factories && factories.length) {
    for (const addr of factories) {
      const f = { ...filter, address: ethers.getAddress(addr) }
      try {
        const part = await provider.getLogs(f)
        logs.push(...part)
      } catch {}
    }
  } else {
    try { logs.push(...(await provider.getLogs(filter))) } catch {}
  }
  return logs
}

async function main() {
  const { from, to, range, factories } = parseArgs()
  const provider = new ethers.JsonRpcProvider(RPC_URL)
  const latest = await provider.getBlockNumber()
  const fromBlock = from ?? Math.max(0, latest - (range || 500000))
  const toBlock = to ?? latest

  const logs = await queryPairCreated(provider, fromBlock, toBlock, factories)
  const pairs = new Set()
  for (const log of logs) {
    try {
      const parsed = IF_PAIR.parseLog({ topics: log.topics, data: log.data })
      const token0 = ethers.getAddress(parsed.args.token0)
      const token1 = ethers.getAddress(parsed.args.token1)
      const pair = ethers.getAddress(parsed.args.pair)
      if (overlapsTracked(token0, token1)) pairs.add(pair)
    } catch {}
  }

  // If none found and no factories provided, try to discover from Swap topic addresses (coarse)
  if (pairs.size === 0 && (!factories || factories.length === 0)) {
    const swapTopic = ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)')
    const f2 = { fromBlock, toBlock, topics: [swapTopic] }
    try {
      const swapLogs = await provider.getLogs(f2)
      for (const l of swapLogs) pairs.add(ethers.getAddress(l.address))
    } catch {}
  }

  const pairList = Array.from(pairs)
  const keep = []
  for (const p of pairList) {
    try {
      const c = new ethers.Contract(p, IF_V2PAIR, provider)
      const [t0, t1] = await Promise.all([c.token0(), c.token1()])
      const a0 = ethers.getAddress(t0)
      const a1 = ethers.getAddress(t1)
      if (overlapsTracked(a0, a1)) keep.push({ pair: p, token0: a0, token1: a1 })
    } catch {}
  }

  console.log('UniswapV2 Pairs (filtered to tracked tokens vs USDC/WMON)')
  console.log('---')
  if (keep.length === 0) {
    console.log('# none found in the scanned range')
  } else {
    console.log('  - name: OctoswapPair')
    console.log('    address:')
    for (const k of keep) console.log(`      - ${k.pair}`)
  }
}

main().catch((e)=>{ console.error(e); process.exit(1) })
