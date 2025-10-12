import fs from 'node:fs'
import path from 'node:path'

interface Stat {
  key: string
  count: number
  numeric: boolean
  min?: number
  max?: number
  distinct?: number
}

function isNumeric(v: any): v is number { return typeof v === 'number' && Number.isFinite(v) }

function main() {
  const auditFile = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
  if (!fs.existsSync(auditFile)) {
    console.error('[exp-features] audit.log missing')
    process.exit(1)
  }
  const raw = fs.readFileSync(auditFile, 'utf8').trim()
  if (!raw) {
    console.log('[exp-features] empty audit file')
    return
  }
  const lines = raw.split('\n').filter(Boolean)
  const stats: Record<string, Stat> = {}
  const distinctSets: Record<string, Set<any>> = {}
  for (const line of lines) {
    let j: any
    try { j = JSON.parse(line) } catch { continue }
    if (!j || !j.inferenceFeatures) continue
    for (const [k,v] of Object.entries(j.inferenceFeatures as Record<string, any>)) {
      if (!k.startsWith('exp_')) continue
      if (!stats[k]) stats[k] = { key: k, count: 0, numeric: isNumeric(v) }
      const st = stats[k]
      st.count++
      if (isNumeric(v)) {
        if (st.min === undefined || v < st.min) st.min = v
        if (st.max === undefined || v > st.max) st.max = v
      } else {
        if (!distinctSets[k]) distinctSets[k] = new Set()
        distinctSets[k].add(v)
      }
    }
  }
  // finalize distinct counts
  for (const [k,set] of Object.entries(distinctSets)) {
    if (stats[k]) stats[k].distinct = set.size
  }
  const table = Object.values(stats).sort((a,b)=> a.key.localeCompare(b.key))
  console.log('[exp-features] summary:')
  for (const st of table) {
    if (st.numeric) {
      console.log(`${st.key}: count=${st.count} min=${st.min} max=${st.max}`)
    } else {
      console.log(`${st.key}: count=${st.count} distinct=${st.distinct}`)
    }
  }
  if (!table.length) console.log('[exp-features] no exp_ features found')
}

main()
