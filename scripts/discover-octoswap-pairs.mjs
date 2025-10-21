#!/usr/bin/env node
// Discover Octoswap V2 Pair addresses for selected token combinations
// Usage: node scripts/discover-octoswap-pairs.mjs [factoryAddress]
// Prints a YAML snippet for config.yaml under OctoswapPair.address

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ethers } from 'ethers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// RPC: reuse the one in config.yaml
const RPC_URL = 'https://monad-testnet.g.alchemy.com/v2/aTJRGO9wVfbt3feglwTpq'

// Default Factory (can be overridden by argv)
const DEFAULT_FACTORY = '0xe26dd94f67Ca3615fcaF6062750147F37Df84F7a'

// Tokens from dashboard/src/lib/tokens.ts
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

const PRIORITY_BASES = ['USDC', 'WMON']

async function main() {
  const factoryAddr = (process.argv[2] || DEFAULT_FACTORY).trim()
  const provider = new ethers.JsonRpcProvider(RPC_URL)
  const abiPath = path.join(__dirname, '..', 'abis', 'OctoFactory.json')
  const abi = JSON.parse(fs.readFileSync(abiPath, 'utf-8'))
  const factory = new ethers.Contract(factoryAddr, abi, provider)

  // Build unique token pairs: for each token T, query getPair(T, USDC) and getPair(T, WMON)
  const symbols = Object.keys(TOKENS)
  const pairs = new Set()

  for (const sym of symbols) {
    for (const base of PRIORITY_BASES) {
      if (sym === base) continue
      const a = ethers.getAddress(TOKENS[sym].address)
      const b = ethers.getAddress(TOKENS[base].address)
      try {
        const pair = await factory.getPair(a, b)
        if (pair && pair !== ethers.ZeroAddress) {
          pairs.add(ethers.getAddress(pair))
        }
      } catch (e) {
        // ignore errors; continue
      }
    }
  }

  // Also dump the full factory list if available (best-effort)
  let allPairs = []
  try {
    const len = Number(await factory.allPairsLength())
    const step = 500
    for (let i = 0; i < len; i += step) {
      const end = Math.min(len, i + step)
      const calls = []
      for (let j = i; j < end; j++) calls.push(factory.allPairs(j))
      const chunk = await Promise.all(calls)
      allPairs.push(...chunk.map(ethers.getAddress))
    }
  } catch {}

  for (const p of allPairs) pairs.add(p)

  const list = Array.from(pairs)
  list.sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()))

  // Print YAML snippet
  console.log('OctoswapPair: addresses to paste into ENVIO/config.yaml')
  console.log('---')
  console.log('  - name: OctoswapPair')
  console.log('    address:')
  for (const addr of list) {
    console.log(`      - ${addr}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
