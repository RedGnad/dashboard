// @ts-nocheck
import { KuruRouter, KuruOrderBook, MonadDeployer, Kuru_MarketRegistered, Kuru_Trade, DailyMetrics, DailyUser, ProtocolState, DailyTxFeeCounted } from "generated";

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

// Register dynamically created OrderBook markets
KuruRouter.MarketRegistered.contractRegister(({ event, context }) => {
  context.addKuruOrderBook(event.params.market);

  const entity: Kuru_MarketRegistered = {
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    market: event.params.market,
    baseAsset: event.params.baseAsset,
    quoteAsset: event.params.quoteAsset,
    vaultAddress: event.params.vaultAddress,
    pricePrecision: Number(event.params.pricePrecision) as any,
    sizePrecision: (event.params.sizePrecision as any).toString?.() ?? String(event.params.sizePrecision),
    tickSize: Number(event.params.tickSize) as any,
    minSize: (event.params.minSize as any).toString?.() ?? String(event.params.minSize),
    maxSize: (event.params.maxSize as any).toString?.() ?? String(event.params.maxSize),
    takerFeeBps: (event.params.takerFeeBps as any).toString?.() ?? String(event.params.takerFeeBps),
    makerFeeBps: (event.params.makerFeeBps as any).toString?.() ?? String(event.params.makerFeeBps),
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  };
  context.Kuru_MarketRegistered.set(entity);
});

// Store trades and update daily metrics
KuruOrderBook.Trade.handler(async ({ event, context }) => {
  const entity: Kuru_Trade = {
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    market: event.srcAddress,
    orderId: (event.params.orderId as any).toString?.() ?? String(event.params.orderId),
    makerAddress: event.params.makerAddress,
    takerAddress: event.params.takerAddress,
    txOrigin: event.params.txOrigin,
    isBuy: Boolean(event.params.isBuy) as any,
    price: (event.params.price as any).toString?.() ?? String(event.params.price),
    updatedSize: (event.params.updatedSize as any).toString?.() ?? String(event.params.updatedSize),
    filledSize: (event.params.filledSize as any).toString?.() ?? String(event.params.filledSize),
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    gasUsed: (event.transaction as any)?.gasUsed ?? 0n,
    gasPrice: (event.transaction as any)?.effectiveGasPrice ?? (event.transaction as any)?.gasPrice ?? 0n,
  } as any;
  context.Kuru_Trade.set(entity);

  const tsMs = Number(event.block.timestamp) * 1000;
  const dateISO = dateISOFromTs(tsMs);
  const txHash = (event.transaction?.hash as string) || null;
  const gasUsed = (event.transaction as any)?.gasUsed ? BigInt((event.transaction as any).gasUsed) : null;
  const effPrice = (event.transaction as any)?.effectiveGasPrice
    ? BigInt((event.transaction as any).effectiveGasPrice)
    : (event.transaction as any)?.gasPrice
      ? BigInt((event.transaction as any).gasPrice)
      : null;
  const feeWei = gasUsed != null && effPrice != null ? gasUsed * effPrice : null;
  const userKey = (event.transaction?.from as string) || null;
  await upsertDaily(context, { protocolId: "kuru", dateISO, user: userKey, txDelta: 1, txHash, feeWei });
});

// Optional: Register markets created via MonadDeployer
MonadDeployer?.PumpingTime?.contractRegister?.(({ event, context }) => {
  if (event?.params?.market) {
    context.addKuruOrderBook(event.params.market);
  }
});
