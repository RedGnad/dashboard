"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
/*
 * Curvance handler: met à jour DailyMetrics (protocolId = "curvance") sur l'event Pump.
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
generated_1.Curvance.Locked.handler(async ({ event, context }) => {
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
    const userKey = event.params?.user ?? event.transaction?.from ?? null;
    await upsertDaily(context, { protocolId: "curvance", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
});
generated_1.Curvance.Approval.handler(async ({ event, context }) => {
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
    const owner = event.params?.owner ?? null;
    const userKey = owner ?? event.transaction?.from ?? null;
    await upsertDaily(context, { protocolId: "curvance", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
});
generated_1.Curvance.Transfer.handler(async ({ event, context }) => {
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
    const from = event.params?.from ?? null;
    const userKey = from ?? event.transaction?.from ?? null;
    await upsertDaily(context, { protocolId: "curvance", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
});
generated_1.Curvance.Unlocked.handler(async ({ event, context }) => {
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
    const userKey = event.params?.user ?? event.transaction?.from ?? null;
    await upsertDaily(context, { protocolId: "curvance", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
});
generated_1.Curvance.UnlockedWithPenalty.handler(async ({ event, context }) => {
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
    const userKey = event.params?.user ?? event.transaction?.from ?? null;
    await upsertDaily(context, { protocolId: "curvance", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
});
