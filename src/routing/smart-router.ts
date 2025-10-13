/**
 * Smart Router with Uniswap → Kuru Fallback
 * Automatically routes through Kuru for exotic pairs not available on Uniswap
 */
import { Address, encodeFunctionData } from 'viem';
import { createExecution } from '@metamask/delegation-toolkit';
import { UNISWAP_V2_ROUTER02, USDC, WMON } from '../constants';
import {
  KURU_ROUTER,
  findKuruRoute,
  encodeKuruSwap,
  isExoticPair,
  hasKuruRoute,
  DAKIMAKURA,
  WBTC,
} from './kuru-router';

// Minimal ABIs
const erc20Abi = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

const uniswapRouterAbi = [
  {
    name: 'swapExactTokensForTokens',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const;

export type SwapRoute = 'uniswap' | 'kuru';

export type SmartSwapParams = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  recipient: Address;
  // Optional: force a specific router
  forceRouter?: SwapRoute;
  // Optional: custom path for Uniswap (if known)
  uniswapPath?: Address[];
};

export type SmartSwapResult = {
  executions: any[];
  router: SwapRoute;
  path?: Address[]; // For Uniswap
  markets?: Address[]; // For Kuru
};

/**
 * Build swap executions with intelligent routing
 * - Tries Uniswap first for common pairs
 * - Falls back to Kuru for exotic pairs (WMON-DAKIMAKURA, WMON-WBTC, etc.)
 */
export async function buildSmartSwapExecutions(
  params: SmartSwapParams
): Promise<SmartSwapResult> {
  const { tokenIn, tokenOut, amountIn, minAmountOut, recipient, forceRouter, uniswapPath } = params;

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 30); // 30 min deadline

  // If router is forced, use it
  if (forceRouter === 'kuru') {
    console.log('[SmartRouter] Forced Kuru routing');
    return buildKuruSwap({ tokenIn, tokenOut, amountIn, minAmountOut, recipient });
  }

  if (forceRouter === 'uniswap') {
    console.log('[SmartRouter] Forced Uniswap routing');
    return buildUniswapSwap({
      tokenIn,
      tokenOut,
      amountIn,
      minAmountOut,
      recipient,
      deadline,
      path: uniswapPath,
    });
  }

  // Auto-detect: Check if pair is exotic
  if (isExoticPair(tokenIn, tokenOut)) {
    console.log('[SmartRouter] Exotic pair detected, checking Kuru...');
    const hasKuru = await hasKuruRoute(tokenIn, tokenOut);
    
    if (hasKuru) {
      console.log('[SmartRouter] Using Kuru for exotic pair');
      return buildKuruSwap({ tokenIn, tokenOut, amountIn, minAmountOut, recipient });
    } else {
      console.warn('[SmartRouter] Exotic pair but no Kuru route, falling back to Uniswap');
      // Try Uniswap anyway (might fail on-chain)
      return buildUniswapSwap({
        tokenIn,
        tokenOut,
        amountIn,
        minAmountOut,
        recipient,
        deadline,
        path: uniswapPath,
      });
    }
  }

  // Default: Use Uniswap for common pairs
  console.log('[SmartRouter] Using Uniswap for common pair');
  return buildUniswapSwap({
    tokenIn,
    tokenOut,
    amountIn,
    minAmountOut,
    recipient,
    deadline,
    path: uniswapPath,
  });
}

/**
 * Build Uniswap swap executions
 */
function buildUniswapSwap(params: {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  recipient: Address;
  deadline: bigint;
  path?: Address[];
}): SmartSwapResult {
  const { tokenIn, tokenOut, amountIn, minAmountOut, recipient, deadline, path } = params;

  // Default path: direct swap
  const swapPath: Address[] = path || [tokenIn, tokenOut];

  // 1. Approve Uniswap Router to spend tokenIn
  const approveExecution = createExecution({
    target: tokenIn,
    value: 0n,
    callData: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [UNISWAP_V2_ROUTER02, amountIn],
    }),
  });

  // 2. Swap via Uniswap
  const swapExecution = createExecution({
    target: UNISWAP_V2_ROUTER02,
    value: 0n,
    callData: encodeFunctionData({
      abi: uniswapRouterAbi,
      functionName: 'swapExactTokensForTokens',
      args: [amountIn, minAmountOut, swapPath, recipient, deadline],
    }),
  });

  return {
    executions: [approveExecution, swapExecution],
    router: 'uniswap',
    path: swapPath,
  };
}

/**
 * Build Kuru swap executions
 */
async function buildKuruSwap(params: {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  recipient: Address;
}): Promise<SmartSwapResult> {
  const { tokenIn, tokenOut, amountIn, minAmountOut, recipient } = params;

  // Find Kuru route
  const route = await findKuruRoute(tokenIn, tokenOut, amountIn);

  if (!route) {
    throw new Error(`[SmartRouter] No Kuru route found for ${tokenIn} -> ${tokenOut}`);
  }

  const { markets, routerUsed, encodedCall } = route;

  console.log(`[SmartRouter] Using Kuru router: ${routerUsed}`);
  console.log(`[SmartRouter] Encoded call: ${encodedCall.slice(0, 50)}...`);

  const executions: any[] = [];
  
  // Check if tokenIn is WMON (which might be sent as native MON)
  const isNative = tokenIn.toLowerCase() === WMON.toLowerCase();

  if (!isNative) {
    // For ERC20 tokens, we need approval
    const approveExecution = createExecution({
      target: tokenIn,
      value: 0n,
      callData: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [routerUsed, amountIn],
      }),
    });
    executions.push(approveExecution);
    console.log(`[SmartRouter] Added approval for ${tokenIn} to ${routerUsed}`);
  }

  // Swap via the correct Kuru contract
  const swapExecution = createExecution({
    target: routerUsed,
    value: isNative ? amountIn : 0n, // Send native MON if tokenIn is WMON
    callData: encodedCall,
  });

  executions.push(swapExecution);
  console.log(`[SmartRouter] Added swap execution to ${routerUsed} with value ${isNative ? amountIn.toString() : '0'}`);

  return {
    executions,
    router: 'kuru',
    markets,
  };
}

/**
 * Helper: Get token symbol for logging
 */
function getTokenSymbol(address: Address): string {
  const symbolMap: Record<string, string> = {
    [WMON.toLowerCase()]: 'WMON',
    [USDC.toLowerCase()]: 'USDC',
    [DAKIMAKURA.toLowerCase()]: 'DAKIMAKURA',
    [WBTC.toLowerCase()]: 'WBTC',
  };
  return symbolMap[address.toLowerCase()] || address.slice(0, 8);
}

/**
 * Log swap route for debugging
 */
export function logSwapRoute(params: SmartSwapParams, result: SmartSwapResult): void {
  const tokenInSym = getTokenSymbol(params.tokenIn);
  const tokenOutSym = getTokenSymbol(params.tokenOut);
  
  console.log(`[SmartRouter] Swap: ${tokenInSym} -> ${tokenOutSym}`);
  console.log(`[SmartRouter] Router: ${result.router}`);
  console.log(`[SmartRouter] Amount In: ${params.amountIn.toString()}`);
  console.log(`[SmartRouter] Min Out: ${params.minAmountOut.toString()}`);
  
  if (result.router === 'uniswap' && result.path) {
    console.log(`[SmartRouter] Uniswap Path: ${result.path.map(getTokenSymbol).join(' -> ')}`);
  }
  
  if (result.router === 'kuru' && result.markets) {
    console.log(`[SmartRouter] Kuru Markets: ${result.markets.join(', ')}`);
  }
}
