// @ts-nocheck
/*
 * Curvance handler: met à jour DailyMetrics (protocolId = "curvance") sur l'event Pump.
 */
import { Curvance, DailyMetrics, DailyUser, ProtocolState } from "generated";

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

Curvance.Pump.handler(async ({ event, context }) => {
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
	await upsertDaily(context, {
		protocolId: "curvance",
		dateISO,
		user: (event.params as any).account ?? null,
		txDelta: 1,
		txHash,
		feeWei,
	});
});

