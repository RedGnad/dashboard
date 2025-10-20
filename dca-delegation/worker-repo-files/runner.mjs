#!/usr/bin/env node
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

function requireEnv(name) {
  const v = process.env[name]
  if (!v) console.warn(`[worker] Missing ${name}`)
  return v
}

function readPlan() {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const planPath = path.join(__dirname, 'plan.json')
  try {
    const raw = fs.readFileSync(planPath, 'utf-8')
    const plan = JSON.parse(raw)
    return { plan, planPath }
  } catch (e) {
    console.warn('[worker] Plan not found, creating default')
    const plan = { 
      mode: 'ai', 
      intervalSeconds: 300, 
      amountMon: '0.05', 
      slippageBps: 300, 
      outToken: 'USDC', 
      nextExecution: 0, 
      lastRunAt: 0 
    }
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2))
    return { plan, planPath }
  }
}

function writePlan(planPath, plan) {
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2))
}

async function maybeExecute(plan) {
  const nowSec = Math.floor(Date.now() / 1000)
  if (!plan.nextExecution || plan.nextExecution === 0) {
    plan.nextExecution = nowSec
  }
  if (nowSec < plan.nextExecution) {
    console.log(`[worker] Not due yet. Next at ${new Date(plan.nextExecution * 1000).toISOString()}`)
    return false
  }
  
  console.log('[worker] Executing DCA cycle…')
  
  // TODO: Implement actual DCA logic here:
  // 1. Read delegations from data/delegations/*.json
  // 2. Check balances and metrics
  // 3. Make AI decisions or follow manual config
  // 4. Execute swaps via Delegation Toolkit
  
  await new Promise((r) => setTimeout(r, 250))
  
  plan.lastRunAt = nowSec
  plan.nextExecution = nowSec + Math.max(10, Number(plan.intervalSeconds || 60))
  console.log(`[worker] Done. Next at ${new Date(plan.nextExecution * 1000).toISOString()}`)
  return true
}

async function main() {
  const startedAt = new Date().toISOString()
  console.log(`[worker] DCA Worker start at ${startedAt}`)

  const rpc = requireEnv('VITE_RPC_URL')
  const bundler = requireEnv('VITE_ZERO_DEV_BUNDLER_RPC')
  const paymaster = requireEnv('VITE_ZERO_DEV_PAYMASTER_RPC')
  const delegatePk = requireEnv('VITE_DELEGATE_PRIVATE_KEY')

  if (!rpc || !bundler || !paymaster || !delegatePk) {
    console.log('[worker] Environment incomplete. Exiting gracefully.')
    return
  }

  const { plan, planPath } = readPlan()
  const executed = await maybeExecute(plan)
  if (executed) writePlan(planPath, plan)
}

main().catch((e) => {
  console.error('[worker] Unhandled error:', e)
  process.exitCode = 1
})
