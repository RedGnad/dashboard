import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import { writeFileSync, mkdirSync, existsSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publicClient, monadTestnet, bundlerClient } from './clients'
import { startJob, stopJob, runNow, getJobs } from './scheduler'
import { decodeErrorResult } from 'viem'
import { runOnceForDelegator } from './runner'
import { buildDebugBundle } from './utils/debug'
import { Implementation, toMetaMaskSmartAccount, getDeleGatorEnvironment } from '@metamask/delegation-toolkit'
import { privateKeyToAccount } from 'viem/accounts'
import { USDC, UNISWAP_V2_ROUTER02, WMON } from './constants'

const app = express()
app.use(cors({ origin: true }))
app.use(express.json({ limit: '256kb' }))
// In-memory log buffer to expose logs via HTTP for convenience
const LOG_BUFFER: string[] = []
function pushLog(prefix: string, args: any[]) {
  try {
    const ts = new Date().toISOString()
    const line = `${ts} ${prefix} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`
    LOG_BUFFER.push(line)
    if (LOG_BUFFER.length > 500) LOG_BUFFER.shift()
  } catch {}
}
// Patch console to also write to buffer (non-invasive)
const _log = console.log.bind(console)
console.log = (...args: any[]) => {
  pushLog('[log]', args)
  _log(...args)
}
const _error = console.error.bind(console)
console.error = (...args: any[]) => {
  pushLog('[err]', args)
  _error(...args)
}
// Simple request logger
app.use((req, _res, next) => {
  const start = Date.now()
  const id = Math.random().toString(36).slice(2, 8)
  console.log(`[api] >> ${id} ${req.method} ${req.path}`)
  ;(req as any).__reqId = id
  _res.on('finish', () => {
    console.log(`[api] << ${id} ${req.method} ${req.path} ${_res.statusCode} ${Date.now() - start}ms`)
  })
  next()
})

let cachedDelegate: { eoa: string; sa: string; envSupported?: boolean } | null = null
// Root landing page for quick sanity check
app.get('/', (_req, res) => {
  res.json({ ok: true, name: 'DCA API', endpoints: ['/api/health', '/api/delegate', '/api/diag'] })
})
app.get('/api/health', (_req, res) => res.json({ ok: true }))
// View recent logs in the browser (last 200 lines by default)
app.get('/api/_logs', (req, res) => {
  const n = Math.min(Number(req.query.n ?? 200), 500)
  const tail = LOG_BUFFER.slice(-n)
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.send(tail.join('\n'))
})
app.get('/api/delegate', async (_req, res) => {
  try {
    if (!cachedDelegate) {
      const pk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}`
      if (!pk) return res.status(500).json({ error: 'Missing DELEGATE_PRIVATE_KEY' })
      const eoa = privateKeyToAccount(pk)
      let env: any | undefined
      try {
        env = getDeleGatorEnvironment(monadTestnet.id)
      } catch (err) {
        console.warn('[delegation] Environment not found for chain', monadTestnet.id, err)
      }
      const sa = await toMetaMaskSmartAccount({
        client: publicClient,
        implementation: Implementation.Hybrid,
        deployParams: [eoa.address, [], [], []],
        deploySalt: '0x',
        signer: { account: eoa },
        ...(env ? { environment: env } : {}),
      })
      cachedDelegate = { eoa: eoa.address, sa: sa.address, envSupported: !!env }
    }
    return res.json(cachedDelegate)
  } catch (e: any) {
    console.error('GET /api/delegate failed:', e)
    return res.status(500).json({ error: e?.message || 'failed', stack: e?.stack })
  }
})

// Quick diagnostics: balances and router quote for the given delegator smart account
app.get('/api/diag', async (req, res) => {
  try {
    const delegator = (req.query.delegator as string | undefined) as `0x${string}` | undefined
    const amount = BigInt((req.query.amountUsdc as string | undefined) ?? '1000000') // 1 USDC default (6 decimals)
    const out: any = { chainId: monadTestnet.id }
    // Ensure delegate SA is available
    if (!cachedDelegate) {
      const pk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}`
      if (pk) {
        const eoa = privateKeyToAccount(pk)
        let env: any | undefined
        try { env = getDeleGatorEnvironment(monadTestnet.id) } catch {}
        const sa = await toMetaMaskSmartAccount({
          client: publicClient,
          implementation: Implementation.Hybrid,
          deployParams: [eoa.address, [], [], []],
          deploySalt: '0x',
          signer: { account: eoa },
          ...(env ? { environment: env } : {}),
        })
        cachedDelegate = { eoa: eoa.address, sa: sa.address, envSupported: !!env }
      }
    }
    out.delegate = cachedDelegate || null
    // Add delegate balances if available
    try {
      if (cachedDelegate?.sa) {
        const [balMon, balToken] = await Promise.all([
          publicClient.getBalance({ address: cachedDelegate.sa as `0x${string}` }),
          publicClient.readContract({
            address: USDC,
            abi: [ { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] } ] as any,
            functionName: 'balanceOf',
            args: [cachedDelegate.sa as `0x${string}`],
          }) as Promise<bigint>,
        ])
        out.delegateBalances = { mon: balMon.toString(), usdc: (balToken as bigint).toString() }
      }
    } catch (e: any) {
      out.delegateBalancesError = String(e?.message || e)
    }
    if (delegator) {
      out.delegator = delegator
      try {
        const [balMon, balToken] = await Promise.all([
          publicClient.getBalance({ address: delegator }),
          publicClient.readContract({
            address: USDC,
            abi: [ { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] } ] as any,
            functionName: 'balanceOf',
            args: [delegator],
          }) as Promise<bigint>,
        ])
        out.delegatorBalances = { mon: balMon.toString(), usdc: (balToken as bigint).toString() }
      } catch (e: any) {
        out.delegatorBalancesError = String(e?.message || e)
      }
    }
    // Paymaster-independent router quote (if pool exists)
    try {
      const amounts = await publicClient.readContract({
        address: UNISWAP_V2_ROUTER02,
        abi: [
          { name: 'getAmountsOut', type: 'function', stateMutability: 'view', inputs: [ { name: 'amountIn', type: 'uint256' }, { name: 'path', type: 'address[]' } ], outputs: [{ name: 'amounts', type: 'uint256[]' }] },
        ] as any,
        functionName: 'getAmountsOut',
        args: [amount, [USDC, WMON]],
      }) as bigint[]
      out.quote = { in: amount.toString(), out: (amounts?.[1] as bigint | undefined)?.toString() }
    } catch (e: any) {
      out.quoteError = String(e?.message || e)
    }
  return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'diag failed' })
  }
})

