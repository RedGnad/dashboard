/*
  Envio Event Handlers for Monad Testnet Protocol Metrics
  Aggregates at indexing time: daily unique users, tx count, cumulative, avg tx/user, fees.
*/

// Types will be provided by Envio codegen in the indexer environment.
// Use 'any' here to avoid workspace type errors when not running Envio toolchain.
type DailyMetricsEntity = any
type DailyUserEntity = any
type ProtocolStateEntity = any

function dateISOFromTs(tsSec: number): string {
  return new Date(tsSec * 1000).toISOString().slice(0, 10)
}

function ensureDaily(metrics: DailyMetricsEntity | null, id: string, protocolId: string, dateISO: string): DailyMetricsEntity {
  if (metrics) return metrics
  return { id, protocolId, dateISO, usersDaily: 0, txDaily: 0, txCumulative: 0n, avgTxPerUser: 0, feeSum: 0n, feeCount: 0, avgFeeNative: 0 }
}

async function upsertTx(protocolId: string, dateISO: string, user: string | null, context: any, gasUsed?: bigint, gasPrice?: bigint) {
  const dId = `${protocolId}-${dateISO}`
  const uId = user ? `${protocolId}-${dateISO}-${user.toLowerCase()}` : null
  const existing = await context.DailyMetrics.get(dId)
  let dm = ensureDaily(existing, dId, protocolId, dateISO)
  // tx count
  dm.txDaily = (dm.txDaily || 0) + 1
  // unique user
  if (uId) {
    const seen = await context.DailyUser.get(uId)
    if (!seen) {
      await context.DailyUser.set({ id: uId, protocolId, dateISO, user: user!.toLowerCase() })
      dm.usersDaily = (dm.usersDaily || 0) + 1
    }
  }
  // cumulative
  const psId = protocolId
  const ps = (await context.ProtocolState.get(psId)) || { id: psId, txCumulative: 0n }
  ps.txCumulative = BigInt(ps.txCumulative || 0n) + 1n
  dm.txCumulative = ps.txCumulative
  // fees
  if (gasUsed != null && gasPrice != null) {
    dm.feeSum = (dm.feeSum || 0n) + (gasUsed * gasPrice)
    dm.feeCount = (dm.feeCount || 0) + 1
    dm.avgFeeNative = dm.feeCount > 0 ? Number(dm.feeSum) / dm.feeCount : 0
  }
  dm.avgTxPerUser = (dm.usersDaily || 0) > 0 ? dm.txDaily / dm.usersDaily : 0
  await context.DailyMetrics.set(dm)
  await context.ProtocolState.set(ps)
}

// Map contract name to protocol id. You can customize per-contract names.
function protocolIdFromContract(name: string): string {
  // Example: collapse everything under the contract name
  return name
}

// Generic handler for various events; we only need tx.from, gasUsed, gasPrice, block.timestamp
export const ERC20 = {
  Transfer: {
    handler: async ({ event, context }: any) => {
      const protocolId = protocolIdFromContract(event.contractName)
      const dateISO = dateISOFromTs(event.block.timestamp)
      const gasUsed = event.receipt?.gasUsed as bigint | undefined
      const gasPrice = (event.transaction as any)?.gasPrice as bigint | undefined
      const from = (event.transaction?.from || '').toLowerCase()
  await upsertTx(protocolId, dateISO, from || null, context, gasUsed, gasPrice)
    },
  },
}

export const UniswapV2 = {
  Swap: {
    handler: async ({ event, context }: any) => {
      const protocolId = protocolIdFromContract(event.contractName)
      const dateISO = dateISOFromTs(event.block.timestamp)
      const gasUsed = event.receipt?.gasUsed as bigint | undefined
      const gasPrice = (event.transaction as any)?.gasPrice as bigint | undefined
      const from = (event.transaction?.from || '').toLowerCase()
  await upsertTx(protocolId, dateISO, from || null, context, gasUsed, gasPrice)
    },
  },
}

export const WETH9 = {
  Deposit: {
    handler: async ({ event, context }: any) => {
      const protocolId = protocolIdFromContract(event.contractName)
      const dateISO = dateISOFromTs(event.block.timestamp)
      const gasUsed = event.receipt?.gasUsed as bigint | undefined
      const gasPrice = (event.transaction as any)?.gasPrice as bigint | undefined
      const from = (event.transaction?.from || '').toLowerCase()
  await upsertTx(protocolId, dateISO, from || null, context, gasUsed, gasPrice)
    },
  },
  Withdrawal: {
    handler: async ({ event, context }: any) => {
      const protocolId = protocolIdFromContract(event.contractName)
      const dateISO = dateISOFromTs(event.block.timestamp)
      const gasUsed = event.receipt?.gasUsed as bigint | undefined
      const gasPrice = (event.transaction as any)?.gasPrice as bigint | undefined
      const from = (event.transaction?.from || '').toLowerCase()
  await upsertTx(protocolId, dateISO, from || null, context, gasUsed, gasPrice)
    },
  },
}

// Magma StakeManager — mirror WETH-like semantics for our metrics aggregation
export const magma = {
  Deposit: {
    handler: async ({ event, context }: any) => {
      const protocolId = protocolIdFromContract(event.contractName)
      const dateISO = dateISOFromTs(event.block.timestamp)
      const gasUsed = event.receipt?.gasUsed as bigint | undefined
      const gasPrice = (event.transaction as any)?.gasPrice as bigint | undefined
      const from = (event.transaction?.from || '').toLowerCase()
      await upsertTx(protocolId, dateISO, from || null, context, gasUsed, gasPrice)
    },
  },
  Withdraw: {
    handler: async ({ event, context }: any) => {
      const protocolId = protocolIdFromContract(event.contractName)
      const dateISO = dateISOFromTs(event.block.timestamp)
      const gasUsed = event.receipt?.gasUsed as bigint | undefined
      const gasPrice = (event.transaction as any)?.gasPrice as bigint | undefined
      const from = (event.transaction?.from || '').toLowerCase()
      await upsertTx(protocolId, dateISO, from || null, context, gasUsed, gasPrice)
    },
  },
}
