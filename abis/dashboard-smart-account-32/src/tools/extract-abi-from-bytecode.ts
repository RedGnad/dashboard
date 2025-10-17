import 'dotenv/config'
import { publicClient } from '../clients'
import { Address, Hex, getAddress } from 'viem'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EIP1967_IMPL_SLOT: Hex = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

async function readImpl(address: Address): Promise<Address | null> {
	try {
		const raw = await publicClient.getStorageAt({ address, slot: EIP1967_IMPL_SLOT })
		if (!raw) return null
		const hex = raw.toString()
		if (hex === '0x' || /^0x0+$/.test(hex)) return null
		// last 20 bytes
		const tail = '0x' + hex.slice(-40)
		try { return getAddress(tail) } catch { return null }
	} catch { return null }
}

async function fetchAbiFromBlockVision(addr: Address): Promise<any> {
	const apiKey = process.env.BLOCKVISION_API_KEY
	if (!apiKey) throw new Error('BLOCKVISION_API_KEY missing')
	const url = new URL('https://api.blockvision.org/v2/monad/contract/source/code')
	url.searchParams.set('address', addr)
	const res = await fetch(url.toString(), { headers: { 'X-API-Key': apiKey } })
	if (!res.ok) throw new Error(`BlockVision HTTP ${res.status}: ${await res.text().catch(()=> '')}`)
	const json = await res.json()
	if (json.code !== 0 || !json.result) throw new Error(`BlockVision error: ${json.reason || json.message || 'unknown'}`)
	const abiStr = json.result.abi
	try { return typeof abiStr === 'string' ? JSON.parse(abiStr) : abiStr } catch { return abiStr }
}

function hexToBytes(hex: string): Uint8Array {
	const clean = hex.startsWith('0x') ? hex.slice(2) : hex
	const arr = new Uint8Array(clean.length / 2)
	for (let i = 0; i < arr.length; i++) arr[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
	return arr
}

function bytesToHex(b: Uint8Array): string {
	return '0x' + Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')
}

// Extract multihash from Solidity CBOR trailer: look for CBOR key 'ipfs' (0x64 'ipfs') followed by byte string (0x58 0x22)
function extractMultihashFromBytecode(bytecodeHex: string): Uint8Array | null {
	const h = (bytecodeHex || '').toLowerCase()
	const pattern = '64697066735822' // 0x64 'ipfs' + 0x58 (bytes) 0x22 (length=34)
	const idx = h.lastIndexOf(pattern)
	if (idx === -1) return null
	const start = idx + pattern.length
	const mhHex = h.slice(start, start + 34 * 2)
	if (mhHex.length !== 68) return null
	return hexToBytes(mhHex)
}

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58btcEncode(bytes: Uint8Array): string {
	if (bytes.length === 0) return ''
	// Big integer division algorithm
	const digits: number[] = [0]
	for (let i = 0; i < bytes.length; i++) {
		let carry = bytes[i]
		for (let j = 0; j < digits.length; j++) {
			const x = (digits[j] << 8) + carry
			digits[j] = Math.floor(x / 58)
			carry = x % 58
		}
		while (carry) {
			digits.push(carry % 58)
			carry = Math.floor(carry / 58)
		}
	}
	// deal with leading zeros
	for (let k = 0; k < bytes.length && bytes[k] === 0; k++) digits.push(0)
	return digits.reverse().map(d => B58_ALPHABET[d]).join('')
}

async function fetchMetadataFromIpfs(mh: Uint8Array): Promise<any | null> {
	const cidV0 = base58btcEncode(mh)
	const gateways = [
		'https://ipfs.io/ipfs/',
		'https://cloudflare-ipfs.com/ipfs/',
		'https://gateway.pinata.cloud/ipfs/'
	]
	for (const g of gateways) {
		try {
			const res = await fetch(g + cidV0, { redirect: 'follow' as any })
			if (!res.ok) continue
			const text = await res.text()
			try { return JSON.parse(text) } catch { /* might be plain json already */ return null }
		} catch {}
	}
	return null
}

async function main() {
	const proxy = (process.argv[2] || '').toLowerCase()
	const out = process.argv[3]
	if (!proxy || !proxy.startsWith('0x') || proxy.length !== 42) {
		console.error('Usage: tsx src/tools/extract-abi-from-bytecode.ts <proxyAddress> [out.json]')
		process.exit(1)
	}
	const proxyAddr = getAddress(proxy)
	const impl = await readImpl(proxyAddr)
	if (!impl) {
		console.error('[eip1967] No implementation found at standard slot; try providing ABI via BlockVision directly or Local ABI')
		process.exit(2)
	}
	console.log('[eip1967] implementation =', impl)
		let abi: any
		try {
			abi = await fetchAbiFromBlockVision(impl)
		} catch (e) {
			console.warn('[blockvision] ABI not available, trying CBOR/IPFS metadata extraction…', (e as any)?.message || e)
			const bytecode = await publicClient.getBytecode({ address: impl })
			if (!bytecode) throw new Error('No bytecode for implementation; cannot extract metadata')
			const mh = extractMultihashFromBytecode(bytecode)
			if (!mh) throw new Error('No IPFS multihash found in bytecode metadata. Contract might be stripped or metadata unavailable.')
			const meta = await fetchMetadataFromIpfs(mh)
			if (!meta || !meta.output || !meta.output.abi) throw new Error('Metadata fetched but ABI not found in output.abi')
			abi = meta.output.abi
		}
	const dir = join(process.cwd(), 'envio', 'abis')
	try { mkdirSync(dir, { recursive: true }) } catch {}
	const file = out || join(dir, 'fortytwo-core.json')
	writeFileSync(file, JSON.stringify(abi, null, 2))
	console.log('[abi] saved to', file)
	console.log('\nImport tip (Envio CLI): choose Local ABI Import, use proxy address', proxyAddr, 'but point to this ABI (implementation ABI).')
}

main().catch((e) => { console.error(e); process.exit(1) })

