// @ts-nocheck
import { OctoswapFactory, OctoswapPair, UniswapV2Factory, UniswapV2Pair, UniswapV2PairInfo, SwapEvent } from "generated";

function pairKeyFor(tokenIn: string, tokenOut: string): string {
  const a = tokenIn.toLowerCase();
  const b = tokenOut.toLowerCase();
  return [a, b].sort().join("_");
}

// Hardcoded fallback for hot pairs when Factory.PairCreated pre-dates start_block
const STATIC_PAIR_TOKENS: Record<string, { token0: string; token1: string }> = (() => {
  const WMON = "0x760afe86e5de5fa0ee542fc7b7b713e1c5425701";
  const CHOG = "0xe0590015a873bf326bd645c3e1266d4db41c4e6b";
  const DAK = "0x0f0bdebf0f83cd1ee3974779bcb7315f9808c714";
  const YAKI = "0xfe140e1dce99be9f4f15d657cd9b7bf622270c50";
  const PINGU = "0xa2426cd97583939e79cfc12ac6e9121e37d0904d";
  const USDC = "0xf817257fed379853cde0fa4f97ab987181b1e5ea";
  const WSOL = "0x5387c85a4965769f6b0df430638a1388493486f1";
  const a = [WMON, CHOG].sort();
  return {
    // WMON/CHOG on Octoswap (Bean)
    "0x1076ad67c1f8eceaeaabbdf28577fe5b7ccd5e03": { token0: a[0], token1: a[1] },
    // DAK/WMON
    "0x9e9b7f93b0375b2d53d68bd65ceeb716f10ada21": { token0: [DAK, WMON].sort()[0], token1: [DAK, WMON].sort()[1] },
    // YAKI/WMON
    "0xb8c074805ab9c39281289089f20ec2629449f03a": { token0: [YAKI, WMON].sort()[0], token1: [YAKI, WMON].sort()[1] },
    // WSOL/USDC
    "0xe8736384c92e077dc8536d0d2b974baebb52c360": { token0: [WSOL, USDC].sort()[0], token1: [WSOL, USDC].sort()[1] },
    // PINGU/WMON
    "0x3611a3e98fc6546d8fb3235c8a2ae7072915bf28": { token0: [PINGU, WMON].sort()[0], token1: [PINGU, WMON].sort()[1] },
  };
})();

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
    let token0: string, token1: string;
    const pair = await context.UniswapV2PairInfo.get(pairAddr);
    if (pair) {
      token0 = String((pair as any).token0).toLowerCase();
      token1 = String((pair as any).token1).toLowerCase();
    } else if (STATIC_PAIR_TOKENS[pairAddr]) {
      token0 = STATIC_PAIR_TOKENS[pairAddr].token0;
      token1 = STATIC_PAIR_TOKENS[pairAddr].token1;
    } else {
      return; // Need token0/token1 mapping
    }
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

// Canonical UniswapV2 Factory: also capture PairCreated and store pair metadata
UniswapV2Factory?.PairCreated?.handler?.(async ({ event, context }) => {
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

// Canonical UniswapV2 Pair: capture Swap and emit unified SwapEvent
UniswapV2Pair?.Swap?.handler?.(async ({ event, context }) => {
  try {
    const pairAddr = String(event.srcAddress).toLowerCase();
    let token0: string, token1: string;
    const pair = await context.UniswapV2PairInfo.get(pairAddr);
    if (pair) {
      token0 = String((pair as any).token0).toLowerCase();
      token1 = String((pair as any).token1).toLowerCase();
    } else if (STATIC_PAIR_TOKENS[pairAddr]) {
      token0 = STATIC_PAIR_TOKENS[pairAddr].token0;
      token1 = STATIC_PAIR_TOKENS[pairAddr].token1;
    } else {
      return; // Need token0/token1 mapping
    }
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
    const id = `${event.chainId}_${event.block.number}_${event.logIndex}_uni`;
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
