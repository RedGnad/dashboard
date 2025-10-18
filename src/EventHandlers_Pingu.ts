// @ts-nocheck
import { PinguOrders, PinguProcessor, PinguStaking, DailyMetrics, DailyUser, ProtocolState, DailyTxFeeCounted } from "generated";

function dateISOFromTs(tsMs: number): string {
  const d = new Date(tsMs);
  return d.toISOString().slice(0, 10);
}

async function upsertDaily(
  context: any,
  args: { protocolId: string; dateISO: string; user?: string | null; txDelta?: number; txHash?: string | null; feeWei?: bigint | null }
) {
  const { protocolId, dateISO, user, txDelta = 1, txHash, feeWei } = args;
  const dailyId = `${protocolId}_${dateISO}`;
  const stateId = protocolId;

  let userAdded = 0;
  if (user) {
    const duId = `${protocolId}_${dateISO}_${user.toLowerCase()}`;
    const existingDU = await context.DailyUser.get(duId);
    if (!existingDU) {
      const du: DailyUser = { id: duId, protocolId, dateISO, user: user.toLowerCase() } as any;
      context.DailyUser.set(du);
      userAdded = 1;
    }
  }

  const stPrev = (await context.ProtocolState.get(stateId)) as ProtocolState | null;
  const txCumPrev = stPrev ? BigInt((stPrev as any).txCumulative) : 0n;
  const txCumNext = txCumPrev + BigInt(txDelta);
  const stNext: ProtocolState = { id: stateId, protocolId, txCumulative: txCumNext.toString() as any } as any;
  context.ProtocolState.set(stNext);

  const dmPrev = (await context.DailyMetrics.get(dailyId)) as DailyMetrics | null;
  const usersDailyPrev = dmPrev ? Number((dmPrev as any).usersDaily) : 0;
  const txDailyPrev = dmPrev ? Number((dmPrev as any).txDaily) : 0;
  const sumFeeWeiPrev = dmPrev && (dmPrev as any).sumFeeWei ? BigInt((dmPrev as any).sumFeeWei) : 0n;
  const feeTxCountPrev = dmPrev && (dmPrev as any).feeTxCount ? Number((dmPrev as any).feeTxCount) : 0;
  const usersDaily = usersDailyPrev + userAdded;
  const txDaily = txDailyPrev + txDelta;
  let sumFeeWeiNext = sumFeeWeiPrev;
  let feeTxCountNext = feeTxCountPrev;
  if (txHash && feeWei != null) {
    const feeId = `${protocolId}_${dateISO}_${txHash.toLowerCase()}`;
    const already = await context.DailyTxFeeCounted.get(feeId);
    if (!already) {
      const feeRec: DailyTxFeeCounted = { id: feeId, protocolId, dateISO, txHash: txHash.toLowerCase(), feeWei: feeWei.toString() as any } as any;
      context.DailyTxFeeCounted.set(feeRec);
      sumFeeWeiNext = sumFeeWeiNext + feeWei;
      feeTxCountNext = feeTxCountNext + 1;
    }
  }
  const avgTxPerUser = usersDaily > 0 ? txDaily / Math.max(1, usersDaily) : 0;
  let avgFeeNative: number | null = null;
  if (feeTxCountNext > 0) {
    try { avgFeeNative = Number(sumFeeWeiNext / BigInt(feeTxCountNext)) / 1e18 } catch { avgFeeNative = Number(sumFeeWeiNext) / feeTxCountNext / 1e18 }
  }
  const dmNext: DailyMetrics = {
    id: dailyId,
    protocolId,
    dateISO,
    usersDaily,
    txDaily,
    txCumulative: txCumNext.toString() as any,
    avgTxPerUser,
    avgFeeNative: (avgFeeNative as any) ?? null,
    sumFeeWei: sumFeeWeiNext.toString() as any,
    feeTxCount: feeTxCountNext as any,
  } as any;
  context.DailyMetrics.set(dmNext);
}

function feeFromTx(tx: any): bigint | null {
  const gasUsed = tx?.gasUsed != null ? BigInt(tx.gasUsed) : null;
  const eff = tx?.effectiveGasPrice != null ? BigInt(tx.effectiveGasPrice) : (tx?.gasPrice != null ? BigInt(tx.gasPrice) : null);
  return gasUsed != null && eff != null ? gasUsed * eff : null;
}

PinguOrders.OrderCreated.handler(async ({ event, context }) => {
  const tsMs = Number(event.block.timestamp) * 1000;
  const dateISO = dateISOFromTs(tsMs);
  const txHash = (event.transaction?.hash as string) || null;
  const feeWei = feeFromTx(event.transaction as any);
  const userKey = (event.params.user as string) || (event.transaction?.from as string) || null;
  await upsertDaily(context, { protocolId: "pingu", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
});

PinguOrders.OrderCancelled.handler(async ({ event, context }) => {
  const tsMs = Number(event.block.timestamp) * 1000;
  const dateISO = dateISOFromTs(tsMs);
  const txHash = (event.transaction?.hash as string) || null;
  const feeWei = feeFromTx(event.transaction as any);
  const userKey = (event.params.user as string) || (event.transaction?.from as string) || null;
  await upsertDaily(context, { protocolId: "pingu", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
});

PinguProcessor.PositionLiquidated.handler(async ({ event, context }) => {
  const tsMs = Number(event.block.timestamp) * 1000;
  const dateISO = dateISOFromTs(tsMs);
  const txHash = (event.transaction?.hash as string) || null;
  const feeWei = feeFromTx(event.transaction as any);
  const userKey = (event.params.user as string) || (event.transaction?.from as string) || null;
  await upsertDaily(context, { protocolId: "pingu", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
});

PinguProcessor.PositionADL.handler(async ({ event, context }) => {
  const tsMs = Number(event.block.timestamp) * 1000;
  const dateISO = dateISOFromTs(tsMs);
  const txHash = (event.transaction?.hash as string) || null;
  const feeWei = feeFromTx(event.transaction as any);
  const userKey = (event.params.user as string) || (event.transaction?.from as string) || null;
  await upsertDaily(context, { protocolId: "pingu", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
});

PinguStaking.CAPStaked.handler(async ({ event, context }) => {
  const tsMs = Number(event.block.timestamp) * 1000;
  const dateISO = dateISOFromTs(tsMs);
  const txHash = (event.transaction?.hash as string) || null;
  const feeWei = feeFromTx(event.transaction as any);
  const userKey = (event.params.user as string) || (event.transaction?.from as string) || null;
  await upsertDaily(context, { protocolId: "pingu", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
});

PinguStaking.CAPUnstaked.handler(async ({ event, context }) => {
  const tsMs = Number(event.block.timestamp) * 1000;
  const dateISO = dateISOFromTs(tsMs);
  const txHash = (event.transaction?.hash as string) || null;
  const feeWei = feeFromTx(event.transaction as any);
  const userKey = (event.params.user as string) || (event.transaction?.from as string) || null;
  await upsertDaily(context, { protocolId: "pingu", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
});

PinguStaking.CollectedReward.handler(async ({ event, context }) => {
  const tsMs = Number(event.block.timestamp) * 1000;
  const dateISO = dateISOFromTs(tsMs);
  const txHash = (event.transaction?.hash as string) || null;
  const feeWei = feeFromTx(event.transaction as any);
  const userKey = (event.transaction?.from as string) || null;
  await upsertDaily(context, { protocolId: "pingu", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
});
