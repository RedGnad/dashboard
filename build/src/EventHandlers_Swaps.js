"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const generated_1 = require("../generated");
function pairKeyFor(tokenIn, tokenOut) {
    const a = tokenIn.toLowerCase();
    const b = tokenOut.toLowerCase();
    return [a, b].sort().join("_");
}
// Helper functions for DailyMetrics aggregation (same as other handlers)
function dateISOFromTs(tsMs) {
    const d = new Date(tsMs);
    return d.toISOString().slice(0, 10);
}
async function upsertDaily(context, args) {
    const { protocolId, dateISO, user, txDelta = 1, txHash, feeWei } = args;
    const dailyId = `${protocolId}_${dateISO}`;
    const stateId = protocolId;
    let userAdded = 0;
    if (user) {
        const duId = `${protocolId}_${dateISO}_${user.toLowerCase()}`;
        const existingDU = await context.DailyUser.get(duId);
        if (!existingDU) {
            const du = { id: duId, protocolId, dateISO, user: user.toLowerCase() };
            context.DailyUser.set(du);
            userAdded = 1;
        }
    }
    const stPrev = (await context.ProtocolState.get(stateId));
    const txCumPrev = stPrev ? BigInt(stPrev.txCumulative) : 0n;
    const txCumNext = txCumPrev + BigInt(txDelta);
    const stNext = { id: stateId, protocolId, txCumulative: txCumNext.toString() };
    context.ProtocolState.set(stNext);
    const dmPrev = (await context.DailyMetrics.get(dailyId));
    const usersDailyPrev = dmPrev ? Number(dmPrev.usersDaily) : 0;
    const txDailyPrev = dmPrev ? Number(dmPrev.txDaily) : 0;
    const sumFeeWeiPrev = dmPrev && dmPrev.sumFeeWei ? BigInt(dmPrev.sumFeeWei) : 0n;
    const feeTxCountPrev = dmPrev && dmPrev.feeTxCount ? Number(dmPrev.feeTxCount) : 0;
    const usersDaily = usersDailyPrev + userAdded;
    const txDaily = txDailyPrev + txDelta;
    let sumFeeWeiNext = sumFeeWeiPrev;
    let feeTxCountNext = feeTxCountPrev;
    if (txHash && feeWei != null) {
        const feeId = `${protocolId}_${dateISO}_${txHash.toLowerCase()}`;
        const already = await context.DailyTxFeeCounted.get(feeId);
        if (!already) {
            const feeRec = { id: feeId, protocolId, dateISO, txHash: txHash.toLowerCase(), feeWei: feeWei.toString() };
            context.DailyTxFeeCounted.set(feeRec);
            sumFeeWeiNext = sumFeeWeiNext + feeWei;
            feeTxCountNext = feeTxCountNext + 1;
        }
    }
    const avgTxPerUser = usersDaily > 0 ? txDaily / Math.max(1, usersDaily) : 0;
    let avgFeeNative = null;
    if (feeTxCountNext > 0) {
        try {
            avgFeeNative = Number(sumFeeWeiNext / BigInt(feeTxCountNext)) / 1e18;
        }
        catch {
            avgFeeNative = Number(sumFeeWeiNext) / feeTxCountNext / 1e18;
        }
    }
    const dmNext = {
        id: dailyId,
        protocolId,
        dateISO,
        usersDaily,
        txDaily,
        txCumulative: txCumNext.toString(),
        avgTxPerUser,
        avgFeeNative: avgFeeNative ?? null,
        sumFeeWei: sumFeeWeiNext.toString(),
        feeTxCount: feeTxCountNext,
    };
    context.DailyMetrics.set(dmNext);
}
/**
 * Universal Router swap handler
 * Tracks swaps for calculating price movement, momentum, and volatility metrics
 */
generated_1.UniversalRouter.SwapExecuted.handler(async ({ event, context }) => {
    try {
        const { tokenIn, tokenOut, amountIn, amountOut, recipient } = event.params;
        const pairKey = pairKeyFor(tokenIn, tokenOut);
        const swapId = `${event.chainId}_${event.block.number}_${event.logIndex}`;
        let price = 0;
        try {
            const ain = amountIn;
            const aout = amountOut;
            if (typeof ain === 'bigint' && ain !== 0n) {
                price = Number(aout) / Number(ain);
            }
            else {
                const ainNum = Number(amountIn);
                const aoutNum = Number(amountOut);
                price = ainNum > 0 ? (aoutNum / ainNum) : 0;
            }
            if (!Number.isFinite(price) || Number.isNaN(price))
                price = 0;
        }
        catch {
            const ainNum = Number(amountIn);
            const aoutNum = Number(amountOut);
            price = ainNum > 0 ? (aoutNum / ainNum) : 0;
            if (!Number.isFinite(price) || Number.isNaN(price))
                price = 0;
        }
        context.SwapEvent.set({
            id: swapId,
            pairKey,
            tokenIn,
            tokenOut,
            amountIn,
            amountOut,
            price,
            recipient,
            blockNumber: event.block.number,
            blockTimestamp: event.block.timestamp,
            transactionHash: event.transaction.hash,
            logIndex: event.logIndex,
        });
        const tsMs = Number(event.block.timestamp) * 1000;
        const dateISO = dateISOFromTs(tsMs);
        const txHash = event.transaction?.hash || null;
        const gasUsed = event.transaction?.gasUsed ? BigInt(event.transaction.gasUsed) : null;
        const effPrice = event.transaction?.effectiveGasPrice
            ? BigInt(event.transaction.effectiveGasPrice)
            : event.transaction?.gasPrice
                ? BigInt(event.transaction.gasPrice)
                : null;
        const feeWei = gasUsed != null && effPrice != null ? gasUsed * effPrice : null;
        const userKey = event.transaction?.from || null;
        await upsertDaily(context, { protocolId: "dex", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
        try {
            context.log.info(`Swap processed for AI metrics`, {
                pair: pairKey,
                price: Number.isFinite(price) ? price.toFixed(6) : '0.000000',
                volume: amountIn.toString(),
                block: String(event.block.number),
            });
        }
        catch { }
    }
    catch (err) {
        try {
            context.log.error?.('UR swap handler error', {
                err: String(err?.message || err),
                block: String(event.block?.number ?? ''),
                tx: String(event.transaction?.hash ?? ''),
            });
        }
        catch { }
    }
});
