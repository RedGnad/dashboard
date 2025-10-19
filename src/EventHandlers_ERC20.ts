import { ERC20, TokenTransfer, TokenMetrics, DailyMetrics, DailyUser, ProtocolState, DailyTxFeeCounted } from "generated";

// Monad Testnet key tokens we want to track (all tokens for AI trading decisions)
const TRACKED_TOKENS = {
  WMON: "0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701",
  USDC: "0xf817257fed379853cDe0fa4F97AB987181B1E5Ea",
  CHOG: "0xe0590015a873bf326bd645c3e1266d4db41c4e6b",
  YAKI: "0xfe140e1dCe99Be9F4F15d657CD9b7BF622270C50",
  DAK: "0x0f0bdebf0f83cd1ee3974779bcb7315f9808c714",
  BEAN: "0x268e4e24e0051ec27b3d27a95977e71ce6875a05",
  WBTC: "0xcf5a6076cfa32686c0Df13aBaDa2b40dec133F1d",
  DAKIMAKURA: "0x0569049E527BB151605EEC7bf48Cfd55bD2Bf4c8",
};

// Minimum thresholds to INDEX (reduce DB volume)
const MIN_INDEX_THRESHOLDS = {
  WMON: 1n * 10n ** 18n,           // 1 WMON minimum to index
  USDC: 1n * 10n ** 6n,            // 1 USDC minimum
  CHOG: 1n * 10n ** 18n,           // 1 CHOG minimum
  YAKI: 1n * 10n ** 18n,           // 1 YAKI minimum
  DAK: 1n * 10n ** 18n,            // 1 DAK minimum
  BEAN: 1n * 10n ** 18n,           // 1 BEAN minimum
  WBTC: 1n * 10n ** 7n,            // 0.1 WBTC minimum (8 decimals)
  DAKIMAKURA: 1n * 10n ** 18n,     // 1 DAKIMAKURA minimum
};

// Whale thresholds (mark as whale movement for AI signals)
const WHALE_THRESHOLDS = {
  WMON: 10000n * 10n ** 18n,       // 10,000 WMON = whale
  USDC: 30000n * 10n ** 6n,        // 30,000 USDC = whale
  CHOG: 100000n * 10n ** 18n,      // 100,000 CHOG = whale
  YAKI: 100000n * 10n ** 18n,      // 100,000 YAKI = whale
  DAK: 100000n * 10n ** 18n,       // 100,000 DAK = whale
  BEAN: 100000n * 10n ** 18n,      // 100,000 BEAN = whale
  WBTC: 1n * 10n ** 8n,            // 1 WBTC = whale (8 decimals, ~$60k)
  DAKIMAKURA: 100000n * 10n ** 18n, // 100,000 DAKIMAKURA = whale
};

// Key addresses that might indicate important activity (DEX routers, etc.)
const IMPORTANT_ADDRESSES = [
  "0x3ae6d8a282d67893e17aa70ebffb33ee5aa65893", // Universal Router
  "0x3012e9049d05b4b5369d690114d5a5861ebb85cb", // Atlantis SwapRouter
  "0x4bb54bb9a42fe787d1d1a2aacf91c70b02e5553e", // Atlantis/Clober UpdatePosition target
  "0x8b1fb7b1da49f111a2c0c11925d5bb86a2fab88e", // OctoSwap UniversalRouter
  "0xb6091233aacacba45225a2b2121bbac807af4255", // OctoSwap Router02
];

// Map router addresses -> protocolId for DailyMetrics aggregation
const PROTOCOL_BY_ADDRESS: Record<string, string> = {
  "0x3ae6d8a282d67893e17aa70ebffb33ee5aa65893": "dex",        // existing universal router bucket
  "0x3012e9049d05b4b5369d690114d5a5861ebb85cb": "atlantis",    // Atlantis SwapRouter
  "0x8b1fb7b1da49f111a2c0c11925d5bb86a2fab88e": "octoswap",    // OctoSwap UniversalRouter
  "0xb6091233aacacba45225a2b2121bbac807af4255": "octoswap",    // OctoSwap Router02 (lowercase)
  "0x2555223a15a931a71951707cb32a541f14e2c730": "curvance",    // Curvance veCVE contract
  "0x4bb54bb9a42fe787d1d1a2aacf91c70b02e5553e": "atlantis",    // Atlantis/Clober UpdatePosition target
};

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

/**
 * ERC20 Transfer handler with wildcard indexing
 * Tracks all ERC20 transfers but focuses on USDC/WMON for AI features
 * Also captures native MON transfers via transaction value
 */
