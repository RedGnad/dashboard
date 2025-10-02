import 'dotenv/config'
import { Chain } from 'viem/chains'
import { startServer } from './server'

// Monad testnet chain config (viem custom)
const monadTestnet: Chain = {
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.RPC_URL || 'https://testnet-rpc.monad.xyz'] },
    public: { http: [process.env.RPC_URL || 'https://testnet-rpc.monad.xyz'] },
  },
} as const

// Note: Backend API only; execution happens via POST /api/delegations.

async function main() {
  const bundlerUrl = process.env.ZERO_DEV_BUNDLER_RPC || process.env.PIMLICO_BUNDLER_RPC
  const paymasterUrl = process.env.ZERO_DEV_PAYMASTER_RPC || process.env.PIMLICO_PAYMASTER_RPC
  const delegatePk = process.env.DELEGATE_PRIVATE_KEY
  if (!bundlerUrl) console.warn('[boot] ZERO_DEV_BUNDLER_RPC missing. Configure to submit AA userOps.')
  if (!paymasterUrl) console.warn('[boot] ZERO_DEV_PAYMASTER_RPC missing. Sponsorship will be disabled.')
  if (!delegatePk) console.warn('[boot] DELEGATE_PRIVATE_KEY missing. /api/delegate will fail until set.')

  // Start API only; execution happens on-demand via POST /api/delegations
  if (!process.env.NO_API) startServer()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
