import 'dotenv/config';
import { createPublicClient, http, defineChain } from 'viem';
import { createBundlerClient, createPaymasterClient } from 'viem/account-abstraction';
import { CHAIN_ID, ENTRY_POINT_V07 } from './constants';

export const monadTestnet = defineChain({
  id: CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.RPC_URL ?? 'https://testnet-rpc.monad.xyz'] },
    public: { http: [process.env.RPC_URL ?? 'https://testnet-rpc.monad.xyz'] },
  },
  blockExplorers: {
    default: { name: 'Monad Explorer', url: 'https://testnet.monadexplorer.com' },
  },
});

export const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(process.env.RPC_URL ?? 'https://testnet-rpc.monad.xyz', {
    // Gentle retry policy for bursty 429s - increased delays for rate limits
    retryCount: Math.max(3, Number(process.env.RPC_RETRY_COUNT || 5)),
    retryDelay: Number(process.env.RPC_RETRY_DELAY_MS || 500),
    timeout: 30000, // 30s timeout
    // Optionally send extra headers to avoid some gateways classifying as bots
    // fetchOptions: { headers: { 'User-Agent': 'dca-autonomous-wallet/0.1' } },
  }),
});

// A distinct “bare” client for Delegation Toolkit to avoid account typing conflicts
// Helper returning a view of publicClient acceptable for toolkit smart account creation.
// (Avoids second instantiation + complex intersection types.)
export function asToolkitClient() {
  return publicClient as any
}

// Patch readContract to satisfy stricter viem toolchain typings (inject authorizationList placeholder)
try {
  const orig = (publicClient as any).readContract
  if (typeof orig === 'function') {
    ;(publicClient as any).readContract = (args: any) => orig({ authorizationList: undefined, ...args })
  }
} catch {}

// Casting publicClient for AA bundler to avoid intersection narrowing issues introduced by toolkit typings.
export const bundlerClient = createBundlerClient({
  client: publicClient as any,
  transport: http(process.env.ZERO_DEV_BUNDLER_RPC!, {
    retryCount: Math.max(2, Number(process.env.RPC_RETRY_COUNT || 3)),
    retryDelay: Number(process.env.RPC_RETRY_DELAY_MS || 250),
  }),
});

const paymasterRpc = process.env.ZERO_DEV_PAYMASTER_RPC ?? process.env.PIMLICO_PAYMASTER_RPC
if (!paymasterRpc) {
  console.warn('[AA] No PAYMASTER RPC configured. Set ZERO_DEV_PAYMASTER_RPC or PIMLICO_PAYMASTER_RPC.')
}
export const paymasterClient = createPaymasterClient({
  transport: http(paymasterRpc ?? '', {
    retryCount: Math.max(2, Number(process.env.RPC_RETRY_COUNT || 3)),
    retryDelay: Number(process.env.RPC_RETRY_DELAY_MS || 250),
  }),
});
