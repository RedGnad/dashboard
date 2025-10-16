import { useState, useEffect, useCallback } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import { 
  createDelegatorSmartAccount, 
  createDelegateSmartAccount, 
  deploySmartAccount 
} from '../lib/accounts'
import { 
  getOrCreateDelegation, 
  redeemSwapDelegation, 
  redeemUnwrapDelegation 
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
}

export function useDcaDelegation() {
  const { address, isConnected } = useAccount()
  const { data: walletClient } = useWalletClient()
  const [delegatorSmartAccount, setDelegatorSmartAccount] = useState<any>(null)
  const [delegateSmartAccount, setDelegateSmartAccount] = useState<any>(null)
  const [signedDelegation, setSignedDelegation] = useState<any>(null)
  const [dcaStatus, setDcaStatus] = useState<DcaStatus>({ isActive: false })
  const [balances, setBalances] = useState<Balances>({ MON: '0.0', USDC: '0.0', WMON: '0.0' })
  const [isLoading, setIsLoading] = useState(false)
  const [isInitialized, setIsInitialized] = useState(false)

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

  // Execute DCA swap
  const executeDcaSwap = useCallback(async (usdcAmount: string, slippageBps: number) => {
    if (!delegateSmartAccount || !signedDelegation || !delegatorSmartAccount) {
      throw new Error('Smart accounts not initialized')
    }

    const userOpHash = await redeemSwapDelegation(
      delegateSmartAccount,
      signedDelegation,
      usdcAmount,
      slippageBps,
      delegatorSmartAccount.address as `0x${string}`
    )

    setDcaStatus(prev => ({ ...prev, lastUserOpHash: userOpHash }))
    await refreshBalances()
    
    return userOpHash
  }, [delegateSmartAccount, signedDelegation, delegatorSmartAccount, refreshBalances])

  // Start DCA with immediate execution
  const startDca = useCallback(async (usdcAmount: string, slippageBps: number, intervalSeconds: number) => {
    setIsLoading(true)
    try {
      
      await executeDcaSwap(usdcAmount, slippageBps)

      
      dcaScheduler.start({
        intervalSeconds,
        onExecute: async () => {
          await executeDcaSwap(usdcAmount, slippageBps)
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
  }, [executeDcaSwap, delegatorSmartAccount])

  // Stop DCA
  const stopDca = useCallback(() => {
    dcaScheduler.stop()
    setDcaStatus(prev => ({ ...prev, isActive: false, nextExecution: undefined }))
  }, [])

  // Run DCA once
  const runNow = useCallback(async (usdcAmount: string, slippageBps: number) => {
    setIsLoading(true)
    try {
      await executeDcaSwap(usdcAmount, slippageBps)
    } finally {
      setIsLoading(false)
    }
  }, [executeDcaSwap, delegatorSmartAccount])

  // Unwrap all WMON to MON
  const unwrapAll = useCallback(async () => {
    if (!delegateSmartAccount || !signedDelegation) {
      throw new Error('Smart accounts not initialized')
    }

    setIsLoading(true)
    try {
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
      setIsLoading(false)
    }
  }, [delegateSmartAccount, signedDelegation, balances.WMON, refreshBalances])

  // Initialize on connection
  useEffect(() => {
    if (isConnected && address && !isInitialized) {
      initialize()
    }
  }, [isConnected, address, isInitialized, walletClient, initialize])

  // Clean up on disconnect
  useEffect(() => {
    if (!isConnected) {
      setIsInitialized(false)
      setDelegatorSmartAccount(null)
      setDelegateSmartAccount(null)
      setSignedDelegation(null)
      setDcaStatus({ isActive: false })
      setBalances({ MON: '0.0', USDC: '0.0', WMON: '0.0' })
      dcaScheduler.stop()
    }
  }, [isConnected])

  // Function to clear cache (for debugging)
  const clearCache = useCallback(() => {
    if (address) {
      const cacheKey = `dca-smart-accounts-${address}`
      localStorage.removeItem(cacheKey)
      localStorage.removeItem('dca-delegation')
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
    startDca,
    stopDca,
    runNow,
    unwrapAll,
    refreshBalances: () => refreshBalances(),
    reinitialize: initialize,
    clearCache,
  }
}
