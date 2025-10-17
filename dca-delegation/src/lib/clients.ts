import { createPublicClient, createWalletClient, http, custom, fallback } from 'viem'
import { createBundlerClient, createPaymasterClient } from 'viem/account-abstraction'
import { monadTestnet } from './chain'

// Public client for reading blockchain state
const primaryRpc = import.meta.env.VITE_RPC_URL as string | undefined
const rpcTransports = [primaryRpc, 'https://testnet-rpc.monad.xyz']
  .filter((u) => !!u)
  .map((u) => http(u as string))

export const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: rpcTransports.length > 1 ? fallback(rpcTransports) : rpcTransports[0],
})

// Bundler client for sending UserOperations via ZeroDev
export const bundlerClient = createBundlerClient({
  client: publicClient,
  transport: http(import.meta.env.VITE_ZERO_DEV_BUNDLER_RPC),
})

// Paymaster client for sponsoring UserOperations via ZeroDev
export const paymasterClient = createPaymasterClient({
  transport: http(import.meta.env.VITE_ZERO_DEV_PAYMASTER_RPC),
})

// Wallet client factory for MetaMask connection
export function createOwnerWalletClient() {
  if (typeof window === 'undefined' || !window.ethereum) {
    throw new Error('MetaMask not available')
  }

  return createWalletClient({
    chain: monadTestnet,
    transport: custom(window.ethereum),
  })
}

// Environment variables validation
export function validateEnv() {
  const required = [
    'VITE_RPC_URL',
    'VITE_ZERO_DEV_BUNDLER_RPC',
    'VITE_ZERO_DEV_PAYMASTER_RPC',
    'VITE_DELEGATE_PRIVATE_KEY',
  ]

  const missing = required.filter(key => !import.meta.env[key])
  
  if (missing.length > 0) {
    console.warn('Missing environment variables:', missing)
  }
  
  return missing.length === 0
}
