"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const generated_1 = require("generated");
function pairKeyFor(tokenIn, tokenOut) {
    const a = tokenIn.toLowerCase();
    const b = tokenOut.toLowerCase();
    return [a, b].sort().join("_");
}
// Octoswap Factory: capture PairCreated and store pair metadata
generated_1.OctoswapFactory?.PairCreated?.handler?.(async ({ event, context }) => {
    try {
        const token0 = String(event.params.token0);
        const token1 = String(event.params.token1);
        const pair = String(event.params.pair);
        const id = pair.toLowerCase();
        const ent = {
            id,
            pairAddress: pair,
            token0,
            token1,
            blockNumber: event.block.number,
            blockTimestamp: event.block.timestamp,
            transactionHash: event.transaction.hash,
        };
        context.UniswapV2PairInfo.set(ent);
    }
    catch { }
});
// Octoswap Pair: capture Swap and emit unified SwapEvent
generated_1.OctoswapPair?.Swap?.handler?.(async ({ event, context }) => {
    try {
        const pairAddr = String(event.srcAddress).toLowerCase();
        const pair = await context.UniswapV2PairInfo.get(pairAddr);
        if (!pair)
            return; // Need token0/token1 mapping
        const token0 = String(pair.token0);
        const token1 = String(pair.token1);
        const a0in = BigInt(event.params.amount0In);
        const a1in = BigInt(event.params.amount1In);
        const a0out = BigInt(event.params.amount0Out);
        const a1out = BigInt(event.params.amount1Out);
        let tokenIn, tokenOut, amountIn, amountOut;
        if (a0in > 0n) {
            tokenIn = token0;
            tokenOut = token1;
            amountIn = a0in;
            amountOut = a1out;
        }
        else {
            tokenIn = token1;
            tokenOut = token0;
            amountIn = a1in;
            amountOut = a0out;
        }
        const id = `${event.chainId}_${event.block.number}_${event.logIndex}_octo`;
        context.SwapEvent.set({
            id,
            pairKey: pairKeyFor(tokenIn, tokenOut),
            tokenIn,
            tokenOut,
            amountIn: amountIn,
            amountOut: amountOut,
            price: 0,
            recipient: String(event.params.to || event.transaction?.from || "0x0000000000000000000000000000000000000000"),
            blockNumber: event.block.number,
            blockTimestamp: event.block.timestamp,
            transactionHash: event.transaction.hash,
            logIndex: event.logIndex,
        });
    }
    catch { }
});
