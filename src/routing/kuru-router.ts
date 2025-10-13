/**
 * Kuru Router Integration
 * Provides routing for exotic pairs via KuruFlowEntrypoint
 */
import { Address, encodeFunctionData } from 'viem';
import { kuruFlowEntrypointAbi } from './kuru-flow-abi.js';

// Kuru contracts on Monad Testnet
export const KURU_ROUTER = '0xc816865f172d640d93712C68a7E1F83F3fA63235' as const;
export const KURU_FLOW_ENTRYPOINT = '0x96eaC98928437496DdD0Cd2080E54Fe78BaC99b6' as const;
export const KURU_ORDERBOOK_MON_USDC = '0xd3af145f1aa1a471b5f0f62c52cf8fcdc9ab55d3' as const;

// Token addresses
export const DAKIMAKURA = '0x0569049E527BB151605EEC7bf48Cfd55bD2Bf4c8' as const;
export const WBTC = '0xcf5a6076cfa32686c0Df13aBaDa2b40dec133F1d' as const;
export const BEAN = '0x268e4e24e0051ec27b3d27a95977e71ce6875a05' as const;
export const CHOG = '0xe0590015a873bf326bd645c3e1266d4db41c4e6b' as const;
export const DAK = '0x0f0bdebf0f83cd1ee3974779bcb7315f9808c714' as const;
export const YAKI = '0xfe140e1dCe99Be9F4F15d657CD9b7BF622270C50' as const;

/**
 * Exotic pairs that require KuruFlowEntrypoint
 */
export const EXOTIC_PAIRS = [
  'WMON_DAKIMAKURA',
  'WMON_WBTC',
  'WMON_BEAN',
  'WMON_CHOG',
  'WMON_DAK',
  'WMON_YAKI',
  'DAKIMAKURA_USDC',
  'WBTC_USDC',
] as const;

export type ExoticPair = typeof EXOTIC_PAIRS[number];

/**
 * Check if a pair is exotic (requires KuruFlowEntrypoint)
 */
export function isExoticPair(tokenA: Address, tokenOut: Address): boolean {
  const isDakimakura = tokenOut.toLowerCase() === DAKIMAKURA.toLowerCase();
  console.log(`[Kuru] Checking if exotic pair: ${tokenOut} -> DAKIMAKURA: ${isDakimakura}`);
  return isDakimakura;
}

/**
 * Check if Kuru has a route for a pair
 */
export async function hasKuruRoute(tokenIn: Address, tokenOut: Address): Promise<boolean> {
  return isExoticPair(tokenIn, tokenOut);
}

/**
 * Find Kuru route (simplified for KuruFlowEntrypoint)
 */
export async function findKuruRoute(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint
): Promise<{
  markets: Address[];
  isBuy: boolean[];
  nativeSend: boolean[];
  estimatedOut: bigint;
  routerUsed: Address;
  encodedCall: `0x${string}`;
} | null> {
  console.log(`[Kuru] Finding route for ${tokenIn} -> ${tokenOut}`);

  // Check if this is a DAKIMAKURA swap
  const isDakimakura = tokenOut.toLowerCase() === DAKIMAKURA.toLowerCase();

  if (!isDakimakura) {
    console.log('[Kuru] Not a DAKIMAKURA swap, no route');
    return null;
  }

  console.log('[Kuru] ✅ DAKIMAKURA swap detected, using KuruFlowEntrypoint');

  // For DAKIMAKURA, we use KuruFlowEntrypoint with executeSwap
  const swapIntent = {
    tokenUserBuys: tokenOut,
    minAmountUserBuys: 0n, // No slippage protection for now
    tokenUserSells: tokenIn,
    amountUserSells: amountIn,
  };

  const feeCollection = {
    feeCollectorAddress: '0x0000000000000000000000000000000000000000' as Address,
    feeBps: 0n,
    referrerAddress: '0x0000000000000000000000000000000000000000' as Address,
    referrerFeeBps: 0n,
    isInTokenFee: false,
  };

  const program = '0x' as `0x${string}`;

  const encodedCall = encodeFunctionData({
    abi: kuruFlowEntrypointAbi,
    functionName: 'executeSwap',
    args: [swapIntent, feeCollection, program],
  });

  console.log(`[Kuru] Encoded call: ${encodedCall.slice(0, 50)}...`);
  console.log(`[Kuru] Router used: ${KURU_FLOW_ENTRYPOINT}`);

  return {
    markets: [],
    isBuy: [],
    nativeSend: [],
    estimatedOut: 0n,
    routerUsed: KURU_FLOW_ENTRYPOINT,
    encodedCall,
  };
}

/**
 * Encode Kuru swap using KuruFlowEntrypoint
 */
export function encodeKuruSwap(params: {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  recipient?: Address;
}): `0x${string}` {
  const { tokenIn, tokenOut, amountIn, minAmountOut } = params;

  const swapIntent = {
    tokenUserBuys: tokenOut,
    minAmountUserBuys: minAmountOut,
    tokenUserSells: tokenIn,
    amountUserSells: amountIn,
  };

  const feeCollection = {
    feeCollectorAddress: '0x0000000000000000000000000000000000000000' as Address,
    feeBps: 0n,
    referrerAddress: '0x0000000000000000000000000000000000000000' as Address,
    referrerFeeBps: 0n,
    isInTokenFee: false,
  };

  const program = '0x' as `0x${string}`;

  return encodeFunctionData({
    abi: kuruFlowEntrypointAbi,
    functionName: 'executeSwap',
    args: [swapIntent, feeCollection, program],
  });
}
