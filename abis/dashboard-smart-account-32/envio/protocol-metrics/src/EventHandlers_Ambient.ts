// @ts-nocheck
/*
 * Ambient handlers: on chaque event, on met à jour DailyMetrics (protocolId = "ambient").
 * On n'écrit pas d'entités d'events bruts car elles ne sont pas déclarées dans le schema.graphql.
 */
import { AmbientCore, DailyMetrics, DailyUser, ProtocolState, DailyTxFeeCounted } from "generated";

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
	const { protocolId, dateISO, user, txDelta = 1, txHash, feeWei } = args;
	const dailyId = `${protocolId}_${dateISO}`;
	const stateId = protocolId;

	// Unique user par jour
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

	// Cumul
	const stPrev = (await context.ProtocolState.get(stateId)) as ProtocolState | null;
	const txCumPrev = stPrev ? BigInt((stPrev as any).txCumulative) : 0n;
		const txCumNext = txCumPrev + BigInt(txDelta);
		const stNext: ProtocolState = { id: stateId, protocolId, txCumulative: txCumNext.toString() as any } as any;
	context.ProtocolState.set(stNext);

	// Upsert DailyMetrics
	const dmPrev = (await context.DailyMetrics.get(dailyId)) as DailyMetrics | null;
	const usersDailyPrev = dmPrev ? Number((dmPrev as any).usersDaily) : 0;
	const txDailyPrev = dmPrev ? Number((dmPrev as any).txDaily) : 0;
		const sumFeeWeiPrev = dmPrev && (dmPrev as any).sumFeeWei ? BigInt((dmPrev as any).sumFeeWei) : 0n;
		const feeTxCountPrev = dmPrev && (dmPrev as any).feeTxCount ? Number((dmPrev as any).feeTxCount) : 0;
	const usersDaily = usersDailyPrev + userAdded;
	const txDaily = txDailyPrev + txDelta;
		// Dedup per tx for fee counting
		let sumFeeWeiNext = sumFeeWeiPrev;
		let feeTxCountNext = feeTxCountPrev;
		if (txHash && feeWei != null) {
			const feeId = `${protocolId}_${dateISO}_${txHash.toLowerCase()}`;
			const already = await context.DailyTxFeeCounted.get(feeId);
			if (!already) {
				const feeRec: DailyTxFeeCounted = {
					id: feeId,
					protocolId,
					dateISO,
					txHash: txHash.toLowerCase(),
					feeWei: feeWei.toString() as any,
				} as any;
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

// Tous les events AmbientCore utilisent la même agrégation simple
AmbientCore?.CrocSwap?.handler?.(async ({ event, context }) => {
	const tsMs = Number(event.block.timestamp) * 1000;
	const dateISO = dateISOFromTs(tsMs);
		// Utilise uniquement l'adresse de l'émetteur de la transaction pour compter les utilisateurs
		const from = (event.transaction?.from as string) || null;
		const userKey = from || null;
		// Try read fee (effectiveGasPrice * gasUsed) if receipt available in handler context
		const txHash = (event.transaction?.hash as string) || null;
			// With field_selection.transaction_fields enabled in config.yaml, use transaction gas fields
			const gasUsed = (event.transaction as any)?.gasUsed ? BigInt((event.transaction as any).gasUsed) : null;
			const effPrice = (event.transaction as any)?.effectiveGasPrice
				? BigInt((event.transaction as any).effectiveGasPrice)
				: (event.transaction as any)?.gasPrice
					? BigInt((event.transaction as any).gasPrice)
					: null;
		const feeWei = gasUsed != null && effPrice != null ? gasUsed * effPrice : null;
		await upsertDaily(context, {
		protocolId: "ambient",
		dateISO,
		user: userKey,
			txDelta: 1,
			txHash,
			feeWei,
	});
});

AmbientCore?.CrocMicroSwap?.handler?.(async ({ event, context }) => {
	const tsMs = Number(event.block.timestamp) * 1000;
	const dateISO = dateISOFromTs(tsMs);
		const from = (event.transaction?.from as string) || null;
		const userKey = from || null;
		const txHash2 = (event.transaction?.hash as string) || null;
			const gasUsed2 = (event.transaction as any)?.gasUsed ? BigInt((event.transaction as any).gasUsed) : null;
			const effPrice2 = (event.transaction as any)?.effectiveGasPrice
				? BigInt((event.transaction as any).effectiveGasPrice)
				: (event.transaction as any)?.gasPrice
					? BigInt((event.transaction as any).gasPrice)
					: null;
		const feeWei2 = gasUsed2 != null && effPrice2 != null ? gasUsed2 * effPrice2 : null;
		await upsertDaily(context, {
		protocolId: "ambient",
		dateISO,
		user: userKey,
			txDelta: 1,
			txHash: txHash2,
			feeWei: feeWei2,
	});
});

// Note: We only register handlers for the two events declared in config.yaml