// Note: Wildcard disabled in config; handler still filters to tracked tokens/addresses as a safeguard
ERC20.Transfer.handler(
  async ({ event, context }) => {
    try {
      const { from, to, value } = event.params;
      const contractAddress = event.srcAddress.toLowerCase();
      const txToLc = ((event.transaction as any)?.to || '').toLowerCase?.() || '';

      // Determine recency window (30d) for heavy derived writes
      const nowSec = Math.floor(Date.now() / 1000);
      const cutoffSec = nowSec - 30 * 86400;
      const derivedFull = (typeof process !== 'undefined' && (process as any)?.env?.ENVIO_DERIVED_FULL === 'true');
      const isRecent = derivedFull || (Number(event.block.timestamp) >= cutoffSec);

      // Check if this is one of our tracked tokens (case-insensitive)
      const isTrackedToken = Object.values(TRACKED_TOKENS).map(a => a.toLowerCase()).includes(contractAddress);
      const involvesImportantAddress =
        IMPORTANT_ADDRESSES.includes(from.toLowerCase()) ||
        IMPORTANT_ADDRESSES.includes(to.toLowerCase()) ||
        IMPORTANT_ADDRESSES.includes(txToLc);

      // MINIMUM FILTER: Skip tiny transfers (< 1 MON equivalent) unless DEX
      const tokenSymbol = getTokenSymbol(contractAddress);
      const minThreshold = getMinIndexThreshold(tokenSymbol);
      const meetsMinimum = value >= minThreshold;
      const shouldIndex = involvesImportantAddress || meetsMinimum;

      if (!shouldIndex) {
        // Skip sub-threshold transfers to reduce DB volume
        return;
      }

      // WHALE FLAG: Mark large movements for AI priority
      const whaleThreshold = getWhaleThreshold(tokenSymbol);
      const isWhaleMovement = value >= whaleThreshold;

      // Create ERC20 transfer record (raw event for verifiability) only in recent window
      if (isRecent) {
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
          gasUsed: (event.transaction as any)?.gasUsed ?? 0n,
          gasPrice: (event.transaction as any)?.effectiveGasPrice ?? (event.transaction as any)?.gasPrice ?? 0n,
        });
      }

      // Attribute this transfer to a protocol if it involves a known router
      try {
        const fromLc = from.toLowerCase();
        const toLc = to.toLowerCase();
        const txToLc = ((event.transaction as any)?.to || '').toLowerCase?.() || '';
        const proto = PROTOCOL_BY_ADDRESS[fromLc] || PROTOCOL_BY_ADDRESS[toLc] || PROTOCOL_BY_ADDRESS[txToLc];
        if (proto) {
          const tsMs = Number(event.block.timestamp) * 1000;
          const dateISO = dateISOFromTs(tsMs);
          const txHash = (event.transaction?.hash as string) || null;
          const feeWei = feeFromTx(event.transaction as any);
          const userKey = (event.transaction?.from as string) || null;
          await upsertDaily(context, { protocolId: proto, dateISO, user: userKey, txDelta: 1, txHash, feeWei });
        }
      } catch {}

      // BONUS: Also capture native MON transfers only for recent period
      const tx: any = event.transaction as any
      const nativeValue: bigint | undefined = tx && typeof tx.value !== 'undefined' ? tx.value : undefined
      const nativeFrom: string | undefined = tx && typeof tx.from !== 'undefined' ? tx.from : undefined
      const synthNativeEnabled = (typeof process !== 'undefined' && (process as any)?.env?.ENVIO_SYNTH_NATIVE === 'true')
      if (synthNativeEnabled && isRecent && nativeValue && nativeValue > 0n && nativeFrom) {
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
          gasUsed: tx.gasUsed ?? (event.transaction as any)?.gasUsed ?? 0n,
          gasPrice: tx.effectiveGasPrice ?? (event.transaction as any)?.effectiveGasPrice ?? (event.transaction as any)?.gasPrice ?? 0n,
        });

        try { context.log.info(`Captured native MON transfer`, { value: String(nativeValue), tx: String(tx.hash ?? event.transaction.hash) }) } catch {}
      }

      // Update token metrics only for recent period (heavy derived write)
      if (isRecent && isTrackedToken) {
        await updateTokenMetrics(context, contractAddress, value, event.block.timestamp);
      }

      // Log sampling (reduce IO): always log whales; otherwise sample every N events if ENVIO_LOG_SAMPLE_RATE is set
      const sampleRateRaw = (typeof process !== 'undefined' ? (process as any)?.env?.ENVIO_LOG_SAMPLE_RATE : undefined) as string | undefined
      const sampleRate = sampleRateRaw ? Number(sampleRateRaw) : 0
      const shouldLog = isWhaleMovement || (sampleRate > 0 && (event.logIndex % Math.max(1, sampleRate) === 0))
      if (shouldLog) {
        try {
          context.log.info(`ERC20 Transfer processed`, {
            token: contractAddress,
            from: from.slice(0, 8) + "...",
            to: to.slice(0, 8) + "...",
            value: value.toString(),
            block: String(event.block.number),
            isTracked: isTrackedToken,
            isWhaleMovement: isWhaleMovement,
          });
        } catch {}
      }
    } catch (err) {
      try {
        context.log.error?.('ERC20 handler error', {
          err: String((err as any)?.message || err),
          block: String(event.block?.number ?? ''),
          tx: String((event.transaction as any)?.hash ?? ''),
        })
      } catch {}
      // swallow to avoid indexer restart on single bad event
    }
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

  let existing = await context.TokenMetrics.get(metricId);

  // Normalize persisted fields (BigInt may be returned as strings)
  let totalVolumePrev = 0n;
  let hourlyVolumePrev = 0n;
  let dailyVolumePrev = 0n;
  let transferCountPrev = 0;
  let lastTransferTimePrev = 0;
  let volatilityPrev = 0;
  let momentumPrev = 0;

  if (existing) {
    try { totalVolumePrev = BigInt((existing as any).totalVolume ?? 0) } catch { totalVolumePrev = 0n }
    try { hourlyVolumePrev = BigInt((existing as any).hourlyVolume ?? 0) } catch { hourlyVolumePrev = 0n }
    try { dailyVolumePrev = BigInt((existing as any).dailyVolume ?? 0) } catch { dailyVolumePrev = 0n }
    try { transferCountPrev = Number((existing as any).transferCount ?? 0) } catch { transferCountPrev = 0 }
    try { lastTransferTimePrev = Number((existing as any).lastTransferTime ?? 0) } catch { lastTransferTimePrev = 0 }
    try { volatilityPrev = Number((existing as any).volatilityScore ?? 0) } catch { volatilityPrev = 0 }
    try { momentumPrev = Number((existing as any).momentumScore ?? 0) } catch { momentumPrev = 0 }
  }

  const totalVolumeNext = totalVolumePrev + BigInt(transferValue);
  const transferCountNext = transferCountPrev + 1;
  const lastTransferTimeNext = timestamp;

  // Time windows
  const hourThreshold = timestamp - 3600; // 1h
  const dayThreshold = timestamp - 86400; // 24h
  const hourlyVolumeNext = lastTransferTimeNext > hourThreshold ? (hourlyVolumePrev + BigInt(transferValue)) : hourlyVolumePrev;
  const dailyVolumeNext = lastTransferTimeNext > dayThreshold ? (dailyVolumePrev + BigInt(transferValue)) : dailyVolumePrev;

  // Simple scores (use next values where appropriate)
  const metricsTemp = {
    totalVolume: totalVolumeNext,
    hourlyVolume: hourlyVolumeNext,
    dailyVolume: dailyVolumeNext,
    transferCount: transferCountNext,
  } as any;
  const volatilityNext = calculateSimpleVolatility(metricsTemp);
  const momentumNext = calculateSimpleMomentum({ ...metricsTemp, totalVolume: totalVolumeNext });

  const toStore = {
    id: metricId,
    tokenAddress,
    tokenSymbol,
    totalVolume: totalVolumeNext.toString() as any,
    transferCount: transferCountNext,
    lastTransferTime: lastTransferTimeNext,
    hourlyVolume: hourlyVolumeNext.toString() as any,
    dailyVolume: dailyVolumeNext.toString() as any,
    volatilityScore: volatilityNext,
    momentumScore: momentumNext,
  };

  context.TokenMetrics.set(toStore as any);
}

