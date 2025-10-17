import { useState, useEffect, useCallback } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import { 
  createDelegatorSmartAccount, 
  createDelegateSmartAccount, 
  deploySmartAccount 
} from '../lib/accounts'
import { 
  getOrCreateDelegation, 
  redeemUnwrapDelegation,
  isDelegationExpired,
  createCoreDelegation,
  getOrCreateValueDelegation,
  redeemValueTransferDelegation,
  getOrCreateNativeSwapDelegation,
  redeemNativeSwapDelegation
} from '../lib/delegation'
import { getAllBalances } from '../lib/balances'
import { validateEnv } from '../lib/clients'
import { dcaScheduler } from '../lib/scheduler'
import { parseUnits } from 'viem'

interface DcaStatus {
  isActive: boolean
  nextExecution?: Date
  lastUserOpHash?: string
  lastError?: string
}

interface Balances {
  MON: string
  USDC: string
  WMON: string
  CHOG: string
}

export function useDcaDelegation() {
  const { address, isConnected } = useAccount()
  const { data: walletClient } = useWalletClient()
  const [delegatorSmartAccount, setDelegatorSmartAccount] = useState<any>(null)
  const [delegateSmartAccount, setDelegateSmartAccount] = useState<any>(null)
  const [signedDelegation, setSignedDelegation] = useState<any>(null)
  const [dcaStatus, setDcaStatus] = useState<DcaStatus>({ isActive: false })
  const [balances, setBalances] = useState<Balances>({ MON: '0.0', USDC: '0.0', WMON: '0.0', CHOG: '0.0' })
  const [isLoading, setIsLoading] = useState(false)
  const [isInitialized, setIsInitialized] = useState(false)
  const [delegationExpiresAt, setDelegationExpiresAt] = useState<number | undefined>(undefined)
  const [delegationExpired, setDelegationExpired] = useState(false)
  const [isExecuting, setIsExecuting] = useState(false)

  // Initialize smart accounts and delegation
  const initialize = useCallback(async () => {
    if (!isConnected || !address || isInitialized || !walletClient) return

    setIsLoading(true)
    try {
      console.log('[init] validating environment...')
      const ok = validateEnv()
      if (!ok) {
        throw new Error('Missing environment variables. Please check VITE_RPC_URL, VITE_ZERO_DEV_BUNDLER_RPC, VITE_DELEGATE_PRIVATE_KEY.')
      }

      // Check if we have cached smart accounts for this address
      const cacheKey = `dca-smart-accounts-${address}`
      const cached = localStorage.getItem(cacheKey)
      
      let delegatorSA, delegateSA
      
      if (cached) {
        try {
          const { delegatorAddress, delegateAddress } = JSON.parse(cached)
          console.log('[init] found cached smart accounts')
          console.log('Cached Delegator SA:', delegatorAddress)
          console.log('Cached Delegate SA:', delegateAddress)
          
          // Recreate smart account objects (they're deterministic)
          delegatorSA = await createDelegatorSmartAccount(walletClient)
          delegateSA = await createDelegateSmartAccount()
          
          // Verify addresses match cache
          if (delegatorSA.address === delegatorAddress && delegateSA.address === delegateAddress) {
            console.log('[init] using cached smart accounts')
          } else {
            console.log('[init] cache mismatch, creating new accounts')
            throw new Error('Cache mismatch')
          }
        } catch (error) {
          console.log('[init] cache invalid, creating new accounts')
          localStorage.removeItem(cacheKey)
          delegatorSA = await createDelegatorSmartAccount(walletClient)
          delegateSA = await createDelegateSmartAccount()
        }
      } else {
        console.log('[init] creating new smart accounts...')
        delegatorSA = await createDelegatorSmartAccount(walletClient)
        delegateSA = await createDelegateSmartAccount()
        
        // Cache the addresses
        localStorage.setItem(cacheKey, JSON.stringify({
          delegatorAddress: delegatorSA.address,
          delegateAddress: delegateSA.address
        }))
      }
      
      console.log('Delegator SA:', delegatorSA.address)
      console.log('Delegate SA:', delegateSA.address)

      // Deploy smart accounts if needed (this checks if already deployed)
      console.log('[init] ensuring smart accounts are deployed...')
      await deploySmartAccount(delegatorSA)
      await deploySmartAccount(delegateSA)

      // Create or get delegation (this also uses localStorage cache)
      console.log('[init] setting up delegation...')
      const delegation = await getOrCreateDelegation(delegatorSA, delegateSA)
      
      setDelegatorSmartAccount(delegatorSA)
      setDelegateSmartAccount(delegateSA)
      setSignedDelegation(delegation)
      setDelegationExpiresAt(delegation?.expiresAt)
      setDelegationExpired(isDelegationExpired(delegation))
      setIsInitialized(true)

      // Load initial balances
      await refreshBalances(delegatorSA.address)
      
      console.log('[init] initialization complete')
    } catch (error) {
      console.error('Initialization failed:', error)
      setDcaStatus(prev => ({ ...prev, lastError: (error as Error).message }))
    } finally {
      setIsLoading(false)
    }
  }, [isConnected, address, isInitialized, walletClient])

  // Refresh balances
  const refreshBalances = useCallback(async (accountAddress?: string) => {
    const targetAddress = accountAddress || delegatorSmartAccount?.address
    if (!targetAddress) return

    try {
      const newBalances = await getAllBalances(targetAddress)
      setBalances(newBalances)
    } catch (error) {
      console.error('Failed to refresh balances:', error)
    }
  }, [delegatorSmartAccount])

  // Native DCA: execute one MON -> token swap
  const runNativeSwapMonToToken = useCallback(async (amountMon: string, slippageBps: number, outToken: `0x${string}`) => {
    if (!delegateSmartAccount || !delegatorSmartAccount || !signedDelegation) throw new Error('Smart accounts not initialized')
    if (isDelegationExpired(signedDelegation)) throw new Error('Delegation expired. Please renew the delegation to continue.')
    if (isExecuting) throw new Error('An operation is already in progress. Please wait for it to complete.')
    setIsExecuting(true)
    setIsLoading(true)
    try {
      const uoHash = await redeemNativeSwapDelegation(
        delegateSmartAccount,
        signedDelegation,
        amountMon,
        slippageBps,
        outToken,
        delegatorSmartAccount.address as `0x${string}`
      )
      setDcaStatus(prev => ({ ...prev, lastUserOpHash: uoHash }))
      await refreshBalances()
      return uoHash
    } finally {
      setIsExecuting(false)
      setIsLoading(false)
    }
  }, [delegateSmartAccount, delegatorSmartAccount, signedDelegation, isExecuting, refreshBalances])

  // Start Native DCA with immediate execution and scheduler
  const startNativeDca = useCallback(async (amountMon: string, slippageBps: number, outToken: `0x${string}`, intervalSeconds: number) => {
    setIsLoading(true)
    try {
      await runNativeSwapMonToToken(amountMon, slippageBps, outToken)
      dcaScheduler.start({
        intervalSeconds,
        onExecute: async () => {
          await runNativeSwapMonToToken(amountMon, slippageBps, outToken)
        },
        onError: (error) => {
          setDcaStatus(prev => ({ ...prev, lastError: error.message }))
        },
        onStatusChange: (isActive, nextExecution) => {
          setDcaStatus(prev => ({ ...prev, isActive, nextExecution }))
        }
      })
    } catch (error) {
      setDcaStatus(prev => ({ ...prev, lastError: (error as Error).message }))
      throw error
    } finally {
      setIsLoading(false)
    }
  }, [runNativeSwapMonToToken])

  // Run Native DCA once (shortcut)
  const runNativeNow = useCallback(async (amountMon: string, slippageBps: number, outToken: `0x${string}`) => {
    setIsLoading(true)
    try {
      await runNativeSwapMonToToken(amountMon, slippageBps, outToken)
    } finally {
      setIsLoading(false)
    }
  }, [runNativeSwapMonToToken])

  // Stop DCA
  const stopDca = useCallback(() => {
    dcaScheduler.stop()
    setDcaStatus(prev => ({ ...prev, isActive: false, nextExecution: undefined }))
  }, [])

  // Unwrap all WMON to MON
  const unwrapAll = useCallback(async () => {
    if (!delegateSmartAccount || !signedDelegation) {
      throw new Error('Smart accounts not initialized')
    }
    if (isDelegationExpired(signedDelegation)) {
      throw new Error('Delegation expired. Please renew the delegation to continue.')
    }

    setIsLoading(true)
    try {
      if (isExecuting) {
        throw new Error('An operation is already in progress. Please wait for it to complete.')
      }
      setIsExecuting(true)
      const wmonAmount = parseUnits(balances.WMON, 18)
      if (wmonAmount === 0n) {
        throw new Error('No WMON to unwrap')
      }

      const userOpHash = await redeemUnwrapDelegation(
        delegateSmartAccount,
        signedDelegation,
        wmonAmount
      )

      setDcaStatus(prev => ({ ...prev, lastUserOpHash: userOpHash }))
      await refreshBalances()
      
      return userOpHash
    } finally {
      setIsExecuting(false)
      setIsLoading(false)
    }
  }, [delegateSmartAccount, signedDelegation, balances.WMON, refreshBalances])

  const renewDelegation = useCallback(async () => {
    if (!delegatorSmartAccount || !delegateSmartAccount) {
      throw new Error('Smart accounts not initialized')
    }
    setIsLoading(true)
    try {
      const newDelegation = await createCoreDelegation(delegatorSmartAccount, delegateSmartAccount)
      setSignedDelegation(newDelegation)
      setDelegationExpiresAt(newDelegation?.expiresAt)
      setDelegationExpired(isDelegationExpired(newDelegation))
      return newDelegation
    } finally {
      setIsLoading(false)
    }
  }, [delegatorSmartAccount, delegateSmartAccount])

  // Top up MON from EOA to Delegator SA
  const topUpMon = useCallback(async (amountMon: string) => {
    if (!walletClient || !address || !delegatorSmartAccount) throw new Error('Wallet not ready')
    setIsLoading(true)
    try {
      const value = parseUnits(amountMon, 18)
      const hash = await walletClient.sendTransaction({
        account: address as `0x${string}`,
        to: delegatorSmartAccount.address as `0x${string}`,
        value,
      })
      console.log('[topup] tx hash:', hash)
      await refreshBalances(delegatorSmartAccount.address)
      return hash
    } finally {
      setIsLoading(false)
    }
  }, [walletClient, address, delegatorSmartAccount, refreshBalances])

  // Withdraw MON from Delegator SA to EOA via value delegation (scope none + caveats)
  const withdrawMon = useCallback(async (amountMon: string) => {
    if (!delegateSmartAccount || !delegatorSmartAccount || !address) throw new Error('Smart accounts not initialized')
    if (isExecuting) throw new Error('An operation is already in progress. Please wait for it to complete.')
    setIsExecuting(true)
    try {
      const amountWei = parseUnits(amountMon, 18)
      const valueDelegation = await getOrCreateValueDelegation(
        delegatorSmartAccount,
        delegateSmartAccount,
        address as `0x${string}`,
        amountWei
      )
      const uoHash = await redeemValueTransferDelegation(
        delegateSmartAccount,
        valueDelegation,
        address as `0x${string}`,
        amountWei
      )
      setDcaStatus(prev => ({ ...prev, lastUserOpHash: uoHash }))
      await refreshBalances()
      return uoHash
    } finally {
      setIsExecuting(false)
    }
  }, [delegateSmartAccount, delegatorSmartAccount, address, isExecuting, refreshBalances])

  // Native swap: MON -> token (e.g., USDC) via router.swapExactETHForTokens
  // moved above and enhanced with isLoading + expiry checks

  // Initialize on connection
  useEffect(() => {
    if (isConnected && address && !isInitialized) {
      initialize()
    }
  }, [isConnected, address, isInitialized, walletClient, initialize])

  // Periodic light refresh of balances
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      if (isInitialized && delegatorSmartAccount) {
        refreshBalances(delegatorSmartAccount.address)
      }
    }, 2000)
    return () => clearInterval(id)
  }, [isInitialized, delegatorSmartAccount, refreshBalances])

  // Clean up on disconnect
  useEffect(() => {
    if (!isConnected) {
      setIsInitialized(false)
      setDelegatorSmartAccount(null)
      setDelegateSmartAccount(null)
      setSignedDelegation(null)
      setDcaStatus({ isActive: false })
      setBalances({ MON: '0.0', USDC: '0.0', WMON: '0.0', CHOG: '0.0' })
      dcaScheduler.stop()
    }
  }, [isConnected])

  // Function to clear cache (for debugging)
  const clearCache = useCallback(() => {
    if (address) {
      const cacheKey = `dca-smart-accounts-${address}`
      localStorage.removeItem(cacheKey)
      localStorage.removeItem('dca-delegation')
      localStorage.removeItem('dca-value-delegation')
      localStorage.removeItem('dca-native-swap-delegation')
      // Clear deployment cache for both accounts
      if (delegatorSmartAccount) {
        localStorage.removeItem(`sa-deployed-${delegatorSmartAccount.address}`)
      }
      if (delegateSmartAccount) {
        localStorage.removeItem(`sa-deployed-${delegateSmartAccount.address}`)
      }
      console.log('[cache] cleared all cache for', address)
    }
  }, [address, delegatorSmartAccount, delegateSmartAccount])

  return {
    // State
    isInitialized,
    isLoading,
    dcaStatus,
    balances,
    delegatorSmartAccount,
    delegateSmartAccount,
    
    // Actions
    stopDca,
    startNativeDca,
    runNativeNow,
    unwrapAll,
    topUpMon,
    withdrawMon,
    runNativeSwapMonToToken,
    refreshBalances: () => refreshBalances(),
    reinitialize: initialize,
    clearCache,
    delegationExpired,
    delegationExpiresAt,
    renewDelegation,
  }
}
