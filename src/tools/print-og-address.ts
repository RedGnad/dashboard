import { privateKeyToAccount } from 'viem/accounts'

function main() {
  const pk = process.env.OG_PRIVATE_KEY || ''
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    console.error('OG_PRIVATE_KEY manquant ou invalide (attendu: 0x + 64 hex)')
    process.exit(1)
  }
  const acc = privateKeyToAccount(pk as `0x${string}`)
  console.log(JSON.stringify({ address: acc.address }, null, 2))
}

main()
