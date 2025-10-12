import fs from 'node:fs'
import { keccak256 } from 'viem'
import zlib from 'node:zlib'

function stringToHex(str: string): `0x${string}` {
  let hex = '0x'
  for (const b of Buffer.from(str)) hex += b.toString(16).padStart(2, '0')
  return hex as `0x${string}`
}

interface FileEntry { name: string; content: string }

async function main() {
  const file = process.argv[2]
  if (!file) {
    console.error('Usage: tsx src/verify-proof-pack.ts <proof-pack.json.gz>')
    process.exit(2)
  }
  const raw = fs.readFileSync(file)
  let json: any
  try {
    const decompressed = zlib.gunzipSync(raw)
    json = JSON.parse(decompressed.toString('utf8'))
  } catch (e: any) {
    console.error('[verify-proof-pack] failed to parse gzip/json', e?.message || e)
    process.exit(2)
  }
  if (!json.files || !Array.isArray(json.files)) {
    console.error('[verify-proof-pack] invalid structure: missing files[]')
    process.exit(2)
  }
  const files: FileEntry[] = json.files
  const manifestFile = files.find(f => f.name === 'manifest.json')
  if (!manifestFile) {
    console.error('[verify-proof-pack] manifest.json missing')
    process.exit(2)
  }
  let manifest: any
  try { manifest = JSON.parse(manifestFile.content) } catch { manifest = null }
  if (!manifest || !manifest.packKeccak256) {
    console.error('[verify-proof-pack] manifest invalid or packKeccak256 missing')
    process.exit(2)
  }
  const packKeccakFromManifest = manifest.packKeccak256.toLowerCase()
  // Rebuild provisional bundle (remove packKeccak256)
  const provisionalManifest = { ...manifest }
  // Remove fields not hashed in original pre-image
  delete provisionalManifest.packKeccak256
  delete provisionalManifest.anchorRef
  const provisionalFiles = files.map(f => f.name === 'manifest.json' ? { name: 'manifest.json', content: JSON.stringify(provisionalManifest, null, 2) } : f)
  const bundleSansPack = { files: provisionalFiles }
  const ser = JSON.stringify(bundleSansPack)
  const local = keccak256(stringToHex(ser)).toLowerCase()
  const match = local === packKeccakFromManifest
  if (!match) {
    console.error('[verify-proof-pack] MISMATCH', { manifest: packKeccakFromManifest, local })
    process.exit(1)
  }
  console.log('[verify-proof-pack] OK match', local)
}

main().catch(e => { console.error(e); process.exit(2) })
