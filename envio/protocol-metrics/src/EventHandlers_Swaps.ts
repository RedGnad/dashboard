import { UniversalRouter, SwapEvent, PairMetrics } from "../generated";

// Key trading pairs we want to monitor for momentum/volatility
const TRACKED_PAIRS = {
  "WMON_USDC": {
    tokenA: "0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701", // WMON
    tokenB: "0xf817257fed379853cDe0fa4F97AB987181B1E5Ea", // USDC
  },
};

/**
 * Determine if a swap involves tracked token pairs
 */
function getPairKey(tokenIn: string, tokenOut: string): string | null {
  for (const [pairKey, { tokenA, tokenB }] of Object.entries(TRACKED_PAIRS)) {
    if (
      (tokenIn.toLowerCase() === tokenA.toLowerCase() && tokenOut.toLowerCase() === tokenB.toLowerCase()) ||
      (tokenIn.toLowerCase() === tokenB.toLowerCase() && tokenOut.toLowerCase() === tokenA.toLowerCase())
    ) {
      return pairKey;
    }
  }
  return null;
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
    
    // Check if this swap involves our tracked tokens
    const pairKey = getPairKey(tokenIn, tokenOut);
    if (!pairKey) {
      return; // Skip if not a tracked pair
    }

    const swapId = `${event.chainId}_${event.block.number}_${event.logIndex}`;
    
    // Calculate price (simple ratio)
    const price = Number(amountOut) / Number(amountIn);
    
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

    context.log.info(`Swap processed for AI metrics`, {
      pair: pairKey,
      price: price.toFixed(6),
      volume: amountIn.toString(),
      block: event.block.number,
    });
  }
);