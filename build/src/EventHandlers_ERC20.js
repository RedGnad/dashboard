"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const generated_1 = require("generated");
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
    PINGU: "0xA2426cD97583939E79Cfc12aC6E9121e37D0904d",
    OCTO: "0xCa9A4F46Faf5628466583486FD5ACE8AC33ce126",
    KB: "0x34d1ae6076aee4072f54e1156d2e507dd564a355",
    WSOL: "0x5387C85A4965769f6B0Df430638a1388493486F1",
};
// Minimum thresholds to INDEX (reduce DB volume)
const MIN_INDEX_THRESHOLDS = {
    WMON: 1n * 10n ** 18n,
    USDC: 1n * 10n ** 6n,
    CHOG: 1n * 10n ** 18n,
    YAKI: 1n * 10n ** 18n,
    DAK: 1n * 10n ** 18n,
    BEAN: 1n * 10n ** 18n,
    WBTC: 1n * 10n ** 7n,
    DAKIMAKURA: 1n * 10n ** 18n,
    PINGU: 1n * 10n ** 18n,
    OCTO: 1n * 10n ** 18n,
    KB: 1n * 10n ** 18n,
    WSOL: 1n * 10n ** 9n, // 1 WSOL minimum (9 decimals)
};
// Whale thresholds (mark as whale movement for AI signals)
const WHALE_THRESHOLDS = {
    WMON: 10000n * 10n ** 18n,
    USDC: 5000n * 10n ** 6n,
    CHOG: 100000n * 10n ** 18n,
    YAKI: 100000n * 10n ** 18n,
    DAK: 100000n * 10n ** 18n,
    BEAN: 100000n * 10n ** 18n,
    WBTC: 1n * 10n ** 8n,
    DAKIMAKURA: 100000n * 10n ** 18n,
    PINGU: 100000n * 10n ** 18n,
    OCTO: 100000n * 10n ** 18n,
    KB: 100000n * 10n ** 18n,
    WSOL: 10000n * 10n ** 9n, // 10,000 WSOL = whale (testnet)
};
// Key addresses that might indicate important activity (DEX routers, etc.)
const IMPORTANT_ADDRESSES = [
    "0x3ae6d8a282d67893e17aa70ebffb33ee5aa65893",
    "0x3012e9049d05b4b5369d690114d5a5861ebb85cb",
    "0x4bb54bb9a42fe787d1d1a2aacf91c70b02e5553e",
    "0x8b1fb7b1da49f111a2c0c11925d5bb86a2fab88e",
    "0xb6091233aacacba45225a2b2121bbac807af4255", // OctoSwap Router02
];
// Map router addresses -> protocolId for DailyMetrics aggregation
const PROTOCOL_BY_ADDRESS = {
    "0x3ae6d8a282d67893e17aa70ebffb33ee5aa65893": "dex",
    "0x3012e9049d05b4b5369d690114d5a5861ebb85cb": "atlantis",
    "0x8b1fb7b1da49f111a2c0c11925d5bb86a2fab88e": "octoswap",
    "0xb6091233aacacba45225a2b2121bbac807af4255": "octoswap",
    "0x2555223a15a931a71951707cb32a541f14e2c730": "curvance",
    "0x4bb54bb9a42fe787d1d1a2aacf91c70b02e5553e": "atlantis", // Atlantis/Clober UpdatePosition target
};
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
function feeFromTx(tx) {
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
generated_1.ERC20.Transfer.handler(async ({ event, context }) => {
    try {
        const { from, to, value } = event.params;
        const contractAddress = event.srcAddress.toLowerCase();
        const txToLc = (event.transaction?.to || '').toLowerCase?.() || '';
        // Determine recency window (30d) for heavy derived writes
        const nowSec = Math.floor(Date.now() / 1000);
        const cutoffSec = nowSec - 30 * 86400;
        const derivedFull = (typeof process !== 'undefined' && process?.env?.ENVIO_DERIVED_FULL === 'true');
        const isRecent = derivedFull || (Number(event.block.timestamp) >= cutoffSec);
        // Check if this is one of our tracked tokens (case-insensitive)
        const isTrackedToken = Object.values(TRACKED_TOKENS).map(a => a.toLowerCase()).includes(contractAddress);
        const involvesImportantAddress = IMPORTANT_ADDRESSES.includes(from.toLowerCase()) ||
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
                gasUsed: event.transaction?.gasUsed ?? 0n,
                gasPrice: event.transaction?.effectiveGasPrice ?? event.transaction?.gasPrice ?? 0n,
            });
        }
        // Attribute this transfer to a protocol if it involves a known router
        try {
            const fromLc = from.toLowerCase();
            const toLc = to.toLowerCase();
            const txToLc = (event.transaction?.to || '').toLowerCase?.() || '';
            const proto = PROTOCOL_BY_ADDRESS[fromLc] || PROTOCOL_BY_ADDRESS[toLc] || PROTOCOL_BY_ADDRESS[txToLc];
            if (proto) {
                const tsMs = Number(event.block.timestamp) * 1000;
                const dateISO = dateISOFromTs(tsMs);
                const txHash = event.transaction?.hash || null;
                const feeWei = feeFromTx(event.transaction);
                const userKey = event.transaction?.from || null;
                await upsertDaily(context, { protocolId: proto, dateISO, user: userKey, txDelta: 1, txHash, feeWei });
            }
        }
        catch { }
        // BONUS: Also capture native MON transfers only for recent period
        const tx = event.transaction;
        const nativeValue = tx && typeof tx.value !== 'undefined' ? tx.value : undefined;
        const nativeFrom = tx && typeof tx.from !== 'undefined' ? tx.from : undefined;
        const synthNativeEnabled = (typeof process !== 'undefined' && process?.env?.ENVIO_SYNTH_NATIVE === 'true');
        if (synthNativeEnabled && isRecent && nativeValue && nativeValue > 0n && nativeFrom) {
            const nativeTransferId = `native_${event.chainId}_${event.block.number}_${event.logIndex}`;
            context.TokenTransfer.set({
                id: nativeTransferId,
                tokenAddress: "0x0000000000000000000000000000000000000000",
                from: nativeFrom,
                to: to,
                value: nativeValue,
                blockNumber: event.block.number,
                blockTimestamp: event.block.timestamp,
                transactionHash: tx.hash ?? event.transaction.hash,
                logIndex: event.logIndex + 1000,
                gasUsed: tx.gasUsed ?? event.transaction?.gasUsed ?? 0n,
                gasPrice: tx.effectiveGasPrice ?? event.transaction?.effectiveGasPrice ?? event.transaction?.gasPrice ?? 0n,
            });
            try {
                context.log.info(`Captured native MON transfer`, { value: String(nativeValue), tx: String(tx.hash ?? event.transaction.hash) });
            }
            catch { }
        }
        // Update token metrics only for recent period (heavy derived write)
        if (isRecent && isTrackedToken) {
            await updateTokenMetrics(context, contractAddress, value, event.block.timestamp);
        }
        // Log sampling (reduce IO): always log whales; otherwise sample every N events if ENVIO_LOG_SAMPLE_RATE is set
        const sampleRateRaw = (typeof process !== 'undefined' ? process?.env?.ENVIO_LOG_SAMPLE_RATE : undefined);
        const sampleRate = sampleRateRaw ? Number(sampleRateRaw) : 0;
        const shouldLog = isWhaleMovement || (sampleRate > 0 && (event.logIndex % Math.max(1, sampleRate) === 0));
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
            }
            catch { }
        }
    }
    catch (err) {
        try {
            context.log.error?.('ERC20 handler error', {
                err: String(err?.message || err),
                block: String(event.block?.number ?? ''),
                tx: String(event.transaction?.hash ?? ''),
            });
        }
        catch { }
        // swallow to avoid indexer restart on single bad event
    }
});
/**
 * Update rolling token metrics for AI features calculation
 */
