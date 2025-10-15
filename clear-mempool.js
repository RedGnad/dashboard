#!/usr/bin/env node
import 'dotenv/config'
import { createPublicClient, http, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createBundlerClient } from 'viem/account-abstraction'
import { Implementation, toMetaMaskSmartAccount, getDeleGatorEnvironment } from '@metamask/delegation-toolkit'

const monadTestnet = {
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } },
}

const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http('https://testnet-rpc.monad.xyz'),
})

const bundlerClient = createBundlerClient({
  client: publicClient,
  transport: http('https://rpc.zerodev.app/api/v2/bundler/7535339b-9ae3-41bb-ad97-5375bae4a51b'),
})

async function clearMempool() {
  console.log('🧹 Clearing mempool with high gas UserOp...')
  
  // Setup Delegate SA
  const pk = process.env.DELEGATE_PRIVATE_KEY
  if (!pk) throw new Error('Missing DELEGATE_PRIVATE_KEY')
  
  const eoa = privateKeyToAccount(pk)
  const env = getDeleGatorEnvironment(monadTestnet.id)
  
  const sa = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [eoa.address, [], [], []],
    deploySalt: '0x',
    signer: { account: eoa },
    environment: env,
  })
  
  console.log(`Delegate SA: ${sa.address}`)
  
  // Get current gas price and multiply by 2
  const gasPrice = await publicClient.getGasPrice()
  const highGasPrice = gasPrice * 2n
  
  console.log(`Current gas: ${Number(gasPrice) / 1e9} gwei`)
  console.log(`High gas: ${Number(highGasPrice) / 1e9} gwei`)
  
  try {
    // Send simple UserOp with HIGH GAS to clear mempool
    const hash = await bundlerClient.sendUserOperation({
      account: sa,
      calls: [{
        to: sa.address, // Self-call (no-op)
        value: 0n,
        data: '0x'
      }],
      maxFeePerGas: highGasPrice,
      maxPriorityFeePerGas: highGasPrice / 2n,
    })
    
    console.log(`✅ High-gas UserOp sent: ${hash}`)
    console.log('⏳ Waiting for confirmation...')
    
    const receipt = await bundlerClient.waitForUserOperationReceipt({
      hash,
      timeout: 120_000, // 2 minutes
    })
    
    if (receipt.success) {
      console.log(`🎉 Mempool cleared! TX: ${receipt.receipt.transactionHash}`)
      
      // Check new nonce
      const newNonce = await publicClient.getTransactionCount({ address: sa.address })
      console.log(`New nonce: ${newNonce}`)
    } else {
      console.log(`❌ UserOp failed`)
    }
  } catch (e) {
    console.error('❌ Error:', e.message)
  }
}

clearMempool().catch(console.error)
