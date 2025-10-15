#!/usr/bin/env node
import 'dotenv/config'
import { createPublicClient, http } from 'viem'

const monadTestnet = {
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } },
}

const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http('https://testnet-rpc.monad.xyz'),
})

const delegatorSA = '0x022b39bc36eAcf22360F61247487E956812AFe5e'

const tokens = [
  { symbol: 'USDC', address: '0x5425890298aed601595a70AB815c96711a31Bc65' },
  { symbol: 'CHOG', address: '0xe0590015a873bf326bd645c3e1266d4db41c4e6b' },
  { symbol: 'YAKI', address: '0xfe140e1dCe99Be9F4F15d657CD9b7BF622270C50' },
  { symbol: 'DAK', address: '0x0f0bdebf0f83cd1ee3974779bcb7315f9808c714' },
  { symbol: 'BEAN', address: '0x268e4e24e0051ec27b3d27a95977e71ce6875a05' },
  { symbol: 'WBTC', address: '0xcf5a6076cfa32686c0Df13aBaDa2b40dec133F1d' },
  { symbol: 'DAKIMAKURA', address: '0x0569049E527BB151605EEC7bf48Cfd55bD2Bf4c8' },
  { symbol: 'WMON', address: '0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701' },
]

console.log(`🔍 Vérification des balances tokens pour ${delegatorSA}\n`)

for (const token of tokens) {
  try {
    const balance = await publicClient.readContract({
      address: token.address,
      abi: [{
        type: 'function',
        name: 'balanceOf',
        inputs: [{ name: 'account', type: 'address' }],
        outputs: [{ type: 'uint256' }],
        stateMutability: 'view'
      }],
      functionName: 'balanceOf',
      args: [delegatorSA]
    })
    
    const balanceFormatted = Number(balance) / 1e18
    
    if (balance > 0n) {
      console.log(`✅ ${token.symbol}: ${balanceFormatted.toFixed(6)} (${balance.toString()})`)
    } else {
      console.log(`⚪ ${token.symbol}: 0`)
    }
  } catch (e) {
    console.log(`❌ ${token.symbol}: Erreur - ${e.message}`)
  }
}

console.log('\n📊 Résumé:')
console.log('- ✅ = Token avec balance > 0 (sera converti)')
console.log('- ⚪ = Token avec balance = 0 (ignoré)')
console.log('- ❌ = Erreur de lecture (token invalide?)')
