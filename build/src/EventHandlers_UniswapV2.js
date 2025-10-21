"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const generated_1 = require("generated");
function pairKeyFor(tokenIn, tokenOut) {
    const a = tokenIn.toLowerCase();
    const b = tokenOut.toLowerCase();
    return [a, b].sort().join("_");
}
// Hardcoded fallback for hot pairs when Factory.PairCreated pre-dates start_block
const STATIC_PAIR_TOKENS = (() => {
    const WMON = "0x760afe86e5de5fa0ee542fc7b7b713e1c5425701";
    const CHOG = "0xe0590015a873bf326bd645c3e1266d4db41c4e6b";
    const DAK = "0x0f0bdebf0f83cd1ee3974779bcb7315f9808c714";
    const YAKI = "0xfe140e1dce99be9f4f15d657cd9b7bf622270c50";
    const PINGU = "0xa2426cd97583939e79cfc12ac6e9121e37d0904d";
    const USDC = "0xf817257fed379853cde0fa4f97ab987181b1e5ea";
    const WSOL = "0x5387c85a4965769f6b0df430638a1388493486f1";
    const WBTC = "0xcf5a6076cfa32686c0df13abada2b40dec133f1d";
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
        // WMON/USDC
        "0x159e8445313aad3eb0a9a373bfa313db5d4131c5": { token0: [WMON, USDC].sort()[0], token1: [WMON, USDC].sort()[1] },
        // CHOG/WMON alt
        "0x4d2e4c5ff07d1c82d512335dea0a1aa82c031a86": { token0: [CHOG, WMON].sort()[0], token1: [CHOG, WMON].sort()[1] },
        // DAK/WMON alt
        "0x6007a0804fe538745ffed91f9c124cd3ce06102d": { token0: [DAK, WMON].sort()[0], token1: [DAK, WMON].sort()[1] },
        // YAKI/WMON alt
        "0x6def0cf33d16f067c95f9df8918b876dd360561c": { token0: [YAKI, WMON].sort()[0], token1: [YAKI, WMON].sort()[1] },
        // WBTC/USDC
        "0x1df72acff7fd1fdc392ad44dd2167f6baaf6c559": { token0: [WBTC, USDC].sort()[0], token1: [WBTC, USDC].sort()[1] },
    };
})();
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
        let token0, token1;
        const pair = await context.UniswapV2PairInfo.get(pairAddr);
        if (pair) {
            token0 = String(pair.token0).toLowerCase();
            token1 = String(pair.token1).toLowerCase();
        }
        else if (STATIC_PAIR_TOKENS[pairAddr]) {
            token0 = STATIC_PAIR_TOKENS[pairAddr].token0;
            token1 = STATIC_PAIR_TOKENS[pairAddr].token1;
        }
        else {
            return; // Need token0/token1 mapping
        }
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
// Canonical UniswapV2 Factory: also capture PairCreated and store pair metadata
generated_1.UniswapV2Factory?.PairCreated?.handler?.(async ({ event, context }) => {
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
// Canonical UniswapV2 Pair: capture Swap and emit unified SwapEvent
generated_1.UniswapV2Pair?.Swap?.handler?.(async ({ event, context }) => {
    try {
        const pairAddr = String(event.srcAddress).toLowerCase();
        let token0, token1;
        const pair = await context.UniswapV2PairInfo.get(pairAddr);
        if (pair) {
            token0 = String(pair.token0).toLowerCase();
            token1 = String(pair.token1).toLowerCase();
        }
        else if (STATIC_PAIR_TOKENS[pairAddr]) {
            token0 = STATIC_PAIR_TOKENS[pairAddr].token0;
            token1 = STATIC_PAIR_TOKENS[pairAddr].token1;
        }
        else {
            return; // Need token0/token1 mapping
        }
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
        const id = `${event.chainId}_${event.block.number}_${event.logIndex}_uni`;
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
