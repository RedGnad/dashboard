import { UniversalRouter, PairMetrics } from "../generated";

// Key trading pairs we want to monitor for momentum/volatility
const TRACKED_PAIRS: Record<string, { tokenA: string; tokenB: string }> = {
  "WMON_USDC": {
    tokenA: "0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701", // WMON
    tokenB: "0xf817257fed379853cDe0fa4F97AB987181B1E5Ea", // USDC
  },
  // Add more pairs as needed (e.g., WBTC_USDC, BEAN_USDC, etc.)
};

/**
 * Determine if a swap involves tracked token pairs
 */
function getPairKey(tokenIn: string, tokenOut: string): string | null {
  for (const [pairKey, { tokenA, tokenB }] of Object.entries(TRACKED_PAIRS)) {
    const tokenInLower = tokenIn.toLowerCase();
    const tokenOutLower = tokenOut.toLowerCase();
    const tokenALower = tokenA.toLowerCase();
    const tokenBLower = tokenB.toLowerCase();
    
    if (
      (tokenInLower === tokenALower && tokenOutLower === tokenBLower) ||
      (tokenInLower === tokenBLower && tokenOutLower === tokenALower)
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
    const prevPrice = priceHistory[i-1];
    if (prevPrice === 0) continue;
    changes.push((priceHistory[i] - prevPrice) / prevPrice);
  }
  
  if (changes.length === 0) return 0;
  
  const mean = changes.reduce((sum, change) => sum + change, 0) / changes.length;
  const variance = changes.reduce((sum, change) => sum + Math.pow(change - mean, 2), 0) / changes.length;
  
  return Math.sqrt(variance) * 100; // As percentage
}

/**
 * Calculate momentum indicators for AI features
 */
function calculateMomentum(priceHistory: number[]): { shortMomentum: number, longMomentum: number } {
  if (priceHistory.length < 2) {
    return { shortMomentum: 0, longMomentum: 0 };
  }
  
  const current = priceHistory[priceHistory.length - 1];
  
  // Short-term momentum (last 5 prices vs current, ~15min if 1 swap/3min)
  const shortWindow = Math.min(5, priceHistory.length - 1);
  const shortStart = Math.max(0, priceHistory.length - shortWindow - 1);
  const shortPrices = priceHistory.slice(shortStart, -1);
  const shortAvg = shortPrices.reduce((sum, p) => sum + p, 0) / shortPrices.length;
  const shortMomentum = shortAvg > 0 ? ((current - shortAvg) / shortAvg) * 100 : 0;
  
  // Long-term momentum (last 20 prices vs current, ~1h if 1 swap/3min)
  const longWindow = Math.min(20, priceHistory.length - 1);
  const longStart = Math.max(0, priceHistory.length - longWindow - 1);
  const longPrices = priceHistory.slice(longStart, -1);
  const longAvg = longPrices.reduce((sum, p) => sum + p, 0) / longPrices.length;
  const longMomentum = longAvg > 0 ? ((current - longAvg) / longAvg) * 100 : 0;
  
  return { shortMomentum, longMomentum };
}

/**
 * Update aggregated pair metrics for AI feature calculation
 * OPTIMIZATION: We store hourly aggregations, not individual swaps
 */
async function updatePairMetrics(
  context: any,
  pairKey: string,
  currentPrice: number,
  volumeIn: bigint,
  volumeOut: bigint,
  timestamp: number
) {
  // Use pairKey as ID (one record per pair, continuously updated)
  const metricsId = pairKey;

  let metrics = await context.PairMetrics.get(metricsId);
  
  if (!metrics) {
    // Initialize new pair metrics
    metrics = {
      id: metricsId,
      pairKey,
      currentPrice,
      previousPrice: currentPrice,
      priceChange24h: 0,
      volatility24h: 0,
      volume24h: 0n,
      swapCount24h: 0,
      lastUpdateTime: timestamp,
      priceHistory: [currentPrice],
      momentumShort: 0,
      momentumLong: 0,
    };
  } else {
    // Update existing metrics
    const prevPrice = Number(metrics.currentPrice);
    
    // Update price history (keep last 100 prices for calculations)
    let priceHistory = [...metrics.priceHistory, currentPrice];
    if (priceHistory.length > 100) {
      priceHistory = priceHistory.slice(-100); // Keep only last 100
    }
    
    // Calculate 24h metrics (simplified - in production use proper time windows)
    const timeSinceLastUpdate = timestamp - Number(metrics.lastUpdateTime);
    const is24hWindow = timeSinceLastUpdate < 86400; // 24 hours
    
    metrics.previousPrice = prevPrice;
    metrics.currentPrice = currentPrice;
    metrics.priceChange24h = prevPrice > 0 ? ((currentPrice - prevPrice) / prevPrice) * 100 : 0;
    
    // Reset 24h counters if outside window
    if (is24hWindow) {
      metrics.volume24h = BigInt(metrics.volume24h) + volumeIn;
      metrics.swapCount24h = Number(metrics.swapCount24h) + 1;
    } else {
      metrics.volume24h = volumeIn;
      metrics.swapCount24h = 1;
    }
    
    // Calculate volatility and momentum
    metrics.volatility24h = calculateVolatility(priceHistory);
    const momentum = calculateMomentum(priceHistory);
    metrics.momentumShort = momentum.shortMomentum;
    metrics.momentumLong = momentum.longMomentum;
    
    metrics.priceHistory = priceHistory;
    metrics.lastUpdateTime = timestamp;
  }

  // Store aggregated metrics (NO await needed - in-memory storage per Envio docs)
  context.PairMetrics.set(metrics);
}

/**
 * Universal Router swap handler - AGGREGATION ONLY
 * Tracks swaps for calculating price movement, momentum, and volatility metrics
 * 
 * OPTIMIZATION: We do NOT store individual SwapEvent entities to prevent disk saturation.
 * Only aggregated PairMetrics are stored (sustainable for millions of swaps).
 */
UniversalRouter.SwapExecuted.handler(
  async ({ event, context }) => {
    const { tokenIn, tokenOut, amountIn, amountOut, recipient } = event.params;
    
    // Check if this swap involves our tracked tokens
    const pairKey = getPairKey(tokenIn, tokenOut);
    if (!pairKey) {
      return; // Skip if not a tracked pair
    }

    // Calculate price (simple ratio)
    const price = Number(amountOut) / Number(amountIn);
    
    // OPTIMIZATION: Skip individual swap storage (would cause disk explosion)
    // Only update aggregated metrics below

    // Update pair metrics for AI features
    await updatePairMetrics(context, pairKey, price, amountIn, amountOut, event.block.timestamp);

    // Log for monitoring (optional, can be disabled in production)
    context.log.debug(`Swap aggregated for AI metrics`, {
      pair: pairKey,
      price: price.toFixed(6),
      volume: amountIn.toString(),
      block: event.block.number,
    });
  }
);
