#!/usr/bin/env node
import 'dotenv/config'
import { createPublicClient, http } from 'viem'
import { createBundlerClient } from 'viem/account-abstraction'
import { privateKeyToAccount } from 'viem/accounts'
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
  transport: http(process.env.ZERO_DEV_BUNDLER_RPC),
})

// Create paymaster client
const { createPaymasterClient } = await import('viem/account-abstraction')
const paymasterClient = createPaymasterClient({
  transport: http(process.env.ZERO_DEV_PAYMASTER_RPC),
})

console.log('🚀 DÉPLOIEMENT IMMÉDIAT DU DELEGATE SA\n')

const delegatePK = process.env.DELEGATE_PRIVATE_KEY
if (!delegatePK) {
  console.error('❌ DELEGATE_PRIVATE_KEY not found')
  process.exit(1)
}

const delegateEOA = privateKeyToAccount(delegatePK)
console.log('Delegate EOA:', delegateEOA.address)

const env = getDeleGatorEnvironment(10143)

const delegateSA = await toMetaMaskSmartAccount({
  client: publicClient,
  implementation: Implementation.Hybrid,
  deployParams: [delegateEOA.address, [], [], []],
  deploySalt: '0x',
  signer: { account: delegateEOA },
  environment: env,
})

console.log('Delegate SA:', delegateSA.address)
console.log('')

// Check if already deployed
const code = await publicClient.getBytecode({ address: delegateSA.address })
const isDeployed = code && code !== '0x'

if (isDeployed) {
  console.log('✅ Delegate SA DÉJÀ DÉPLOYÉ!')
  console.log('   Bytecode length:', code.length)
  process.exit(0)
}

console.log('📤 Déploiement en cours avec paymaster...')

try {
  // Send a simple transfer to EOA owner to trigger deployment with paymaster
  const hash = await bundlerClient.sendUserOperation({
    account: delegateSA,
    calls: [{ to: delegateEOA.address, value: 0n, data: '0x' }],
    paymaster: paymasterClient, // ✅ Inject paymaster for sponsorship
  })
  
  console.log('✅ UserOp de déploiement envoyé:', hash)
  console.log('Attente de confirmation...')
  
  const receipt = await bundlerClient.waitForUserOperationReceipt({
    hash,
    timeout: 120_000,
  })
  
  if (receipt.success) {
    console.log('')
    console.log('🎉🎉🎉 DELEGATE SA DÉPLOYÉ AVEC SUCCÈS! 🎉🎉🎉')
    console.log('Block:', receipt.receipt.blockNumber)
    console.log('TX:', receipt.receipt.transactionHash)
    console.log('Gas used:', receipt.receipt.gasUsed.toString())
    
    // Verify deployment
    const newCode = await publicClient.getBytecode({ address: delegateSA.address })
    console.log('Bytecode length:', newCode?.length || 0)
    
    console.log('')
    console.log('✅ Maintenant tu peux créer des delegations!')
    console.log('   Le frontend va maintenant utiliser la vraie adresse du Delegate SA.')
  } else {
    console.log('')
    console.log('❌ Déploiement échoué')
    console.log('Receipt:', receipt)
  }
} catch (e) {
  console.error('')
  console.error('❌ Erreur de déploiement:', e.message)
  
  if (e.message?.includes('AA25')) {
    if (e.message?.includes('deployment')) {
      console.log('')
      console.log('💡 Conflit de déploiement détecté.')
      console.log('   Un autre UserOp de déploiement est en cours.')
      console.log('   Attends 2-3 minutes et relance ce script.')
    } else if (e.message?.includes('nonce')) {
      console.log('')
      console.log('💡 Conflit de nonce détecté.')
      console.log('   Le Delegate SA a peut-être un nonce bloqué.')
    }
  }
  
  console.log('')
  console.log('🔍 Vérification manuelle:')
  console.log('   Explorer: https://explorer.testnet.monad.xyz/address/' + delegateSA.address)
}
