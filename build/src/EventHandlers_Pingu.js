"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
const generated_1 = require("generated");
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
function feeFromTx(tx) {
    const gasUsed = tx?.gasUsed != null ? BigInt(tx.gasUsed) : null;
    const eff = tx?.effectiveGasPrice != null ? BigInt(tx.effectiveGasPrice) : (tx?.gasPrice != null ? BigInt(tx.gasPrice) : null);
    return gasUsed != null && eff != null ? gasUsed * eff : null;
}
generated_1.PinguOrders.OrderCreated.handler(async ({ event, context }) => {
    const tsMs = Number(event.block.timestamp) * 1000;
    const dateISO = dateISOFromTs(tsMs);
    const txHash = event.transaction?.hash || null;
    const feeWei = feeFromTx(event.transaction);
    const userKey = event.params.user || event.transaction?.from || null;
    await upsertDaily(context, { protocolId: "pingu", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
});
generated_1.PinguOrders.OrderCancelled.handler(async ({ event, context }) => {
    const tsMs = Number(event.block.timestamp) * 1000;
    const dateISO = dateISOFromTs(tsMs);
    const txHash = event.transaction?.hash || null;
    const feeWei = feeFromTx(event.transaction);
    const userKey = event.params.user || event.transaction?.from || null;
    await upsertDaily(context, { protocolId: "pingu", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
});
generated_1.PinguProcessor.PositionLiquidated.handler(async ({ event, context }) => {
    const tsMs = Number(event.block.timestamp) * 1000;
    const dateISO = dateISOFromTs(tsMs);
    const txHash = event.transaction?.hash || null;
    const feeWei = feeFromTx(event.transaction);
    const userKey = event.params.user || event.transaction?.from || null;
    await upsertDaily(context, { protocolId: "pingu", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
});
generated_1.PinguProcessor.PositionADL.handler(async ({ event, context }) => {
    const tsMs = Number(event.block.timestamp) * 1000;
    const dateISO = dateISOFromTs(tsMs);
    const txHash = event.transaction?.hash || null;
    const feeWei = feeFromTx(event.transaction);
    const userKey = event.params.user || event.transaction?.from || null;
    await upsertDaily(context, { protocolId: "pingu", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
});
generated_1.PinguStaking.CAPStaked.handler(async ({ event, context }) => {
    const tsMs = Number(event.block.timestamp) * 1000;
    const dateISO = dateISOFromTs(tsMs);
    const txHash = event.transaction?.hash || null;
    const feeWei = feeFromTx(event.transaction);
    const userKey = event.params.user || event.transaction?.from || null;
    await upsertDaily(context, { protocolId: "pingu", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
});
generated_1.PinguStaking.CAPUnstaked.handler(async ({ event, context }) => {
    const tsMs = Number(event.block.timestamp) * 1000;
    const dateISO = dateISOFromTs(tsMs);
    const txHash = event.transaction?.hash || null;
    const feeWei = feeFromTx(event.transaction);
    const userKey = event.params.user || event.transaction?.from || null;
    await upsertDaily(context, { protocolId: "pingu", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
});
generated_1.PinguStaking.CollectedReward.handler(async ({ event, context }) => {
    const tsMs = Number(event.block.timestamp) * 1000;
    const dateISO = dateISOFromTs(tsMs);
    const txHash = event.transaction?.hash || null;
    const feeWei = feeFromTx(event.transaction);
    const userKey = event.transaction?.from || null;
    await upsertDaily(context, { protocolId: "pingu", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
});