function getTokenSymbol(address: string): string {
  switch (address.toLowerCase()) {
    case TRACKED_TOKENS.WMON.toLowerCase():
      return "WMON";
    case TRACKED_TOKENS.USDC.toLowerCase():
      return "USDC";
    case TRACKED_TOKENS.CHOG.toLowerCase():
      return "CHOG";
    case TRACKED_TOKENS.YAKI.toLowerCase():
      return "YAKI";
    case TRACKED_TOKENS.DAK.toLowerCase():
      return "DAK";
    case TRACKED_TOKENS.BEAN.toLowerCase():
      return "BEAN";
    case TRACKED_TOKENS.WBTC.toLowerCase():
      return "WBTC";
    case TRACKED_TOKENS.DAKIMAKURA.toLowerCase():
      return "DAKIMAKURA";
    default:
      return "UNKNOWN";
  }
}

// Helper: minimum index threshold per token symbol
function getMinIndexThreshold(symbol: string): bigint {
  const map = MIN_INDEX_THRESHOLDS as Record<string, bigint>;
  // Default to 1 MON for unknown tokens to avoid indexing dust
  return map[symbol] ?? (1n * 10n ** 18n);
}

// Helper: whale threshold per token symbol
function getWhaleThreshold(symbol: string): bigint {
  const map = WHALE_THRESHOLDS as Record<string, bigint>;
  // Very large fallback to avoid flagging unknown tokens as whales
  return map[symbol] ?? (10n ** 30n);
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