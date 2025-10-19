import { UniversalRouter, SwapEvent, PairMetrics, DailyMetrics, DailyUser, ProtocolState, DailyTxFeeCounted } from "../generated";

function pairKeyFor(tokenIn: string, tokenOut: string): string {
  const a = tokenIn.toLowerCase();
  const b = tokenOut.toLowerCase();
  return [a, b].sort().join("_");
}

/**
 * Calculate volatility as standard deviation of price changes
 */
function calculateVolatility(priceHistory: number[]): number {
  if (priceHistory.length < 2) return 0;
  
  const changes = [];
  for (let i = 1; i < priceHistory.length; i++) {
    changes.push((priceHistory[i] - priceHistory[i-1]) / priceHistory[i-1]);
  }
  
  const mean = changes.reduce((sum, change) => sum + change, 0) / changes.length;
  const variance = changes.reduce((sum, change) => sum + Math.pow(change - mean, 2), 0) / changes.length;
  
  return Math.sqrt(variance) * 100; // As percentage
}

/**
 * Calculate momentum indicators for AI features
 */
function calculateMomentum(priceHistory: number[]): { shortMomentum: number, longMomentum: number } {
  if (priceHistory.length < 10) {
    return { shortMomentum: 0, longMomentum: 0 };
  }
  
  const current = priceHistory[priceHistory.length - 1];
  
  // Short-term momentum (last 5 prices vs current)
  const shortStart = Math.max(0, priceHistory.length - 5);
  const shortAvg = priceHistory.slice(shortStart, -1).reduce((sum, p) => sum + p, 0) / 4;
  const shortMomentum = ((current - shortAvg) / shortAvg) * 100;
  
  // Long-term momentum (last 20 prices vs current)
  const longStart = Math.max(0, priceHistory.length - 20);
  const longAvg = priceHistory.slice(longStart, -1).reduce((sum, p) => sum + p, 0) / Math.min(19, priceHistory.length - 1);
  const longMomentum = ((current - longAvg) / longAvg) * 100;
  
  return { shortMomentum, longMomentum };
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
 * Update aggregated pair metrics for AI feature calculation
 */
async function updatePairMetrics(
  context: any,
  pairKey: string,
  currentPrice: number,
  volumeIn: bigint,
  volumeOut: bigint,
  timestamp: number
) {
  const hour = Math.floor(timestamp / 3600) * 3600; // Round to hour
  const metricsId = `${pairKey}_${hour}`;

  let metrics = await context.PairMetrics.get(metricsId);
  
  if (!metrics) {
    metrics = {
      id: metricsId,
      pairKey,
      hour,
      swapCount: 0,
      totalVolumeIn: BigInt(0),
      totalVolumeOut: BigInt(0),
      highPrice: currentPrice,
      lowPrice: currentPrice,
      openPrice: currentPrice,
      closePrice: currentPrice,
      lastUpdate: timestamp,
    };
  }

  // Update metrics
  metrics.swapCount += 1;
  metrics.totalVolumeIn += volumeIn;
  metrics.totalVolumeOut += volumeOut;
  metrics.highPrice = Math.max(metrics.highPrice, currentPrice);
  metrics.lowPrice = Math.min(metrics.lowPrice, currentPrice);
  metrics.closePrice = currentPrice;
  metrics.lastUpdate = timestamp;

  context.PairMetrics.set(metrics);
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

    // Update pair metrics for AI features
    await updatePairMetrics(context, pairKey, price, amountIn, amountOut, event.block.timestamp);

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