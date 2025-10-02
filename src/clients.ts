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
  transport: http(process.env.RPC_URL ?? 'https://testnet-rpc.monad.xyz'),
});

export const bundlerClient = createBundlerClient({
  client: publicClient,
  transport: http(process.env.ZERO_DEV_BUNDLER_RPC!),
});

const paymasterRpc = process.env.ZERO_DEV_PAYMASTER_RPC ?? process.env.PIMLICO_PAYMASTER_RPC
if (!paymasterRpc) {
  console.warn('[AA] No PAYMASTER RPC configured. Set ZERO_DEV_PAYMASTER_RPC or PIMLICO_PAYMASTER_RPC.')
}
export const paymasterClient = createPaymasterClient({
  transport: http(paymasterRpc ?? ''),
});
