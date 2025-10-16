#!/usr/bin/env node
import 'dotenv/config'
import { createPublicClient, createWalletClient, http, defineChain, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Implementation, toMetaMaskSmartAccount, getDeleGatorEnvironment } from '@metamask/delegation-toolkit'

async function main() {
  const RPC_URL = process.env.VITE_RPC_URL
  const DELEGATE_PK = process.env.VITE_DELEGATE_PRIVATE_KEY
  const CHAIN_ID = 10143

  if (!RPC_URL) throw new Error('VITE_RPC_URL manquant dans .env')
  if (!DELEGATE_PK) throw new Error('VITE_DELEGATE_PRIVATE_KEY manquant dans .env')

  const chain = defineChain({
    id: CHAIN_ID,
    name: 'Monad Testnet',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
    blockExplorers: { default: { name: 'Monad Explorer', url: 'https://explorer.testnet.monad.xyz' } },
    testnet: true,
  })

  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) })
  const account = privateKeyToAccount(DELEGATE_PK)
  const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) })

  console.log('[delegate] EOA:', account.address)

  const delegateSmartAccount = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [account.address, [], [], []],
    deploySalt: '0x',
    signer: { account },
    environment: getDeleGatorEnvironment(CHAIN_ID),
  })

  console.log('[delegate] Smart Account address:', delegateSmartAccount.address)

  // Diagnostics before deployment
  try {
    const [balanceWei, nonce, gasPrice] = await Promise.all([
      publicClient.getBalance({ address: account.address }),
      publicClient.getTransactionCount({ address: account.address }),
      publicClient.getGasPrice(),
    ])
    console.log('[delegate][diag] EOA balance:', formatEther(balanceWei), 'MON')
    console.log('[delegate][diag] EOA nonce:', nonce)
    console.log('[delegate][diag] Chain gasPrice:', formatEther(gasPrice) + ' MON/ETH-equivalent per gas (converted)')
  } catch (e) {
    console.warn('[delegate][diag] Unable to fetch balance/nonce/gasPrice:', e?.shortMessage || e?.message || e)
  }

  const code = await publicClient.getBytecode({ address: delegateSmartAccount.address })
  if (code && code !== '0x') {
    console.log('[delegate] Déjà déployé on-chain')
    return
  }

  const { factory, factoryData } = await delegateSmartAccount.getFactoryArgs()
  console.log('[delegate] Factory:', factory)

  // Estimate gas & compute fee caps (configurable)
  let gasEstimate
  try {
    gasEstimate = await publicClient.estimateGas({
      account: account.address,
      to: factory,
      data: factoryData,
    })
    console.log('[delegate][diag] Gas estimate:', gasEstimate.toString())
  } catch (e) {
    console.warn('[delegate][diag] estimateGas failed:', e?.shortMessage || e?.message || e)
  }

  const ONE_GWEI = 1_000_000_000n
  const maxFeeGwei = process.env.MAX_FEE_GWEI ? BigInt(process.env.MAX_FEE_GWEI) : 122n
  const maxPrioGwei = process.env.MAX_PRIORITY_GWEI ? BigInt(process.env.MAX_PRIORITY_GWEI) : 2n
  const maxFeePerGas = maxFeeGwei * ONE_GWEI
  const maxPriorityFeePerGas = maxPrioGwei * ONE_GWEI
  if (gasEstimate) {
    const estCostWei = gasEstimate * maxFeePerGas
    console.log('[delegate][diag] Fee caps:', {
      maxFeeGwei: maxFeeGwei.toString(),
      maxPrioGwei: maxPrioGwei.toString(),
      estCostMON: formatEther(estCostWei),
    })
  }

  const txHash = await walletClient.sendTransaction({
    to: factory,
    data: factoryData,
    gas: gasEstimate,
    maxFeePerGas,
    maxPriorityFeePerGas,
  })
  console.log('[delegate] Déploiement envoyé. Tx:', txHash)

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
  console.log('[delegate] Déploiement confirmé. Status:', receipt.status)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})