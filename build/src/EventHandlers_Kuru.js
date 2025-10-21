"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const generated_1 = require("generated");
function dateISOFromTs(tsMs) {
    const d = new Date(tsMs);
    return d.toISOString().slice(0, 10);
}
function pairKeyFor(tokenIn, tokenOut) {
    const a = tokenIn.toLowerCase();
    const b = tokenOut.toLowerCase();
    return [a, b].sort().join("_");
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
// Store MarketRegistered events without dynamic registration (stability first)
generated_1.KuruRouter.MarketRegistered.handler(({ event, context }) => {
    try {
        const marketId = String(event.params.market || event.params?.market).toLowerCase();
        const entity = {
            id: marketId,
            market: event.params.market,
            baseAsset: event.params.baseAsset,
            quoteAsset: event.params.quoteAsset,
            vaultAddress: event.params.vaultAddress,
            pricePrecision: Number(event.params.pricePrecision),
            sizePrecision: event.params.sizePrecision.toString?.() ?? String(event.params.sizePrecision),
            tickSize: Number(event.params.tickSize),
            minSize: event.params.minSize.toString?.() ?? String(event.params.minSize),
            maxSize: event.params.maxSize.toString?.() ?? String(event.params.maxSize),
            takerFeeBps: event.params.takerFeeBps.toString?.() ?? String(event.params.takerFeeBps),
            makerFeeBps: event.params.makerFeeBps.toString?.() ?? String(event.params.makerFeeBps),
            blockNumber: event.block.number,
            blockTimestamp: event.block.timestamp,
            transactionHash: event.transaction.hash,
        };
        context.Kuru_MarketRegistered.set(entity);
    }
    catch { }
});
// Store trades and update daily metrics
generated_1.KuruOrderBook.Trade.handler(async ({ event, context }) => {
    try {
        const entity = {
            id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
            market: event.srcAddress,
            orderId: event.params.orderId.toString?.() ?? String(event.params.orderId),
            makerAddress: event.params.makerAddress,
            takerAddress: event.params.takerAddress,
            txOrigin: event.params.txOrigin,
            isBuy: Boolean(event.params.isBuy),
            price: event.params.price.toString?.() ?? String(event.params.price),
            updatedSize: event.params.updatedSize.toString?.() ?? String(event.params.updatedSize),
            filledSize: event.params.filledSize.toString?.() ?? String(event.params.filledSize),
            blockNumber: event.block.number,
            blockTimestamp: event.block.timestamp,
            transactionHash: event.transaction.hash,
            gasUsed: event.transaction?.gasUsed ?? 0n,
            gasPrice: event.transaction?.effectiveGasPrice ?? event.transaction?.gasPrice ?? 0n,
        };
        context.Kuru_Trade.set(entity);
        try {
            const marketId = String(event.srcAddress || '').toLowerCase();
            const reg = await context.Kuru_MarketRegistered.get(marketId);
            if (reg) {
                const base = String(reg.baseAsset);
                const quote = String(reg.quoteAsset);
                const priceRaw = BigInt(event.params.price);
                const filledRaw = BigInt(event.params.filledSize);
                const pp = reg.pricePrecision != null ? BigInt(String(reg.pricePrecision)) : 1n;
                const scale = pp === 0n ? 1n : pp;
                const quoteAmount = (filledRaw * priceRaw) / scale;
                const isBuy = Boolean(event.params.isBuy);
                const tokenIn = isBuy ? quote : base;
                const tokenOut = isBuy ? base : quote;
                const amountIn = isBuy ? quoteAmount : filledRaw;
                const amountOut = isBuy ? filledRaw : quoteAmount;
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
                    price = 0;
                }
                const swapId = `${event.chainId}_${event.block.number}_${event.logIndex}_kuru`;
                const nowSec = Math.floor(Date.now() / 1000);
                const cutoffSec = nowSec - 30 * 86400;
                const derivedFull = (typeof process !== 'undefined' && process?.env?.ENVIO_DERIVED_FULL === 'true');
                const isRecent = derivedFull || (Number(event.block.timestamp) >= cutoffSec);
                if (isRecent) {
                    context.SwapEvent.set({
                        id: swapId,
                        pairKey: pairKeyFor(tokenIn, tokenOut),
                        tokenIn,
                        tokenOut,
                        amountIn,
                        amountOut,
                        price,
                        recipient: String(event.params.takerAddress || ''),
                        blockNumber: event.block.number,
                        blockTimestamp: event.block.timestamp,
                        transactionHash: event.transaction.hash,
                        logIndex: event.logIndex,
                    });
                }
            }
            else {
                try {
                    context.log?.info?.(`Kuru Trade without market registration mapping for ${marketId}`);
                }
                catch { }
            }
        }
        catch { }
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
        await upsertDaily(context, { protocolId: "kuru", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
    }
    catch { }
});
// Optional: PumpingTime event observed (no dynamic registration for stability)
generated_1.MonadDeployer?.PumpingTime?.handler?.(({ event, context }) => {
    try {
        context.log.info?.(`PumpingTime observed for token ${event.params?.token ?? ''}`);
    }
    catch { }
});
