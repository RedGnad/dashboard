#!/usr/bin/env node
import 'dotenv/config'
import { createPublicClient, http, defineChain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createBundlerClient, createPaymasterClient } from 'viem/account-abstraction'
import { Implementation, toMetaMaskSmartAccount, getDeleGatorEnvironment } from '@metamask/delegation-toolkit'

async function main() {
  const RPC_URL = process.env.VITE_RPC_URL
  const BUNDLER_RPC = process.env.VITE_ZERO_DEV_BUNDLER_RPC
  const PAYMASTER_RPC = process.env.VITE_ZERO_DEV_PAYMASTER_RPC
  const DELEGATE_PK = process.env.VITE_DELEGATE_PRIVATE_KEY
  const CHAIN_ID = 10143
  const WAIT_TIMEOUT_MS = Number(process.env.WAIT_TIMEOUT_MS ?? 120000) // 2min par défaut
  const BYTECODE_FALLBACK_MS = Number(process.env.BYTECODE_FALLBACK_MS ?? 120000) // +2min fallback
  const EXISTING_USER_OP_HASH = process.env.USER_OP_HASH

  if (!RPC_URL) throw new Error('VITE_RPC_URL manquant dans .env')
  if (!BUNDLER_RPC) throw new Error('VITE_ZERO_DEV_BUNDLER_RPC manquant dans .env')
  if (!PAYMASTER_RPC) throw new Error('VITE_ZERO_DEV_PAYMASTER_RPC manquant dans .env')
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
  const bundlerClient = createBundlerClient({ client: publicClient, transport: http(BUNDLER_RPC) })
  const paymasterClient = createPaymasterClient({ transport: http(PAYMASTER_RPC) })
  
  const account = privateKeyToAccount(DELEGATE_PK)
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

  // Check if already deployed
  const code = await publicClient.getBytecode({ address: delegateSmartAccount.address })
  if (code && code !== '0x') {
    console.log('[delegate] Déjà déployé on-chain')
    return
  }

  console.log('[delegate] Déploiement via bundler + paymaster...')
  
  // Si on a déjà un hash (première tentative), ne pas re-soumettre, juste attendre
  if (EXISTING_USER_OP_HASH) {
    console.log('[delegate] Attente sur USER_OP_HASH existant:', EXISTING_USER_OP_HASH)
    try {
      const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: EXISTING_USER_OP_HASH, timeout: WAIT_TIMEOUT_MS })
      console.log('[delegate] Déploiement confirmé. Receipt:', receipt.success ? 'SUCCESS' : 'FAILED')
      return
    } catch (err) {
      console.warn('[delegate] Attente bundler expirée, passage au fallback bytecode check...')
      // continue vers fallback bytecode
    }
  } else {
    // Deploy via UserOperation (paymaster sponsored)
    let userOpHash
    try {
      userOpHash = await bundlerClient.sendUserOperation({
        account: delegateSmartAccount,
        calls: [{
          to: delegateSmartAccount.address,
          data: '0x' // No-op call to trigger deployment
        }],
        paymaster: paymasterClient,
      })
      console.log('[delegate] UserOperation envoyée:', userOpHash)
    } catch (err) {
      const msg = `${err?.shortMessage || ''} ${err?.details || ''}`
      const isAA25 = msg.includes('Another deployment operation for this sender is already being processed')
      const isNonce = (err?.shortMessage || '').includes('Invalid Smart Account nonce')
      if (isAA25 || isNonce) {
        console.warn('[delegate] Déploiement déjà en cours côté bundler. On évite la re-soumission et on passe au fallback bytecode check...')
        // continue vers fallback bytecode
      } else {
        throw err
      }
    }

    // Si on a pu envoyer, tenter d'attendre d'abord via bundler
    if (userOpHash) {
      try {
        const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: userOpHash, timeout: WAIT_TIMEOUT_MS })
        console.log('[delegate] Déploiement confirmé. Receipt:', receipt.success ? 'SUCCESS' : 'FAILED')
        return
      } catch (err) {
        console.warn('[delegate] Attente bundler expirée, passage au fallback bytecode check...')
      }
    }
  }

  // 2) Fallback: vérifier le bytecode on-chain pendant une fenêtre supplémentaire
  const deadline = Date.now() + BYTECODE_FALLBACK_MS
  while (Date.now() < deadline) {
    const codeNow = await publicClient.getBytecode({ address: delegateSmartAccount.address })
    if (codeNow && codeNow !== '0x') {
      console.log('[delegate] Déploiement détecté on-chain via fallback (bytecode présent).')
      return
    }
    await new Promise(r => setTimeout(r, 3000))
  }

  console.error('[delegate] Échec: ni receipt bundler dans le délai, ni bytecode on-chain détecté. Vérifier le dashboard ZeroDev et la policy du paymaster.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
