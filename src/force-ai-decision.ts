#!/usr/bin/env tsx
/**
 * Force a new ai_decision via internal logic (same path as preview but persists to audit).
 * Usage: npm run force:decision -- --delegator 0xabc... --volatility 0.42
 */

function parseArgs(){
  const args = process.argv.slice(2)
  const out:any = {}
  for (let i=0;i<args.length;i++){
    const a=args[i]
    if(a==='--delegator'&&args[i+1]) out.delegator=args[++i]
    if(a==='--volatility'&&args[i+1]) out.volatility=args[++i]
    if(a==='--base'&&args[i+1]) out.base=args[++i]
  }
  return out
}
(async () => {
  const { delegator='0x', volatility='0.35', base='http://127.0.0.1:8787' } = parseArgs()
  const res = await fetch(base + '/api/strategy/decision/force', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ delegator, volatility }) })
  if(!res.ok){
    console.error('[force:decision] http_error', res.status)
    process.exit(1)
  }
  const js: any = await res.json()
  if(!js.ok){
    console.error('[force:decision] failed', js)
    process.exit(2)
  }
  console.log('[force:decision] ok', js)
})().catch(e=>{ console.error('[force:decision] fatal', e); process.exit(10) })
