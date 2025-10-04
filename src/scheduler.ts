import type { Address } from 'viem'
import { runOnceForDelegator, flushTokenForDelegator } from './runner'
import { WMON } from './constants'

export type JobStatus = {
  delegatorSA: Address
  intervalSec: number
  active: boolean
  lastRunAt?: number
  lastOpHash?: `0x${string}`
  lastError?: string
  // Optional expiration timestamp (ms since epoch); when reached, job auto-stops
  expiresAt?: number
  // Number of successful runOnceForDelegator calls completed while active
  runsDone?: number
}

type InternalJob = JobStatus & {
  _timer?: NodeJS.Timeout
  _running?: boolean
}

const jobs: Record<string, InternalJob> = {}

function schedule(job: InternalJob) {
  if (job._timer) clearInterval(job._timer)
  if (!job.active) return
  console.log('[scheduler] start', { delegatorSA: job.delegatorSA, intervalSec: job.intervalSec })
  const tick = async () => {
    // Auto-stop if expired
    if (job.expiresAt && Date.now() >= job.expiresAt) {
      job.active = false
      if (job._timer) clearInterval(job._timer)
      job._timer = undefined
      console.log('[scheduler] expired', { delegatorSA: job.delegatorSA })
      // Attempt to sweep WMON → EOA at end of window if job exists on disk and EOA known
      try {
        const fs = await import('node:fs')
        const path = await import('node:path')
        const file = path.join(process.cwd(), 'data', 'delegations', `${job.delegatorSA}.json`)
        if (fs.existsSync(file)) {
          const raw = fs.readFileSync(file, 'utf8')
          const json = JSON.parse(raw)
          const eoa = json?.job?.ownerEOA as any
          if (eoa) {
            console.log('[scheduler] flushing WMON to EOA at end of cycle…')
            await flushTokenForDelegator(job.delegatorSA, WMON as any, eoa, 'all')
          }
        }
      } catch (e) {
        console.warn('[scheduler] end-of-cycle flush failed', e)
      }
      return
    }
    if (job._running) return
    console.log('[scheduler] tick', { delegatorSA: job.delegatorSA })
    job._running = true
    try {
      const hash = await runOnceForDelegator(job.delegatorSA)
      job.lastRunAt = Date.now()
      job.lastOpHash = hash
      job.lastError = undefined
      job.runsDone = (job.runsDone || 0) + 1
    } catch (e: any) {
      job.lastRunAt = Date.now()
      job.lastError = e?.message || String(e)
    } finally {
      job._running = false
    }
  }
  job._timer = setInterval(tick, Math.max(5, job.intervalSec) * 1000)
}

export function startJob(
  delegatorSA: Address,
  intervalSec: number,
  opts?: { durationSec?: number; immediate?: boolean; expiresAtMs?: number }
): JobStatus {
  const key = delegatorSA.toLowerCase()
  const existing = jobs[key]
  const now = Date.now()
  const expiresAt = opts?.expiresAtMs
    ? opts.expiresAtMs
    : (opts?.durationSec && opts.durationSec > 0 ? now + opts.durationSec * 1000 : undefined)
  const job: InternalJob = existing
    ? { ...existing, intervalSec, active: true, expiresAt }
    : { delegatorSA, intervalSec, active: true, expiresAt, runsDone: 0 }
  jobs[key] = job
  // Toujours réinitialiser lastRunAt lors d'un nouveau start pour un timer cohérent
  // Sauf si immediate=true, auquel cas on laisse runOnceForDelegator le mettre à jour
  if (!opts?.immediate) {
    job.lastRunAt = Date.now()
  } else {
    // Pour immediate=true, on remet à zéro pour que l'exécution immédiate définisse le timing
    job.lastRunAt = undefined
  }
  schedule(job)
  // Optional immediate tick on start
  if (opts?.immediate) {
    // Fire and forget; interval will continue afterwards
    Promise.resolve().then(async () => {
      if (!job.active) return
      try {
        const hash = await runOnceForDelegator(job.delegatorSA)
        job.lastRunAt = Date.now()
        job.lastOpHash = hash
        job.lastError = undefined
        job.runsDone = (job.runsDone || 0) + 1
      } catch (e: any) {
        job.lastRunAt = Date.now()
        job.lastError = e?.message || String(e)
      }
    })
  }
  return publicStatus(job)
}

export function stopJob(delegatorSA: Address): JobStatus | null {
  const key = delegatorSA.toLowerCase()
  const job = jobs[key]
  if (!job) return null
  job.active = false
  if (job._timer) clearInterval(job._timer)
  job._timer = undefined
  // Réinitialiser le timer : supprimer lastRunAt pour que le prochain start reparte de 0
  job.lastRunAt = undefined
  job.lastError = undefined
  console.log('[scheduler] stop + reset timer', { delegatorSA })
  return publicStatus(job)
}

export function runNow(delegatorSA: Address): Promise<JobStatus | null> {
  const key = delegatorSA.toLowerCase()
  const job = jobs[key]
  if (!job) return Promise.resolve(null)
  return (async () => {
    try {
      const hash = await runOnceForDelegator(job.delegatorSA)
      job.lastRunAt = Date.now()
      job.lastOpHash = hash
      job.lastError = undefined
    } catch (e: any) {
      job.lastRunAt = Date.now()
      job.lastError = e?.message || String(e)
    }
    return publicStatus(job)
  })()
}

export function getJobs(): JobStatus[] {
  return Object.values(jobs).map(publicStatus)
}

function publicStatus(job: InternalJob): JobStatus {
  const { delegatorSA, intervalSec, active, lastRunAt, lastOpHash, lastError, expiresAt, runsDone } = job
  return { delegatorSA, intervalSec, active, lastRunAt, lastOpHash, lastError, expiresAt, runsDone }
}
