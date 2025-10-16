import { defineChain } from 'viem'

// Monad Testnet configuration
export const monadTestnet = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'MON',
    symbol: 'MON',
  },
  rpcUrls: {
    default: {
      http: [import.meta.env.VITE_RPC_URL || 'https://monad-testnet.g.alchemy.com/v2/aTJRGO9wVfbt3feglwTpq'],
    },
  },
  blockExplorers: {
    default: { name: 'Monad Explorer', url: 'https://explorer.testnet.monad.xyz' },
  },
  testnet: true,
})

export const CHAIN_ID = 10143
