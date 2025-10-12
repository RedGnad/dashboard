import { ERC20, TokenTransfer, TokenMetrics } from "../generated";

// Monad Testnet key tokens we want to track
const TRACKED_TOKENS = {
  WMON: "0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701",
  USDC: "0xf817257fed379853cDe0fa4F97AB987181B1E5Ea",
};

// Key addresses that might indicate important activity (DEX routers, etc.)
const IMPORTANT_ADDRESSES = [
  "0x3ae6d8a282d67893e17aa70ebffb33ee5aa65893", // Universal Router
  // Add more DEX/protocol addresses here
];

/**
 * ERC20 Transfer handler with wildcard indexing
 * Tracks all ERC20 transfers but focuses on USDC/WMON for AI features
 * Also captures native MON transfers via transaction value
 */
// Note: Wildcard disabled in config; handler still filters to tracked tokens/addresses as a safeguard
ERC20.Transfer.handler(
  async ({ event, context }) => {
    const { from, to, value } = event.params;
    const contractAddress = event.srcAddress.toLowerCase();
    
    // Check if this is one of our tracked tokens
    const isTrackedToken = Object.values(TRACKED_TOKENS).includes(contractAddress);
    const involvesImportantAddress = 
      IMPORTANT_ADDRESSES.includes(from.toLowerCase()) || 
      IMPORTANT_ADDRESSES.includes(to.toLowerCase());

    // Only process if it's a tracked token OR involves important addresses
    if (!isTrackedToken && !involvesImportantAddress) {
      return;
    }

    // Create ERC20 transfer record
    const transferId = `${event.chainId}_${event.block.number}_${event.logIndex}`;
    
    context.TokenTransfer.set({
      id: transferId,
      tokenAddress: contractAddress,
      from: from,
      to: to,
      value: value,
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
      logIndex: event.logIndex,
      gasUsed: event.transaction.gasUsed || 0n,
      gasPrice: event.transaction.effectiveGasPrice || 0n,
    });

    // BONUS: Also capture native MON transfers if this transaction has native value
    // This aggregates MON + WMON activity in the same dataset
    // Some generated types may omit `transaction.value`; access defensively
    const tx: any = event.transaction as any
    const nativeValue: bigint | undefined = tx && typeof tx.value !== 'undefined' ? tx.value : undefined
    const nativeFrom: string | undefined = tx && typeof tx.from !== 'undefined' ? tx.from : undefined

    if (nativeValue && nativeValue > 0n && nativeFrom) {
      const nativeTransferId = `native_${event.chainId}_${event.block.number}_${event.logIndex}`;
      
      context.TokenTransfer.set({
        id: nativeTransferId,
        tokenAddress: "0x0000000000000000000000000000000000000000", // Native token address
        from: nativeFrom,
        to: to, // Use the recipient from the ERC20 transfer event
        value: nativeValue, // Native MON amount
        blockNumber: event.block.number,
        blockTimestamp: event.block.timestamp,
        transactionHash: tx.hash ?? event.transaction.hash,
        logIndex: event.logIndex + 1000, // Offset to avoid ID conflicts
        gasUsed: tx.gasUsed ?? event.transaction.gasUsed ?? 0n,
        gasPrice: tx.effectiveGasPrice ?? event.transaction.effectiveGasPrice ?? 0n,
      });

      context.log.info(`Captured native MON transfer`, { value: String(nativeValue), tx: tx.hash ?? event.transaction.hash });
    }

    // Update token metrics for tracked tokens
    if (isTrackedToken) {
      await updateTokenMetrics(context, contractAddress, value, event.block.timestamp);
    }

    // Log for AI decision context
    context.log.info(`ERC20 Transfer processed`, {
      token: contractAddress,
      from: from.slice(0, 8) + "...",
      to: to.slice(0, 8) + "...", 
      value: value.toString(),
      block: event.block.number,
      isTracked: isTrackedToken,
    });
  }
);

/**
 * Update rolling token metrics for AI features calculation
 */
async function updateTokenMetrics(
  context: any, 
  tokenAddress: string, 
  transferValue: bigint, 
  timestamp: number
) {
  const tokenSymbol = getTokenSymbol(tokenAddress);
  const metricId = `${tokenAddress}_metrics`;
  
  // Get or create token metrics
  let metrics = await context.TokenMetrics.get(metricId);
  
  if (!metrics) {
    metrics = {
      id: metricId,
      tokenAddress,
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

  // Update metrics
  metrics.totalVolume += transferValue;
  metrics.transferCount += 1;
  metrics.lastTransferTime = timestamp;
  
  // Calculate time windows (basic implementation)
  const hourThreshold = timestamp - 3600; // 1 hour ago
  const dayThreshold = timestamp - 86400; // 24 hours ago
  
  // This is a simplified calculation - in production you'd want to maintain
  // proper time-windowed metrics with more sophisticated algorithms
  if (metrics.lastTransferTime > hourThreshold) {
    metrics.hourlyVolume += transferValue;
  }
  
  if (metrics.lastTransferTime > dayThreshold) {
    metrics.dailyVolume += transferValue;
  }

  // Basic volatility calculation (would need more sophisticated algo in production)
  metrics.volatilityScore = calculateSimpleVolatility(metrics);
  metrics.momentumScore = calculateSimpleMomentum(metrics);

  context.TokenMetrics.set(metrics);
}

function getTokenSymbol(address: string): string {
  switch (address.toLowerCase()) {
    case TRACKED_TOKENS.WMON.toLowerCase():
      return "WMON";
    case TRACKED_TOKENS.USDC.toLowerCase():
      return "USDC";
    default:
      return "UNKNOWN";
  }
}

function calculateSimpleVolatility(metrics: any): number {
  // Simplified volatility based on transfer frequency and volume changes
  const volumeRatio = Number(metrics.hourlyVolume) / (Number(metrics.dailyVolume) || 1);
  return Math.min(volumeRatio * 100, 100); // Cap at 100
}

function calculateSimpleMomentum(metrics: any): number {
  // Simplified momentum based on recent activity vs historical
  const recentActivity = Number(metrics.hourlyVolume);
  const baseActivity = Number(metrics.totalVolume) / (metrics.transferCount || 1);
  const momentum = (recentActivity / (baseActivity || 1) - 1) * 100;
  return Math.max(-100, Math.min(100, momentum)); // Clamp between -100 and 100
}