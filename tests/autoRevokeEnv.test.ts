import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// This test launches a child process with an invalid AUTO_REVOKE_ABNORMAL_STREAK
// and inspects stdout + audit log tail to ensure it was forced to 1 and an audit line was written.

describe('auto-revoke env threshold validation', () => {
  it('forces invalid AUTO_REVOKE_ABNORMAL_STREAK to 1 and logs audit warning', () => {
    // Run server entry with invalid env but NO_API=1 (if code respects such a flag) to avoid long run; fallback kill soon.
  const env = { ...process.env, AUTO_REVOKE_ABNORMAL_STREAK: '0', NO_JOBS: '1' }
  const proc = spawnSync('npx', ['-y','tsx','src/server.ts'], { env, timeout: 4000, encoding: 'utf8' })
  // We do not require exit code 0; server likely still running when timeout kills it.
  // Try to detect explicit warning in output (best effort, but not mandatory if audit shows it)
  const combined = (proc.stdout || '') + (proc.stderr || '')
  const outputMention = /auto_revoke_threshold_adjusted|forced to 1/i.test(combined)

    // Inspect audit log tail
    const auditDir = path.join(process.cwd(), 'data', 'delegations')
    let found = false
    if (fs.existsSync(auditDir)) {
      const files = fs.readdirSync(auditDir).filter(f=>f.endsWith('.log'))
      for (const f of files) {
        const content = fs.readFileSync(path.join(auditDir,f),'utf8')
        const lines = content.trim().split(/\n/).slice(-20)
        if (lines.some(l => l.includes('auto_revoke_threshold_adjusted'))) {
            found = true; break
        }
      }
    }
    // Pass if either output mention OR audit line found (primary source of truth is audit)
    expect(outputMention || found).toBe(true)
  })
})