app.post('/api/delegations', async (req, res) => {
  const { delegatorSA, signedDelegation, job } = req.body || {}
  if (!delegatorSA || !signedDelegation) return res.status(400).json({ error: 'Missing delegatorSA or signedDelegation' })
  const dir = join(process.cwd(), 'data', 'delegations')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${delegatorSA}.json`), JSON.stringify({ delegatorSA, signedDelegation, job }, null, 2))
  console.log('[api/delegations] intake', {
    delegatorSA,
    hasSigned: !!signedDelegation,
    signedShape: {
      hasDelegation: !!signedDelegation?.delegation,
      hasSignature: !!signedDelegation?.signature,
      caveats: Array.isArray(signedDelegation?.delegation?.caveats) ? signedDelegation.delegation.caveats.length : 'n/a',
      saltType: typeof signedDelegation?.delegation?.salt,
    },
    jobKeys: Object.keys(job || {}),
  })
  try {
    const uo = await runOnceForDelegator(delegatorSA)
    // If intervalSec provided, auto-start scheduler
    let startedJob: any = null
    const iv = Number(job?.intervalSec)
    if (!Number.isNaN(iv) && iv > 0) {
      // Default to 24h duration unless specified; trigger immediate next tick optional via job.immediate
      const durationSec = Number(job?.durationSec) > 0 ? Number(job?.durationSec) : 24 * 60 * 60
      const immediate = Boolean(job?.immediate ?? false)
      startedJob = startJob(delegatorSA, Math.max(10, iv), { durationSec, immediate })
    }
    return res.json({ ok: true, userOperationHash: uo, job: startedJob })
  } catch (e: any) {
    console.error('DCA execution failed:', e?.message)
    if (e?.debugBundle) console.error('DCA debug:', JSON.stringify(e.debugBundle, null, 2))
    const errorObj: any = { ok: false, error: e?.message || 'execution failed' }
    if (e?.walk?.() || e?.details || e?.shortMessage) {
      errorObj.details = e.details || e.shortMessage
    }
    if (e?.cause) errorObj.cause = String(e.cause)
    if (e?.stack) errorObj.stack = e.stack
    // Attach last debug context if present
    if (e?.debugBundle) errorObj.debug = e.debugBundle
    // Try to decode a readable revert string if present
    try {
      const match = /0x08c379a0[0-9a-fA-F]*/.exec(String(e?.details || e?.cause || ''))
      if (match) {
        const decoded = decodeErrorResult({
          data: match[0] as `0x${string}`,
          abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }] as const,
        }) as any
        const reason = decoded?.args?.[0]
        if (typeof reason === 'string') errorObj.revertReason = reason
      }
    } catch {}
    return res.status(500).json(errorObj)
  }
})

// Check if a signed delegation exists for a delegator smart account
// GET /api/delegations/:delegatorSA
app.get('/api/delegations/:delegatorSA', async (req, res) => {
  try {
    const delegatorSA = (req.params.delegatorSA || '').toLowerCase()
    if (!delegatorSA.startsWith('0x') || delegatorSA.length !== 42) {
      return res.status(400).json({ error: 'Invalid delegatorSA' })
    }
    const dir = join(process.cwd(), 'data', 'delegations')
    const file = join(dir, `${delegatorSA}.json`)
    const exists = existsSync(file)
    const out: any = { ok: true, exists }
    if (exists) {
      try {
        const st = statSync(file)
        out.updatedAt = st.mtimeMs
        const raw = readFileSync(file, 'utf8')
        const json = JSON.parse(raw)
        if (json?.job) out.job = json.job
      } catch {}
    }
    return res.json(out)
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'check failed' })
  }
})

// Resolve a userOperation hash to its receipt/transaction hash via the bundler
// GET /api/userop/:hash?waitMs=15000
app.get('/api/userop/:hash', async (req, res) => {
  try {
    const hash = (req.params.hash || '').toLowerCase() as `0x${string}`
    if (!hash || !hash.startsWith('0x') || hash.length !== 66) {
      return res.status(400).json({ error: 'Invalid userOperation hash' })
    }
    const waitMs = Math.min(Number(req.query.waitMs ?? 0), 60000)
    const started = Date.now()
    async function fetchOnce() {
      try {
        const receipt: any = await (bundlerClient as any).request?.({
          method: 'eth_getUserOperationReceipt',
          params: [hash],
        })
        return receipt
      } catch (e: any) {
        return { error: String(e?.message || e) }
      }
    }
    let receipt = await fetchOnce()
    if (!receipt && waitMs > 0) {
      // Poll every 1s until timeout
      while (!receipt && Date.now() - started < waitMs) {
        await new Promise((r) => setTimeout(r, 1000))
        receipt = await fetchOnce()
      }
    }
    if (!receipt) return res.json({ ok: true, hash, found: false, pending: true })
    // Normalize output
    const txHash = receipt?.receipt?.transactionHash || receipt?.transactionHash || null
    const blockNumber = receipt?.receipt?.blockNumber || null
    const status = receipt?.receipt?.status ?? null
    return res.json({ ok: true, hash, found: true, txHash, blockNumber, status, raw: receipt })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'lookup failed' })
  }
})

// Simple DCA job control endpoints
app.get('/api/jobs', (_req, res) => res.json({ ok: true, jobs: getJobs() }))
app.post('/api/jobs/start', async (req, res) => {
  const { delegatorSA, intervalSec, durationSec, immediate, expiresAtMs } = req.body || {}
  if (!delegatorSA) return res.status(400).json({ error: 'Missing delegatorSA' })
  const iv = Math.max(10, Number(intervalSec ?? 60))
  const j = startJob(delegatorSA, iv, {
    durationSec: typeof durationSec === 'number' ? durationSec : undefined,
    immediate: Boolean(immediate),
    expiresAtMs: typeof expiresAtMs === 'number' ? expiresAtMs : undefined,
  })
  return res.json({ ok: true, job: j })
})
app.post('/api/jobs/stop', async (req, res) => {
  const { delegatorSA } = req.body || {}
  if (!delegatorSA) return res.status(400).json({ error: 'Missing delegatorSA' })
  const j = stopJob(delegatorSA)
  if (!j) return res.status(404).json({ error: 'Job not found' })
  return res.json({ ok: true, job: j })
})
app.post('/api/jobs/run', async (req, res) => {
  const { delegatorSA } = req.body || {}
  if (!delegatorSA) return res.status(400).json({ error: 'Missing delegatorSA' })
  const j = await runNow(delegatorSA)
  if (!j) return res.status(404).json({ error: 'Job not found' })
  return res.json({ ok: true, job: j })
})

// Fallback 404 handler (always JSON)
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.path })
})

// Error handler (always JSON)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err)
  res.status(500).json({ error: err?.message || 'Internal Server Error' })
})

export function startServer(port = Number(process.env.PORT || 8787)) {
  // Default to 0.0.0.0 to avoid IPv4/IPv6 localhost pitfalls
  const host = process.env.HOST || '0.0.0.0'
  return app.listen(port, host as any, () => {
    console.log(`[boot] API listening on ${host}:${port}`)
    console.log(`[boot] RPC_URL=${process.env.RPC_URL}`)
    console.log(`[boot] BUNDLER=${process.env.ZERO_DEV_BUNDLER_RPC ? 'set' : 'missing'}`)
    console.log(`[boot] PAYMASTER=${process.env.ZERO_DEV_PAYMASTER_RPC ? 'set' : 'missing'}`)
  })
}
