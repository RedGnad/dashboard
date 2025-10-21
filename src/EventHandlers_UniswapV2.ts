// @ts-nocheck
import { OctoswapFactory, OctoswapPair, UniswapV2PairInfo, SwapEvent } from "generated";

function pairKeyFor(tokenIn: string, tokenOut: string): string {
  const a = tokenIn.toLowerCase();
  const b = tokenOut.toLowerCase();
  return [a, b].sort().join("_");
}

// Octoswap Factory: capture PairCreated and store pair metadata
OctoswapFactory?.PairCreated?.handler?.(async ({ event, context }) => {
  try {
    const token0 = String(event.params.token0);
    const token1 = String(event.params.token1);
    const pair = String(event.params.pair);
    const id = pair.toLowerCase();
    const ent: UniswapV2PairInfo = {
      id,
      pairAddress: pair,
      token0,
      token1,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
    } as any;
    context.UniswapV2PairInfo.set(ent);
  } catch {}
});

// Octoswap Pair: capture Swap and emit unified SwapEvent
OctoswapPair?.Swap?.handler?.(async ({ event, context }) => {
  try {
    const pairAddr = String(event.srcAddress).toLowerCase();
    const pair = await context.UniswapV2PairInfo.get(pairAddr);
    if (!pair) return; // Need token0/token1 mapping
    const token0 = String((pair as any).token0);
    const token1 = String((pair as any).token1);
    const a0in = BigInt(event.params.amount0In as any);
    const a1in = BigInt(event.params.amount1In as any);
    const a0out = BigInt(event.params.amount0Out as any);
    const a1out = BigInt(event.params.amount1Out as any);
    let tokenIn: string, tokenOut: string, amountIn: bigint, amountOut: bigint;
    if (a0in > 0n) {
      tokenIn = token0; tokenOut = token1; amountIn = a0in; amountOut = a1out;
    } else {
      tokenIn = token1; tokenOut = token0; amountIn = a1in; amountOut = a0out;
    }
    const id = `${event.chainId}_${event.block.number}_${event.logIndex}_octo`;
    context.SwapEvent.set({
      id,
      pairKey: pairKeyFor(tokenIn, tokenOut),
      tokenIn,
      tokenOut,
      amountIn: amountIn as any,
      amountOut: amountOut as any,
      price: 0 as any,
      recipient: String(event.params.to || event.transaction?.from || "0x0000000000000000000000000000000000000000"),
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
      logIndex: event.logIndex,
    } as any);
  } catch {}
});
