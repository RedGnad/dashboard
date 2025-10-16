import { privateKeyToAccount } from 'viem/accounts'
import { Implementation, toMetaMaskSmartAccount, getDeleGatorEnvironment } from '@metamask/delegation-toolkit'
import { publicClient, bundlerClient, paymasterClient } from './clients'
import { CHAIN_ID } from './chain'

// Create delegate account from private key (for executing delegated actions)
export function createDelegateAccount() {
  const privateKey = import.meta.env.VITE_DELEGATE_PRIVATE_KEY as `0x${string}`
  if (!privateKey) {
    throw new Error('VITE_DELEGATE_PRIVATE_KEY not configured')
  }
  return privateKeyToAccount(privateKey)
}

// Create delegator smart account (user's smart account that will delegate permissions)
export async function createDelegatorSmartAccount(walletClient: any) {
  const addresses = await walletClient.getAddresses()
  const owner = addresses[0]

  if (!owner) {
    throw new Error('No wallet address found')
  }

  const smartAccount = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [owner, [], [], []], // [owner, passkeys, passkeyValidators, passkeyValidatorData]
    deploySalt: '0x',
    signer: { walletClient },
    environment: getDeleGatorEnvironment(CHAIN_ID) as any,
  })

  return smartAccount
}

// Create delegate smart account (smart account that will receive delegation)
export async function createDelegateSmartAccount() {
  const delegateAccount = createDelegateAccount()

  const smartAccount = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [delegateAccount.address, [], [], []],
    deploySalt: '0x',
    signer: { account: delegateAccount },
    environment: getDeleGatorEnvironment(CHAIN_ID) as any,
  })

  return smartAccount
}

// Check if smart account is deployed (DTK deploys automatically on first UserOp)
export async function deploySmartAccount(smartAccount: any) {
  const cacheKey = `sa-deployed-${smartAccount.address}`

  // Always verify on-chain status
  const code = await publicClient.getBytecode({ address: smartAccount.address })
  if (code && code !== '0x') {
    console.log(`[deploy] Smart account ${smartAccount.address} already deployed (on-chain)`)
    localStorage.setItem(cacheKey, 'true')
    return smartAccount.address
  }

  const cachedDeployment = localStorage.getItem(cacheKey)
  if (cachedDeployment === 'true') {
    console.log(`[deploy] Smart account ${smartAccount.address} marked deployed (cached) but no code found on-chain`)
    localStorage.removeItem(cacheKey)
  }

  console.log(`[deploy] Smart account ${smartAccount.address} not yet deployed - will deploy on first UserOperation`)
  return smartAccount.address
}
