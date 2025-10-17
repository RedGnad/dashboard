import 'dotenv/config'
import { Address, parseUnits } from 'viem'
import { publicClient, bundlerClient } from './clients'

// Addresses (Monad testnet)
const ENTRYPOINT_V07: Address = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'
const UNIVERSAL_ROUTER: Address = '0x3ae6d8a282d67893e17aa70ebffb33ee5aa65893'
const WMON: Address = '0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701'
const USDC: Address = '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea'

async function run() {
  const bundler = bundlerClient

  // TODO: Load delegator smart account and delegation from DB; attach during signing with Delegation Toolkit signer
  // For now, we leave placeholders; actual signing with mm toolchain will be wired next step.

  const amountUsdc = parseUnits(process.env.DCA_AMOUNT_USDC || '1', 6)
  const minOutBps = Number(process.env.SLIPPAGE_BPS || '100')

  // Sanity ping: get gas price via shared publicClient
  try {
    const gp = await publicClient.getGasPrice()
    console.log('Gas price', gp.toString())
  } catch {}
  console.log('Prepared to build userOperation for DCA', { amountUsdc: amountUsdc.toString(), minOutBps, hasBundler: !!bundler })
  console.log('Next step: wire MetaMask Delegation Toolkit signer and Universal Router calldata.')
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
