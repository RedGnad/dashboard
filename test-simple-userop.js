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

async function testSimpleUserOp() {
  console.log('🧪 Test simple UserOp sans paymaster...')
  
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
  console.log(`EOA: ${eoa.address}`)
  
  // Check balances
  const saBalance = await publicClient.getBalance({ address: sa.address })
  const eoaBalance = await publicClient.getBalance({ address: eoa.address })
  
  console.log(`SA Balance: ${Number(saBalance) / 1e18} MON`)
  console.log(`EOA Balance: ${Number(eoaBalance) / 1e18} MON`)
  
  if (saBalance === 0n) {
    console.log('❌ SA has no MON - cannot pay gas without paymaster')
    return
  }
  
  // Simple UserOp: send 0.001 MON to EOA (self-transfer test)
  console.log('📤 Sending simple UserOp...')
  
  try {
    const hash = await bundlerClient.sendUserOperation({
      account: sa,
      calls: [{
        to: eoa.address,
        value: parseEther('0.001'), // 0.001 MON
        data: '0x'
      }],
      // No paymaster = SA pays its own gas
    })
    
    console.log(`✅ UserOp sent: ${hash}`)
    console.log('⏳ Waiting for confirmation...')
    
    const receipt = await bundlerClient.waitForUserOperationReceipt({
      hash,
      timeout: 60_000, // 1 minute timeout
    })
    
    if (receipt.success) {
      console.log(`🎉 UserOp confirmed! TX: ${receipt.receipt.transactionHash}`)
    } else {
      console.log(`❌ UserOp failed on-chain`)
    }
  } catch (e) {
    console.error('❌ UserOp error:', e.message)
  }
}

testSimpleUserOp().catch(console.error)
