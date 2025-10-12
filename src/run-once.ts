import 'dotenv/config'
import { Address, encodeFunctionData, parseAbi, parseUnits, createPublicClient, http } from 'viem'
import { createBundlerClient, createPaymasterClient, sendUserOperation } from 'viem/account-abstraction'

// Addresses (Monad testnet)
const ENTRYPOINT_V07: Address = '0x0000000071727De22E5E9d8BAf0edAc6f37da032'
const UNIVERSAL_ROUTER: Address = '0x3ae6d8a282d67893e17aa70ebffb33ee5aa65893'
const WMON: Address = '0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701'
const USDC: Address = '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea'

async function run() {
  const bundlerUrl = process.env.ZERO_DEV_BUNDLER_RPC || process.env.PIMLICO_BUNDLER_RPC
  const paymasterUrl = process.env.ZERO_DEV_PAYMASTER_RPC || process.env.PIMLICO_PAYMASTER_RPC
  const rpc = process.env.RPC_URL || 'https://testnet-rpc.monad.xyz'
  if (!bundlerUrl || !paymasterUrl) throw new Error('Missing bundler/paymaster URLs')

  const client = createPublicClient({ transport: http(rpc) })
  const paymaster = createPaymasterClient({ transport: http(paymasterUrl) })
  const bundler = createBundlerClient({ client, transport: http(bundlerUrl), paymaster })

  // TODO: Load delegator smart account and delegation from DB; attach during signing with Delegation Toolkit signer
  // For now, we leave placeholders; actual signing with mm toolchain will be wired next step.

  const amountUsdc = parseUnits(process.env.DCA_AMOUNT_USDC || '1', 6)
  const minOutBps = Number(process.env.SLIPPAGE_BPS || '100')

  console.log('Prepared to build userOperation for DCA', { amountUsdc: amountUsdc.toString(), minOutBps })
  console.log('Next step: wire MetaMask Delegation Toolkit signer and Universal Router calldata.')
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
