import { privateKeyToAccount } from 'viem/accounts'

const pk = process.env.OG_PRIVATE_KEY || ''
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  console.error('OG_PRIVATE_KEY manquant ou invalide (attendu: 0x + 64 hex)')
  process.exit(1)
}
const acc = privateKeyToAccount(pk)
console.log(JSON.stringify({ address: acc.address }, null, 2))
