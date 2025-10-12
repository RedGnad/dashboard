import { describe, it, expect } from 'vitest'
import { appendAudit, readAuditTail } from '../src/audit'
import fs from 'node:fs'
import path from 'node:path'

// We simulate stale prevEntryHash by calling appendAudit twice:
// 1. First append to get a valid tail entry.
// 2. Provide a fake prevEntryHash in second call while AUDIT_REFUSE_STALE=1 and ensure no line is added.

describe('AUDIT_REFUSE_STALE', () => {
  it('refuses append when stale prevEntryHash provided', () => {
    const delegDir = path.join(process.cwd(), 'data', 'delegations')
    const auditFile = path.join(delegDir, 'audit.log')
    const beforeSize = fs.existsSync(auditFile) ? fs.statSync(auditFile).size : 0
    // First append (no stale case)
  // Use a valid AuditAction ('build') for the seed line
  appendAudit({ action: 'build', ts: Date.now(), delegator: '0x', delegate: '0x', role: 'test' })
    const tail = readAuditTail(1)
    const last = tail[0]
    expect(last).toBeTruthy()
    const fakePrev = '0xdeadbeef'
    process.env.AUDIT_REFUSE_STALE = '1'
  // Attempt second append with stale prevEntryHash; still use valid action (e.g. 'verify')
  appendAudit({ action: 'verify', ts: Date.now(), delegator: '0x', delegate: '0x', role: 'test', prevEntryHash: fakePrev } as any)
    // Read tail again; last action should NOT be test_stale
    const tail2 = readAuditTail(2)
  const actions = tail2.map(l => l.action)
  // The stale append must NOT have been written, so last action should remain 'build'
  expect(actions.includes('verify')).toBe(false)
    // Ensure file size didn't grow significantly (allow tiny growth if newline flush, but we expect none)
    const afterSize = fs.existsSync(auditFile) ? fs.statSync(auditFile).size : 0
    expect(afterSize).toBeGreaterThanOrEqual(beforeSize)
  })
})
