import { http, createConfig } from 'wagmi'
import { injected, coinbaseWallet } from 'wagmi/connectors'
import { monadTestnet } from './chain'

export const config = createConfig({
  chains: [monadTestnet],
  connectors: [
    // Connecteur générique pour wallets injectés (EIP-6963) - inclut MetaMask
    injected(),
    // Coinbase Wallet officiel
    coinbaseWallet({
      appName: 'DCA Delegation',
    }),
  ],
  transports: {
    [monadTestnet.id]: http(import.meta.env.VITE_RPC_URL),
  },
  multiInjectedProviderDiscovery: true,
})
