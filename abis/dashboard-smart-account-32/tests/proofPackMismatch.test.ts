import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import childProcess from 'node:child_process'

function runNodeScript(args: string[], env: Record<string,string|undefined> = {}) {
  return childProcess.spawnSync('node', args, { encoding: 'utf8', env: { ...process.env, ...env } })
}

function runTsxScript(args: string[], env: Record<string,string|undefined> = {}) {
  return childProcess.spawnSync('npx', ['tsx', ...args], { encoding: 'utf8', env: { ...process.env, ...env } })
}

describe('proof pack mismatch detection', () => {
  it('detects tampered manifest packKeccak256 mismatch', () => {
    // Build a fresh proof pack
    const build = runTsxScript(['src/build-proof-pack.ts'])
    expect(build.status).toBe(0)
    const outLine = (build.stdout + build.stderr).split('\n').find(l => l.includes('wrote'))
    expect(outLine).toBeTruthy()
    const match = outLine!.match(/wrote (.*proof-pack-.*\.json\.gz)/)
    expect(match).toBeTruthy()
    const packPath = match![1].trim()
    expect(fs.existsSync(packPath)).toBe(true)

    // Gunzip, parse JSON, tamper manifest packKeccak256
    const raw = fs.readFileSync(packPath)
    const zlib = require('node:zlib')
    const decompressed = zlib.gunzipSync(raw).toString('utf8')
    const json = JSON.parse(decompressed)
    const manifestFile = json.files.find((f: any) => f.name === 'manifest.json')
    expect(manifestFile).toBeTruthy()
    const manifest = JSON.parse(manifestFile.content)
    manifest.packKeccak256 = '0xdeadbeef'
    manifestFile.content = JSON.stringify(manifest, null, 2)
    // Repack gzip with tampered manifest
    const tampered = Buffer.from(JSON.stringify(json))
    const gzTampered = zlib.gzipSync(tampered)
    const tamperedPath = packPath.replace('.json.gz', '.tampered.json.gz')
    fs.writeFileSync(tamperedPath, gzTampered)

    // Verify original should pass
    const verifyOk = runTsxScript(['src/verify-proof-pack.ts', packPath])
    expect(verifyOk.status).toBe(0)
    expect((verifyOk.stdout + verifyOk.stderr).includes('OK match')).toBe(true)

    // Verify tampered should fail (exit code 1)
    const verifyBad = runTsxScript(['src/verify-proof-pack.ts', tamperedPath])
    expect(verifyBad.status).toBe(1)
    expect((verifyBad.stdout + verifyBad.stderr).toLowerCase()).toContain('mismatch')
  })
})
