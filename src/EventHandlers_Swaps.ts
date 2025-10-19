import { UniversalRouter, SwapEvent, DailyMetrics, DailyUser, ProtocolState, DailyTxFeeCounted } from "../generated";

function pairKeyFor(tokenIn: string, tokenOut: string): string {
  const a = tokenIn.toLowerCase();
  const b = tokenOut.toLowerCase();
  return [a, b].sort().join("_");
}


// Helper functions for DailyMetrics aggregation (same as other handlers)
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


/**
 * Universal Router swap handler
 * Tracks swaps for calculating price movement, momentum, and volatility metrics
 */
UniversalRouter.SwapExecuted.handler(
  async ({ event, context }) => {
    const { tokenIn, tokenOut, amountIn, amountOut, recipient } = event.params;
    const pairKey = pairKeyFor(tokenIn, tokenOut);

    const swapId = `${event.chainId}_${event.block.number}_${event.logIndex}`;
    
    // Calculate price (simple ratio) with guards
    let price = 0;
    try {
      const ain = (amountIn as any) as bigint;
      const aout = (amountOut as any) as bigint;
      if (typeof ain === 'bigint' && ain !== 0n) {
        price = Number(aout) / Number(ain);
      } else {
        const ainNum = Number(amountIn as any);
        const aoutNum = Number(amountOut as any);
        price = ainNum > 0 ? (aoutNum / ainNum) : 0;
      }
      if (!Number.isFinite(price) || Number.isNaN(price)) price = 0;
    } catch {
      const ainNum = Number(amountIn as any);
      const aoutNum = Number(amountOut as any);
      price = ainNum > 0 ? (aoutNum / ainNum) : 0;
      if (!Number.isFinite(price) || Number.isNaN(price)) price = 0;
    }
    
    // Store swap event
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

    // PairMetrics writes disabled due to schema mismatch and performance concerns

    // Aggregate daily metrics for "dex" protocol
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
    await upsertDaily(context, { protocolId: "dex", dateISO, user: userKey, txDelta: 1, txHash, feeWei });

    context.log.info(`Swap processed for AI metrics`, {
      pair: pairKey,
      price: Number.isFinite(price) ? price.toFixed(6) : '0.000000',
      volume: amountIn.toString(),
      block: event.block.number,
    });
  }
);