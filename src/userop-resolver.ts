import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { bundlerClient } from './clients'
import { appendAudit } from './audit'

interface ExecuteEntryLite {
  ts: number
  action: string
  actionId: string
  chainId: number
  delegator: string
  delegate: string
  role: string
  structHash: string
  digest: string
  domainSeparator: string
  caveatsRoot: string
  salt: string
  warnings: string[]
  signatureModel: string
  runId?: string
  userOperationHash?: string
  // txHash absent in unresolved
}

const AUDIT_FILE = join(process.cwd(), 'data', 'delegations', 'audit.log')
const lastAttempt: Record<string, number> = {}

function parseAuditFile(): { unresolved: ExecuteEntryLite[] } {
  const unresolved: ExecuteEntryLite[] = []
  if (!existsSync(AUDIT_FILE)) return { unresolved }
  let raw: string
  try { raw = readFileSync(AUDIT_FILE, 'utf8') } catch { return { unresolved } }
  if (!raw.trim()) return { unresolved }
  const lines = raw.split('\n')
  const settled = new Set<string>()
  for (const line of lines) {
    if (!line) continue
    try {
      const j = JSON.parse(line)
      if (j?.action === 'userop_settled' && j.userOperationHash) {
        settled.add(String(j.userOperationHash).toLowerCase())
      }
    } catch {}
  }
  for (const line of lines) {
    if (!line) continue
    try {
      const j = JSON.parse(line)
      if (j?.action === 'execute' && j.userOperationHash && !j.txHash) {
        const uo = String(j.userOperationHash).toLowerCase()
        if (settled.has(uo)) continue
        unresolved.push(j as ExecuteEntryLite)
      }
    } catch {}
  }
  return { unresolved }
}

async function resolveBatch(batch: ExecuteEntryLite[]) {
  for (const entry of batch) {
    const uo = (entry.userOperationHash || '').toLowerCase()
    if (!uo) continue
    const now = Date.now()
    if (lastAttempt[uo] && now - lastAttempt[uo] < 30_000) continue // throttle 30s
    lastAttempt[uo] = now
    try {
      const receipt: any = await (bundlerClient as any).request?.({ method: 'eth_getUserOperationReceipt', params: [uo] })
      if (!receipt) continue
      const txHash = receipt?.receipt?.transactionHash || receipt?.transactionHash || null
      const blockNumber = receipt?.receipt?.blockNumber || null
      if (txHash) {
        appendAudit({
          ts: Date.now(),
            action: 'userop_settled',
            delegator: entry.delegator,
            delegate: entry.delegate,
            role: entry.role || 'core',
            structHash: entry.structHash,
            digest: entry.digest,
            domainSeparator: entry.domainSeparator,
            caveatsRoot: entry.caveatsRoot,
            salt: entry.salt,
            warnings: [],
            signatureModel: entry.signatureModel || 'UNKNOWN',
            runId: entry.runId,
            userOperationHash: entry.userOperationHash,
            txHash,
            blockNumber: blockNumber ? String(blockNumber) : undefined,
        })
        // small log
        console.log('[userop-resolver] settled', { userOperationHash: uo, txHash, blockNumber })
      }
    } catch (e: any) {
      // silent; will retry later
      console.warn('[userop-resolver] resolve failed', uo, e?.message || e)
    }
  }
}

export function startUserOpResolver() {
  if (process.env.DISABLE_USEROP_RESOLVER === '1') {
    console.log('[userop-resolver] disabled via env')
    return
  }
  const intervalMs = Number(process.env.USEROP_RESOLVER_INTERVAL_MS || 15000)
  const batchSize = Number(process.env.USEROP_RESOLVER_BATCH_SIZE || 5)
  setInterval(async () => {
    try {
      const { unresolved } = parseAuditFile()
      if (unresolved.length === 0) return
      const slice = unresolved.slice(0, batchSize)
      await resolveBatch(slice)
    } catch (e: any) {
      console.warn('[userop-resolver] cycle failed', e?.message || e)
    }
  }, intervalMs).unref()
  console.log('[userop-resolver] started', { intervalMs })
}
