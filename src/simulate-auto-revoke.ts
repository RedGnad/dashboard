import 'dotenv/config'
import { appendEvents } from './hyperindex/eventStore'
import fs from 'node:fs'
import path from 'node:path'

// Script combiné: génère anomalies HyperIndex puis appelle l'API décision jusqu'à auto-révocation.
// Usage: ts-node src/simulate-auto-revoke.ts --delegator 0x... [--streak 2] [--batchEvents 60] [--loopMax 5]
// Variables env alternatives: DELEGATOR, TARGET_STREAK, BATCH_EVENTS, LOOP_MAX

interface Args { delegator: string; targetStreak: number; batchEvents: number; loopMax: number; apiBase: string }

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const get = (k: string) => {
    const i = argv.indexOf('--'+k)
    return i >= 0 ? argv[i+1] : undefined
  }
  const delegator = (get('delegator') || process.env.DELEGATOR || '').toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(delegator)) throw new Error('Missing or invalid --delegator (0x...)')
  const targetStreak = Number(get('streak') || process.env.TARGET_STREAK || 2)
  const batchEvents = Number(get('batchEvents') || process.env.BATCH_EVENTS || 60)
  const loopMax = Number(get('loopMax') || process.env.LOOP_MAX || 6)
  const apiBase = process.env.API_BASE || 'http://127.0.0.1:8787'
  return { delegator, targetStreak, batchEvents, loopMax, apiBase }
}

async function injectAnomaly(batchEvents: number) {
  const now = Date.now()
  const events = [] as any[]
  for (let i=0;i<batchEvents;i++) {
    events.push({
      id: 'sim_transfer_'+now+'_'+i,
      ts: now - Math.floor(Math.random()* 2_000),
      chainId: 0,
      type: 'transfer',
      amountQuote: (Math.random()*5).toFixed(4),
      price: null,
    })
  }
  const added = appendEvents(events as any)
  return added
}

async function fetchJSON(url: string, opts?: RequestInit) {
  const r = await fetch(url, opts)
  let txt = await r.text()
  let js: any = {}
  try { js = txt ? JSON.parse(txt) : {} } catch {}
  if (!r.ok) throw new Error(js?.error || `HTTP ${r.status}`)
  return js
}

async function loopUntilRevoke(cfg: Args) {
  console.log('[auto-revoke] targetStreak =', cfg.targetStreak)
  for (let iter=1; iter<=cfg.loopMax; iter++) {
    console.log(`\n[auto-revoke] Iteration ${iter}/${cfg.loopMax}`)
    const added = await injectAnomaly(cfg.batchEvents)
    console.log(`[auto-revoke] Appended ${added} anomaly transfer events`)
    // Appel décision (force ou preview ? force pour audit) – on passe delegator dans body
    let decisionResp: any
    try {
      decisionResp = await fetch(cfg.apiBase + '/api/strategy/decision/force', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delegator: cfg.delegator, volatility: 0.5 })
      }).then(r => r.json()).catch(()=>({}))
    } catch (e:any) {
      console.warn('[auto-revoke] decision call failed', e?.message || e)
    }
    // Statut revocation
    let status: any = {}
    try {
      status = await fetch(cfg.apiBase + '/api/delegations/revocation/status?delegator=' + cfg.delegator).then(r=>r.json()).catch(()=>({}))
    } catch {}
    console.log('[auto-revoke] Status:', { revoked: status.revoked, abnormalStreak: status.abnormalStreak, decision: decisionResp?.ok ? 'ok' : decisionResp?.error })
    if (status.revoked) {
      console.log('[auto-revoke] Delegation REVOKED ✅')
      await showLastRevokeAuditLine()
      return
    }
    if ((status.abnormalStreak || 0) >= cfg.targetStreak) {
      console.log('[auto-revoke] Target streak reached mais pas de revoke ? (Verifier maybeAutoRevoke logique)')
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  console.log('[auto-revoke] Completed loop without revoke (augmenter loopMax ou vérifier guardrail)')
}

async function showLastRevokeAuditLine() {
  const auditFile = path.join(process.cwd(), 'data', 'audit.log')
  if (!fs.existsSync(auditFile)) { console.log('[auto-revoke] audit.log absent'); return }
  const lines = fs.readFileSync(auditFile, 'utf8').trim().split(/\n+/)
  for (let i=lines.length-1;i>=0;i--) {
    if (lines[i].includes('"action":"revoke"')) { console.log('\nDernière ligne revoke:\n'+lines[i]); return }
  }
  console.log('[auto-revoke] Aucune ligne revoke trouvée dans audit.log')
}

async function main() {
  const cfg = parseArgs()
  await loopUntilRevoke(cfg)
}

main().catch(e => { console.error(e); process.exit(1) })
