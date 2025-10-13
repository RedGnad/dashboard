import 'dotenv/config'
import { getAddress, keccak256, toHex } from 'viem'
import { publicClient } from '../clients'

// EIP-1967 implementation slot = bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1)
const implSlot = (() => {
  const k = keccak256(toHex(new TextEncoder().encode('eip1967.proxy.implementation')))
  // subtract 1 (mod 2^256)
  const bn = BigInt(k)
  const slot = (bn - 1n) & ((1n << 256n) - 1n)
  // return as 0x-prefixed 32-byte hex
  return '0x' + slot.toString(16).padStart(64, '0')
})()

async function main() {
  const addr = process.argv[2]
  if (!addr) {
    console.error('Usage: tsx src/tools/resolve-implementation.ts <proxyAddress>')
    process.exit(1)
  }
  const proxy = getAddress(addr)
  const raw = await publicClient.getStorageAt({ address: proxy, slot: implSlot as any })
  if (!raw) {
    console.error('No storage value at EIP-1967 slot')
    process.exit(2)
  }
  // last 20 bytes are the implementation address
  const hex = raw.toString()
  const impl = getAddress('0x' + hex.slice(-40))
  console.log(JSON.stringify({ proxy, impl, slot: implSlot }, null, 2))
}

main().catch((e) => { console.error(e); process.exit(1) })
