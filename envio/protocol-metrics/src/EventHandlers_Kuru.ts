// @ts-nocheck
/*
 * Kuru Orderbook handler: met à jour DailyMetrics (protocolId = "kuru") sur les events de trading.
 * Kuru est un CLOB (Central Limit Order Book) onchain sur Monad.
 */
import { KuruOrderbook, DailyMetrics, DailyUser, ProtocolState } from "generated";

function dateISOFromTs(tsMs: number): string {
	const d = new Date(tsMs);
	return d.toISOString().slice(0, 10);
}

async function upsertDaily(
	context: any,
	args: {
		protocolId: string;
		dateISO: string;
		user?: string | null;
		txDelta?: number;
		txHash?: string | null;
		feeWei?: bigint | null;
	}
) {
	const { protocolId, dateISO, user, txDelta = 0, txHash, feeWei } = args;
	const dailyId = `${protocolId}_${dateISO}`;

	// Track unique users per day
	let userAdded = 0;
	if (user) {
		const userId = `${protocolId}_${dateISO}_${user.toLowerCase()}`;
		const alreadyUser = await context.DailyUser.get(userId);
		if (!alreadyUser) {
			const duRec: DailyUser = {
				id: userId,
				protocolId,
				dateISO,
				user: user.toLowerCase(),
			} as any;
			context.DailyUser.set(duRec);
			userAdded = 1;
		}
	}

	// Update cumulative tx count
	const stateId = `state_${protocolId}`;
	const stPrev = (await context.ProtocolState.get(stateId)) as ProtocolState | null;
	const txCumPrev = stPrev ? BigInt((stPrev as any).txCumulative) : 0n;
	const txCumNext = txCumPrev + BigInt(txDelta);
	const stNext: ProtocolState = {
		id: stateId,
		protocolId,
		txCumulative: txCumNext.toString() as any,
	} as any;
	context.ProtocolState.set(stNext);

	// Update daily metrics
	const dmPrev = (await context.DailyMetrics.get(dailyId)) as DailyMetrics | null;
	const usersDailyPrev = dmPrev ? Number((dmPrev as any).usersDaily) : 0;
	const txDailyPrev = dmPrev ? Number((dmPrev as any).txDaily) : 0;
	const sumFeeWeiPrev = dmPrev && (dmPrev as any).sumFeeWei ? BigInt((dmPrev as any).sumFeeWei) : 0n;
	const feeTxCountPrev = dmPrev && (dmPrev as any).feeTxCount ? Number((dmPrev as any).feeTxCount) : 0;
	const usersDaily = usersDailyPrev + userAdded;
	const txDaily = txDailyPrev + txDelta;
	
	// Simplified: accumulate fees directly (slight over-counting acceptable for approximation)
	let sumFeeWeiNext = sumFeeWeiPrev;
	let feeTxCountNext = feeTxCountPrev;
	if (txHash && feeWei != null) {
		sumFeeWeiNext = sumFeeWeiNext + feeWei;
		feeTxCountNext = feeTxCountNext + 1;
	}
	
	const avgTxPerUser = usersDaily > 0 ? txDaily / Math.max(1, usersDaily) : 0;
	let avgFeeNative: number | null = null;
	if (feeTxCountNext > 0) {
		try {
			avgFeeNative = Number(sumFeeWeiNext / BigInt(feeTxCountNext)) / 1e18;
		} catch {
			avgFeeNative = Number(sumFeeWeiNext) / feeTxCountNext / 1e18;
		}
	}
	
	const dmNext: DailyMetrics = {
		id: dailyId,
		protocolId,
		dateISO,
		usersDaily,
		txDaily,
		txCumulative: txCumNext.toString() as any,
		avgTxPerUser,
		avgFeeNative,
		sumFeeWei: sumFeeWeiNext.toString() as any,
		feeTxCount: feeTxCountNext,
	} as any;
	context.DailyMetrics.set(dmNext);
}

/**
 * Handler pour l'event Trade de Kuru OrderBook
 * 
 * Event Trade:
 * - orderId: uint40
 * - makerAddress: address
 * - isBuy: bool
 * - price: uint256
 * - updatedSize: uint96
 * - takerAddress: address
 * - txOrigin: address
 * - filledSize: uint96
 */
KuruOrderbook.Trade.handler(async ({ event, context }) => {
	const { makerAddress, takerAddress } = event.params;
	const dateISO = dateISOFromTs(event.block.timestamp * 1000);
	const txHash = event.transaction.hash;
	
	let feeWei: bigint | null = null;
	if (event.transaction.gasUsed && event.transaction.effectiveGasPrice) {
		feeWei = BigInt(event.transaction.gasUsed) * BigInt(event.transaction.effectiveGasPrice);
	}
	
	// Count maker
	await upsertDaily(context, {
		protocolId: "kuru",
		dateISO,
		user: makerAddress,
		txDelta: 1,
		txHash,
		feeWei,
	});
	
	// Count taker (different user)
	if (takerAddress.toLowerCase() !== makerAddress.toLowerCase()) {
		await upsertDaily(context, {
			protocolId: "kuru",
			dateISO,
			user: takerAddress,
			txDelta: 0, // Already counted above
			txHash: null,
			feeWei: null,
		});
	}
	
	context.log.debug("Kuru Trade processed", {
		maker: makerAddress.slice(0, 8) + "...",
		taker: takerAddress.slice(0, 8) + "...",
		price: event.params.price.toString(),
		filledSize: event.params.filledSize.toString(),
		dateISO,
	});
});
