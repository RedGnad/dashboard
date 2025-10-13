import { ERC20, TokenMetrics } from "../generated";

// ALL tracked tokens on Monad Testnet (complete list from src/tokens.ts)
const TRACKED_TOKENS: Record<string, string> = {
  WMON: "0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701",
  USDC: "0xf817257fed379853cDe0fa4F97AB987181B1E5Ea",
  BEAN: "0x268e4e24e0051ec27b3d27a95977e71ce6875a05",
  CHOG: "0xe0590015a873bf326bd645c3e1266d4db41c4e6b",
  DAK: "0x0f0bdebf0f83cd1ee3974779bcb7315f9808c714",
  YAKI: "0xfe140e1dCe99Be9F4F15d657CD9b7BF622270C50",
  WBTC: "0xcf5a6076cfa32686c0Df13aBaDa2b40dec133F1d",
  DAKIMAKURA: "0x0569049E527BB151605EEC7bf48Cfd55bD2Bf4c8",
};

/**
 * ERC20 Transfer handler - AGGREGATION ONLY (no individual transfer storage)
 * Tracks token metrics for AI features: volume, volatility, momentum
 * 
 * OPTIMIZATION: We do NOT store individual TokenTransfer entities to prevent disk saturation.
 * Only aggregated TokenMetrics are stored (sustainable for millions of transfers).
 */
ERC20.Transfer.handler(
  async ({ event, context }) => {
    const { from, to, value } = event.params;
    const contractAddress = event.srcAddress.toLowerCase();
    
    // Check if this is one of our tracked tokens
    const isTrackedToken = Object.values(TRACKED_TOKENS)
      .map(addr => addr.toLowerCase())
      .includes(contractAddress);

    // Skip if not a tracked token
    if (!isTrackedToken) {
      return;
    }

    // OPTIMIZATION: Skip individual transfer storage (would cause disk explosion)
    // Only update aggregated metrics below

    // Update token metrics for AI features
    await updateTokenMetrics(context, contractAddress, value, event.block.timestamp);

    // Log for monitoring (optional, can be disabled in production)
    context.log.debug(`ERC20 Transfer aggregated`, {
      token: getTokenSymbol(contractAddress),
      value: value.toString(),
      block: event.block.number,
    });
  }
);

/**
 * Update rolling token metrics for AI features calculation
 * This is the ONLY data we store (aggregations, not individual transfers)
 */
async function updateTokenMetrics(
  context: any, 
  tokenAddress: string, 
  transferValue: bigint, 
  timestamp: number
) {
  const tokenSymbol = getTokenSymbol(tokenAddress);
  const metricId = tokenAddress.toLowerCase();
  
  // Get or create token metrics
  let metrics = await context.TokenMetrics.get(metricId);
  
  if (!metrics) {
    metrics = {
      id: metricId,
      tokenAddress: tokenAddress.toLowerCase(),
      tokenSymbol,
      totalVolume: 0n,
      transferCount: 0,
      lastTransferTime: timestamp,
      hourlyVolume: 0n,
      dailyVolume: 0n,
      volatilityScore: 0,
      momentumScore: 0,
    };
  }

  // Update cumulative metrics
  const prevTotalVolume = BigInt(metrics.totalVolume);
  const prevTransferCount = Number(metrics.transferCount);
  
  metrics.totalVolume = prevTotalVolume + transferValue;
  metrics.transferCount = prevTransferCount + 1;
  metrics.lastTransferTime = timestamp;
  
  // Time-windowed volumes (simplified - resets on each update)
  // In production, you'd maintain proper rolling windows
  const hourThreshold = timestamp - 3600; // 1 hour ago
  const dayThreshold = timestamp - 86400; // 24 hours ago
  
  // Reset windows if outside threshold (simplified approach)
  if (metrics.lastTransferTime < hourThreshold) {
    metrics.hourlyVolume = transferValue;
  } else {
    metrics.hourlyVolume = BigInt(metrics.hourlyVolume) + transferValue;
  }
  
  if (metrics.lastTransferTime < dayThreshold) {
    metrics.dailyVolume = transferValue;
  } else {
    metrics.dailyVolume = BigInt(metrics.dailyVolume) + transferValue;
  }

  // Calculate AI features
  metrics.volatilityScore = calculateSimpleVolatility(metrics);
  metrics.momentumScore = calculateSimpleMomentum(metrics);

  // Store aggregated metrics (NO await needed - in-memory storage per Envio docs)
  context.TokenMetrics.set(metrics);
}

function getTokenSymbol(address: string): string {
  const lowerAddress = address.toLowerCase();
  for (const [symbol, addr] of Object.entries(TRACKED_TOKENS)) {
    if (addr.toLowerCase() === lowerAddress) {
      return symbol;
    }
  }
  return "UNKNOWN";
}

function calculateSimpleVolatility(metrics: any): number {
  // Volatility based on hourly vs daily volume ratio
  const hourly = Number(metrics.hourlyVolume);
  const daily = Number(metrics.dailyVolume);
  
  if (daily === 0) return 0;
  
  const volumeRatio = hourly / daily;
  // Higher ratio = more recent activity = higher volatility
  return Math.min(volumeRatio * 100, 100); // Cap at 100
}

function calculateSimpleMomentum(metrics: any): number {
  // Momentum based on recent activity vs average
  const recentActivity = Number(metrics.hourlyVolume);
  const avgActivity = Number(metrics.totalVolume) / Math.max(1, metrics.transferCount);
  
  if (avgActivity === 0) return 0;
  
  const momentum = (recentActivity / avgActivity - 1) * 100;
  return Math.max(-100, Math.min(100, momentum)); // Clamp between -100 and 100
}