async function updateTokenMetrics(context, tokenAddress, transferValue, timestamp) {
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
        try {
            totalVolumePrev = BigInt(existing.totalVolume ?? 0);
        }
        catch {
            totalVolumePrev = 0n;
        }
        try {
            hourlyVolumePrev = BigInt(existing.hourlyVolume ?? 0);
        }
        catch {
            hourlyVolumePrev = 0n;
        }
        try {
            dailyVolumePrev = BigInt(existing.dailyVolume ?? 0);
        }
        catch {
            dailyVolumePrev = 0n;
        }
        try {
            transferCountPrev = Number(existing.transferCount ?? 0);
        }
        catch {
            transferCountPrev = 0;
        }
        try {
            lastTransferTimePrev = Number(existing.lastTransferTime ?? 0);
        }
        catch {
            lastTransferTimePrev = 0;
        }
        try {
            volatilityPrev = Number(existing.volatilityScore ?? 0);
        }
        catch {
            volatilityPrev = 0;
        }
        try {
            momentumPrev = Number(existing.momentumScore ?? 0);
        }
        catch {
            momentumPrev = 0;
        }
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
    };
    const volatilityNext = calculateSimpleVolatility(metricsTemp);
    const momentumNext = calculateSimpleMomentum({ ...metricsTemp, totalVolume: totalVolumeNext });
    const toStore = {
        id: metricId,
        tokenAddress,
        tokenSymbol,
        totalVolume: totalVolumeNext.toString(),
        transferCount: transferCountNext,
        lastTransferTime: lastTransferTimeNext,
        hourlyVolume: hourlyVolumeNext.toString(),
        dailyVolume: dailyVolumeNext.toString(),
        volatilityScore: volatilityNext,
        momentumScore: momentumNext,
    };
    context.TokenMetrics.set(toStore);
}
function getTokenSymbol(address) {
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
        case TRACKED_TOKENS.PINGU.toLowerCase():
            return "PINGU";
        case TRACKED_TOKENS.OCTO.toLowerCase():
            return "OCTO";
        case TRACKED_TOKENS.KB.toLowerCase():
            return "KB";
        case TRACKED_TOKENS.WSOL.toLowerCase():
            return "WSOL";
        default:
            return "UNKNOWN";
    }
}
// Helper: minimum index threshold per token symbol
function getMinIndexThreshold(symbol) {
    const map = MIN_INDEX_THRESHOLDS;
    // Default to 1 MON for unknown tokens to avoid indexing dust
    return map[symbol] ?? (1n * 10n ** 18n);
}
// Helper: whale threshold per token symbol
function getWhaleThreshold(symbol) {
    const map = WHALE_THRESHOLDS;
    // Very large fallback to avoid flagging unknown tokens as whales
    return map[symbol] ?? (10n ** 30n);
}
function calculateSimpleVolatility(metrics) {
    // Simplified volatility based on transfer frequency and volume changes
    const volumeRatio = Number(metrics.hourlyVolume) / (Number(metrics.dailyVolume) || 1);
    return Math.min(volumeRatio * 100, 100); // Cap at 100
}
function calculateSimpleMomentum(metrics) {
    // Simplified momentum based on recent activity vs historical
    const recentActivity = Number(metrics.hourlyVolume);
    const baseActivity = Number(metrics.totalVolume) / (metrics.transferCount || 1);
    const momentum = (recentActivity / (baseActivity || 1) - 1) * 100;
    return Math.max(-100, Math.min(100, momentum)); // Clamp between -100 and 100
}
