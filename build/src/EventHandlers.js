"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-nocheck
/*
 * Please refer to https://docs.envio.dev for a thorough guide on all Envio indexer features
 */
const generated_1 = require("generated");
// Helpers d'agrégation pour DailyMetrics compatible avec l'adaptateur backend
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
generated_1.StakeManager.Initialized.handler(async ({ event, context }) => {
    const entity = {
        id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
        version: event.params.version.toString?.() ?? String(event.params.version),
    };
    context.StakeManager_Initialized.set(entity);
});
generated_1.StakeManager.Deposit.handler(async ({ event, context }) => {
    const entity = {
        id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
        depositor: event.params.depositor,
        amount: event.params.amount.toString?.() ?? String(event.params.amount),
        gMonMinted: event.params.gMonMinted.toString?.() ?? String(event.params.gMonMinted),
        referralId: event.params.referralId.toString?.() ?? String(event.params.referralId),
    };
    context.StakeManager_Deposit.set(entity);
    // Aggregation for magma
    const tsMs = Number(event.block.timestamp) * 1000;
    const dateISO = dateISOFromTs(tsMs);
    const txHash = event.transaction?.hash || null;
    // Prefer effectiveGasPrice; fallback to gasPrice for legacy txs
    const gasUsed = event.transaction?.gasUsed ? BigInt(event.transaction.gasUsed) : null;
    const effPrice = event.transaction?.effectiveGasPrice
        ? BigInt(event.transaction.effectiveGasPrice)
        : event.transaction?.gasPrice
            ? BigInt(event.transaction.gasPrice)
            : null;
    const feeWei = gasUsed != null && effPrice != null ? gasUsed * effPrice : null;
    await upsertDaily(context, { protocolId: "magma", dateISO, user: event.params.depositor, txDelta: 1, txHash, feeWei });
});
generated_1.StakeManager.Withdraw.handler(async ({ event, context }) => {
    const entity = {
        id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
        withdrawer: event.params.withdrawer,
        amount: event.params.amount.toString?.() ?? String(event.params.amount),
        gMonBurned: event.params.gMonBurned.toString?.() ?? String(event.params.gMonBurned),
    };
    context.StakeManager_Withdraw.set(entity);
    // Aggregation for magma
    const tsMs = Number(event.block.timestamp) * 1000;
    const dateISO = dateISOFromTs(tsMs);
    const txHash2 = event.transaction?.hash || null;
    const gasUsed2 = event.transaction?.gasUsed ? BigInt(event.transaction.gasUsed) : null;
    const effPrice2 = event.transaction?.effectiveGasPrice
        ? BigInt(event.transaction.effectiveGasPrice)
        : event.transaction?.gasPrice
            ? BigInt(event.transaction.gasPrice)
            : null;
    const feeWei2 = gasUsed2 != null && effPrice2 != null ? gasUsed2 * effPrice2 : null;
    await upsertDaily(context, { protocolId: "magma", dateISO, user: event.params.withdrawer, txDelta: 1, txHash: txHash2, feeWei: feeWei2 });
});
