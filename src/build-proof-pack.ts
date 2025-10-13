import fs from 'node:fs'
import path from 'node:path'
import { keccak256 } from 'viem'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'

// Lightweight tar creator (USTAR not needed) – we just concatenate files with a manifest-like index JSON.
// Simpler: create a directory under tmp, write files, then gzip a JSON bundle. For hackathon speed we avoid full tar format.

interface ManifestV1 {
  schemaVersion: string
  buildTs: number
  chainId: number
  decision?: any
  decisionRollingHash?: string | null
  featureHash?: string
  modelHash?: string
  weightsUsedHash?: string
  aiRationaleHash?: string
  rollingHash?: string
  rollingHashHeight?: number
  inferenceProofHash?: string
  eventsWindow?: { from: number; to: number; count: number }
  files: { name: string; keccak256: string; size: number }[]
  packKeccak256?: string
}

function stringToHex(str: string): `0x${string}` {
  const enc = new TextEncoder().encode(str)
  let hex = '0x'
  for (const b of enc) hex += b.toString(16).padStart(2, '0')
  return hex as `0x${string}`
}

async function main() {
  const outDir = path.join(process.cwd(), 'data', 'proof-packs')
  fs.mkdirSync(outDir, { recursive: true })

  // Load latest decision (heuristic: scan audit log backwards for ai_decision) + last rollingHash
  const auditFile = path.join(process.cwd(), 'data', 'delegations', 'audit.log')
  let decisionLine: any = null
  let rollingHash: string | undefined
  let rollingHeight = 0
  if (fs.existsSync(auditFile)) {
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean)
    rollingHeight = lines.length
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(lines[i])
        if (!rollingHash && j.rollingHash) rollingHash = j.rollingHash
        if (!decisionLine && j.action === 'ai_decision') {
          decisionLine = j
          if (rollingHash) break
        }
      } catch {}
    }
  }

  // Load feature head by invoking feature computation directly
  let features: any = null
  try {
    const { computeFeatureSet } = await import('./hyperindex/features')
    features = computeFeatureSet({})
  } catch {}

  // Load recent events slice (up to 24h window from features if present)
  let events: any[] = []
  let eventsWindow: { from: number; to: number; count: number } | undefined
  try {
    const { loadAllEvents } = await import('./hyperindex/eventStore')
    const all = loadAllEvents()
    if (features) {
      const to = features.asOfTs
      const from = Math.min(...features.windowSpecs.map((w: any) => w.fromTs))
      events = all.filter(e => e.ts >= from && e.ts <= to)
      eventsWindow = { from, to, count: events.length }
    } else {
      events = all.slice(-200) // fallback last 200
      if (events.length) {
        eventsWindow = { from: events[0].ts, to: events[events.length - 1].ts, count: events.length }
      }
    }
  } catch {}

  const buildTs = Date.now()
  const chainId = Number(process.env.CHAIN_ID || (decisionLine?.chainId ?? features?.chainId ?? 0))

  // Prepare files JSON (no true tar for now) – each file content hashed and then whole bundle gzipped
  const files: { name: string; content: string }[] = []
  if (decisionLine) files.push({ name: 'decision.json', content: JSON.stringify(decisionLine, null, 2) })
  if (features) files.push({ name: 'features.json', content: JSON.stringify(features, null, 2) })
  if (events.length) files.push({ name: 'events.jsonl', content: events.map(e => JSON.stringify(e)).join('\n') + '\n' })
  if (rollingHash) files.push({ name: 'rolling.txt', content: `${rollingHash}\nheight=${rollingHeight}\n` })
  // Inference canonical blob (if present): re-derive from decision fields to avoid trusting stored meta
  if (decisionLine && (decisionLine.featureHashV2 || decisionLine.inferenceProofHash)) {
    const canonicalInf = {
      provider: decisionLine.inferenceProvider || 'unknown',
      version: decisionLine.inferenceVersion || decisionLine.version || 'unknown',
      modelId: decisionLine.meta?.modelId || undefined,
      modelHash: decisionLine.modelHash || undefined,
      featureHashV2: decisionLine.featureHashV2 || null,
      delegator: decisionLine.delegator,
      ts: decisionLine.ts,
    }
    const infStr = JSON.stringify(canonicalInf, null, 2)
    files.push({ name: 'inference.json', content: infStr })
  }

  const manifestProvisional: ManifestV1 = {
    schemaVersion: '1.0.0',
    buildTs,
    chainId,
    decision: decisionLine ? { actionId: decisionLine.actionId, ts: decisionLine.ts, aiActionType: decisionLine.aiActionType } : undefined,
    decisionRollingHash: decisionLine?.rollingHash,
    featureHash: features?.featureHash,
    modelHash: decisionLine?.modelHash,
    weightsUsedHash: decisionLine?.weightsUsedHash,
    aiRationaleHash: decisionLine?.aiRationaleHash,
    rollingHash,
    rollingHashHeight: rollingHeight,
    inferenceProofHash: decisionLine?.inferenceProofHash,
    eventsWindow,
    files: [],
  }

  // Compute per-file hashes
  for (const f of files) {
    const hex = stringToHex(f.content)
    const k = keccak256(hex)
    manifestProvisional.files.push({ name: f.name, keccak256: k, size: Buffer.byteLength(f.content) })
  }
  const provisionalFiles = [...files, { name: 'manifest.json', content: JSON.stringify(manifestProvisional, null, 2) }]
  const bundleSansPack = { files: provisionalFiles.map(f => ({ name: f.name, content: f.content })) }
  const bundleSansPackJson = JSON.stringify(bundleSansPack)
  const packKeccak256 = keccak256(stringToHex(bundleSansPackJson))
  const manifestFinal: ManifestV1 = { ...manifestProvisional, packKeccak256 }
  const finalFiles = [...files, { name: 'manifest.json', content: JSON.stringify(manifestFinal, null, 2) }]
  const finalBundle = { files: finalFiles.map(f => ({ name: f.name, content: f.content })) }
  const finalJson = JSON.stringify(finalBundle)
  const gz = zlib.gzipSync(Buffer.from(finalJson))
  const fileName = `proof-pack-${buildTs}.json.gz`
  const outPath = path.join(outDir, fileName)
  fs.writeFileSync(outPath, gz)
  console.log('[build-proof-pack] wrote', outPath)
  console.log('[build-proof-pack] packKeccak256', packKeccak256)
}

main().catch(e => { console.error('[build-proof-pack] failed', e); process.exit(1) })
