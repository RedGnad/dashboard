#!/usr/bin/env tsx
// Orchestrated meta verification: audit chain, latest decision provenance, hyperindex, proof pack build+verify, guardrails.
// Exit code semantics: 0 all pass, 1 soft mismatch(s), 2 hard error.
import { execSync } from 'node:child_process'

type StepResult = { name: string; ok: boolean; detail?: string; soft?: boolean }

function run(name: string, cmd: string, expectRegex?: RegExp, soft?: boolean): StepResult {
  try {
    const out = execSync(cmd, { stdio: 'pipe' }).toString('utf8')
    if (expectRegex && !expectRegex.test(out)) {
      return { name, ok: false, detail: 'pattern_not_found', soft }
    }
    return { name, ok: true }
  } catch (e: any) {
    return { name, ok: false, detail: e?.message || 'exec_failed', soft }
  }
}

const steps: StepResult[] = []
steps.push(run('audit', 'npm run verify:audit --silent', /PASS|finalRollingHash/i))
steps.push(run('latest', 'npm run verify:latest --silent', /PASS|match/i))
steps.push(run('hyperindex', 'npm run verify:hyperindex --silent', /PASS|match/i, true))
steps.push(run('build-proof-pack', 'npm run build:proof-pack --silent', /packKeccak256/i))
// Resolve latest pack path under data/proof-packs if dist/last-pack.json.gz missing
import fs from 'node:fs'
import path from 'node:path'
let packPath = 'dist/last-pack.json.gz'
if (!fs.existsSync(packPath)) {
  const dir = path.join(process.cwd(), 'data', 'proof-packs')
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter(f=>f.endsWith('.json.gz')).sort()
    if (files.length) packPath = path.join(dir, files[files.length-1])
  }
}
steps.push(run('verify-proof-pack', `npm run verify:proof-pack --silent ${packPath}`, /OK|match/i))
// Guardrails: treat non-zero exit as soft fail but still parse output if present
steps.push(run('guardrails', 'npm run verify:guardrails --silent || true', /evaluation|blocked|warnings/i, true))
// Live divergence (soft): compare server-reported rolling hash with local audit
steps.push(run('live', 'npm run verify:live --silent || true', /live=/i, true))
// Replay latest ai_decision (soft): ensures deterministic recomputation
// Replay latest ai_decision: can be promoted to hard mode via env flag
const hardReplay = process.env.VERIFY_ALL_HARD_REPLAY === '1'
steps.push(run('replay-latest', 'npm run replay:decision --silent || true', /status=PASS|PASS strict-snapshot/i, !hardReplay))

// Determinism test (feature/model/action) using test-determinism script
const hardDet = process.env.VERIFY_ALL_HARD_DETERMINISM === '1'
steps.push(run('determinism', 'npm run test:determinism --silent || true', /PASS/, !hardDet))

const allHardOk = steps.filter(s => !s.soft).every(s => s.ok)
const anyHardFail = steps.filter(s => !s.soft).some(s => !s.ok)
const anySoftFail = steps.filter(s => s.soft).some(s => !s.ok)

console.log('[verify-all] results:')
for (const s of steps) {
  console.log(` - ${s.name}: ${s.ok ? 'OK' : 'FAIL'}${s.soft && !s.ok ? ' (soft)' : ''}${s.detail ? ' :: '+s.detail : ''}`)
}

if (anyHardFail) process.exit(2)
if (anySoftFail) process.exit(1)
if (allHardOk) process.exit(0)