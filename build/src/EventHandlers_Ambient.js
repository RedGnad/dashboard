"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
/*
 * Ambient handlers: on chaque event, on met à jour DailyMetrics (protocolId = "ambient").
 * On n'écrit pas d'entités d'events bruts car elles ne sont pas déclarées dans le schema.graphql.
 */
const generated_1 = require("generated");
function dateISOFromTs(tsMs) {
    const d = new Date(tsMs);
    return d.toISOString().slice(0, 10);
}
async function upsertDaily(context, args) {
    const { protocolId, dateISO, user, txDelta = 1, txHash, feeWei } = args;
    const dailyId = `${protocolId}_${dateISO}`;
    const stateId = protocolId;
    // Unique user par jour
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
    // Cumul
    const stPrev = (await context.ProtocolState.get(stateId));
    const txCumPrev = stPrev ? BigInt(stPrev.txCumulative) : 0n;
    const txCumNext = txCumPrev + BigInt(txDelta);
    const stNext = { id: stateId, protocolId, txCumulative: txCumNext.toString() };
    context.ProtocolState.set(stNext);
    // Upsert DailyMetrics
    const dmPrev = (await context.DailyMetrics.get(dailyId));
    const usersDailyPrev = dmPrev ? Number(dmPrev.usersDaily) : 0;
    const txDailyPrev = dmPrev ? Number(dmPrev.txDaily) : 0;
    const sumFeeWeiPrev = dmPrev && dmPrev.sumFeeWei ? BigInt(dmPrev.sumFeeWei) : 0n;
    const feeTxCountPrev = dmPrev && dmPrev.feeTxCount ? Number(dmPrev.feeTxCount) : 0;
    const usersDaily = usersDailyPrev + userAdded;
    const txDaily = txDailyPrev + txDelta;
    // Dedup per tx for fee counting
    let sumFeeWeiNext = sumFeeWeiPrev;
    let feeTxCountNext = feeTxCountPrev;
    if (txHash && feeWei != null) {
        const feeId = `${protocolId}_${dateISO}_${txHash.toLowerCase()}`;
        const already = await context.DailyTxFeeCounted.get(feeId);
        if (!already) {
            const feeRec = {
                id: feeId,
                protocolId,
                dateISO,
                txHash: txHash.toLowerCase(),
                feeWei: feeWei.toString(),
            };
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
// Tous les events AmbientCore utilisent la même agrégation simple
generated_1.AmbientCore?.CrocSwap?.handler?.(async ({ event, context }) => {
    const tsMs = Number(event.block.timestamp) * 1000;
    const dateISO = dateISOFromTs(tsMs);
    // Utilise uniquement l'adresse de l'émetteur de la transaction pour compter les utilisateurs
    const from = event.transaction?.from || null;
    const userKey = from || null;
    // Try read fee (effectiveGasPrice * gasUsed) if receipt available in handler context
    const txHash = event.transaction?.hash || null;
    // With field_selection.transaction_fields enabled in config.yaml, use transaction gas fields
    const gasUsed = event.transaction?.gasUsed ? BigInt(event.transaction.gasUsed) : null;
    const effPrice = event.transaction?.effectiveGasPrice
        ? BigInt(event.transaction.effectiveGasPrice)
        : event.transaction?.gasPrice
            ? BigInt(event.transaction.gasPrice)
            : null;
    const feeWei = gasUsed != null && effPrice != null ? gasUsed * effPrice : null;
    await upsertDaily(context, {
        protocolId: "ambient",
        dateISO,
        user: userKey,
        txDelta: 1,
        txHash,
        feeWei,
    });
    // Derive a unified SwapEvent for frontend pricing
    try {
        const base = event.params.base;
        const quote = event.params.quote;
        const isBuy = Boolean(event.params.isBuy);
        const bf = BigInt(event.params.baseFlow ?? 0);
        const qf = BigInt(event.params.quoteFlow ?? 0);
        const baseAbs = bf < 0n ? -bf : bf;
        const quoteAbs = qf < 0n ? -qf : qf;
        const tokenIn = isBuy ? quote : base;
        const tokenOut = isBuy ? base : quote;
        const amountIn = isBuy ? quoteAbs : baseAbs;
        const amountOut = isBuy ? baseAbs : quoteAbs;
        const pairKey = [tokenIn.toLowerCase(), tokenOut.toLowerCase()].sort().join("_");
        const id = `${event.chainId}_${event.block.number}_${event.logIndex}_ambient`;
        context.SwapEvent.set({
            id,
            pairKey,
            tokenIn,
            tokenOut,
            amountIn: amountIn,
            amountOut: amountOut,
            price: 0,
            recipient: event.transaction?.from || "0x0000000000000000000000000000000000000000",
            blockNumber: event.block.number,
            blockTimestamp: event.block.timestamp,
            transactionHash: event.transaction.hash,
            logIndex: event.logIndex,
        });
    }
    catch { }
});
generated_1.AmbientCore?.CrocMicroSwap?.handler?.(async ({ event, context }) => {
    const tsMs = Number(event.block.timestamp) * 1000;
    const dateISO = dateISOFromTs(tsMs);
    const from = event.transaction?.from || null;
    const userKey = from || null;
    const txHash2 = event.transaction?.hash || null;
    const gasUsed2 = event.transaction?.gasUsed ? BigInt(event.transaction.gasUsed) : null;
    const effPrice2 = event.transaction?.effectiveGasPrice
        ? BigInt(event.transaction.effectiveGasPrice)
        : event.transaction?.gasPrice
            ? BigInt(event.transaction.gasPrice)
            : null;
    const feeWei2 = gasUsed2 != null && effPrice2 != null ? gasUsed2 * effPrice2 : null;
    await upsertDaily(context, {
        protocolId: "ambient",
        dateISO,
        user: userKey,
        txDelta: 1,
        txHash: txHash2,
        feeWei: feeWei2,
    });
    // Derive a unified SwapEvent for frontend pricing
    try {
        const input = event.params?.input; // bytes; not decoded here, use flows instead
        const baseFlow = BigInt(event.params?.baseFlow ?? 0);
        const quoteFlow = BigInt(event.params?.quoteFlow ?? 0);
        // We cannot decode base/quote from bytes without parser; fall back if not present
        const base = event?.params?.base;
        const quote = event?.params?.quote;
        if (base && quote) {
            const isBuy = Boolean(event?.params?.isBuy);
            const bf = baseFlow;
            const qf = quoteFlow;
            const baseAbs = bf < 0n ? -bf : bf;
            const quoteAbs = qf < 0n ? -qf : qf;
            const tokenIn = isBuy ? quote : base;
            const tokenOut = isBuy ? base : quote;
            const amountIn = isBuy ? quoteAbs : baseAbs;
            const amountOut = isBuy ? baseAbs : quoteAbs;
            const pairKey = [tokenIn.toLowerCase(), tokenOut.toLowerCase()].sort().join("_");
            const id = `${event.chainId}_${event.block.number}_${event.logIndex}_ambientmicro`;
            context.SwapEvent.set({
                id,
                pairKey,
                tokenIn,
                tokenOut,
                amountIn: amountIn,
                amountOut: amountOut,
                price: 0,
                recipient: event.transaction?.from || "0x0000000000000000000000000000000000000000",
                blockNumber: event.block.number,
                blockTimestamp: event.block.timestamp,
                transactionHash: event.transaction.hash,
                logIndex: event.logIndex,
            });
        }
    }
    catch { }
});
// Note: We only register handlers for the two events declared in config.yaml
