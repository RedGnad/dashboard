import { useState, useEffect, useCallback, useRef } from 'react'
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
  redeemNativeSwapDelegation,
  redeemSwapDelegation,
  redeemSwapChogDelegation,
  redeemSwapErc20ToWmonDelegation,
  redeemErc20TransferDelegation,
  redeemSwapErc20ToErc20Delegation
} from '../lib/delegation'
import { TOKENS, WMON } from '../lib/tokens'
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

interface Balances extends Record<string, string> {
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

  const opQueueRef = useRef<Array<() => Promise<void>>>([])
  const processingRef = useRef(false)
  const lastDcaConfigRef = useRef<null | {
    mode: 'manual' | 'ai'
    amountMon: string
    slippageBps: number
    outToken: `0x${string}`
    intervalSeconds: number
    conditionCallback?: (ctx: { mode: 'manual' | 'ai', balances: Record<string, string>, outToken: `0x${string}` }) => Promise<{ allow: boolean, stop?: boolean, reason?: string }>
  }>(null)
  const lastAiCallbackRef = useRef<null | ((balances: Record<string, string>) => Promise<{ amount: string, token: `0x${string}`, interval: number } | null>)>(null)

  const processQueue = useCallback(async () => {
    if (processingRef.current) return
    processingRef.current = true
    try {
      while (opQueueRef.current.length) {
        setIsExecuting(true)
        try {
          const job = opQueueRef.current.shift()!
          await job()
        } finally {
          setIsExecuting(false)
        }
      }
    } finally {
      processingRef.current = false
    }
  }, [])

  const enqueueOp = useCallback((fn: () => Promise<void>) => {
    return new Promise<void>((resolve, reject) => {
      opQueueRef.current.push(async () => {
        try {
          await fn()
          resolve()
        } catch (e) {
          reject(e)
          throw e
        }
      })
      void processQueue()
    })
  }, [processQueue])

  // Function to clear cache (for debugging)
  const clearCache = useCallback(() => {
    if (address) {
      const cacheKey = `dca-smart-accounts-${address}`
      localStorage.removeItem(cacheKey)
      localStorage.removeItem('dca-delegation')
      localStorage.removeItem('dca-value-delegation')
      localStorage.removeItem('dca-native-swap-delegation')
      // Remove scoped delegation cache if available
      if (delegatorSmartAccount && delegateSmartAccount) {
        try {
          const scopedKey = `dca-delegation-${delegatorSmartAccount.address.toLowerCase()}-${delegateSmartAccount.address.toLowerCase()}`
          localStorage.removeItem(scopedKey)
        } catch {}
      }
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

      // Create or get delegation using helper that validates scope/targets/selectors
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
  const runNativeSwapMonToToken = useCallback(async (amountMon: string, slippageBps: number, outToken: `0x${string}`, allowWhenQueued: boolean = false) => {
    if (!delegateSmartAccount || !delegatorSmartAccount || !signedDelegation) throw new Error('Smart accounts not initialized')
    if (isDelegationExpired(signedDelegation)) throw new Error('Delegation expired. Please renew the delegation to continue.')
    if (isExecuting && !allowWhenQueued) throw new Error('An operation is already in progress. Please wait for it to complete.')
    if (outToken?.toLowerCase?.() === (WMON as string).toLowerCase()) {
      throw new Error('Invalid target token for native swap: WMON. Please choose a non-WMON token.')
    }
    setIsExecuting(true)
    setIsLoading(true)
    try {
      // Pre-check sufficient MON to avoid opaque simulation errors
      const latest = await getAllBalances(delegatorSmartAccount.address as `0x${string}`)
      setBalances(latest)
      const need = parseUnits(amountMon, 18)
      const have = parseUnits(latest.MON || '0', 18)
      if (have < need) {
        throw new Error(`Insufficient MON in Delegator SA. Need ${amountMon}, have ${latest.MON || '0'}. Top up or reduce the amount.`)
      }

      const uoHash = await redeemNativeSwapDelegation(
        delegateSmartAccount,
        signedDelegation,
        amountMon,
        slippageBps,
        outToken,
        delegatorSmartAccount.address as `0x${string}`
      )
      setDcaStatus(prev => ({ ...prev, lastUserOpHash: uoHash, lastError: undefined }))
      await refreshBalances()
      return uoHash
    } finally {
      setIsExecuting(false)
      setIsLoading(false)
    }
  }, [delegateSmartAccount, delegatorSmartAccount, signedDelegation, isExecuting, refreshBalances])

  const runErc20SwapToToken = useCallback(async (
    tokenIn: `0x${string}`,
    tokenInDecimals: number,
    amountIn: string,
    slippageBps: number,
    tokenOut: `0x${string}`
  ) => {
    if (!delegateSmartAccount || !delegatorSmartAccount || !signedDelegation) throw new Error('Smart accounts not initialized')
    setIsExecuting(true)
    setIsLoading(true)
    try {
      const delegatorAddr = delegatorSmartAccount.address as `0x${string}`
      const uoHash = await redeemSwapErc20ToErc20Delegation(
        delegateSmartAccount,
        signedDelegation,
        tokenIn,
        tokenInDecimals,
        amountIn,
        slippageBps,
        tokenOut,
        delegatorAddr
      )
      setDcaStatus(prev => ({ ...prev, lastUserOpHash: uoHash, lastError: undefined }))
      await refreshBalances()
      return uoHash
    } finally {
      setIsExecuting(false)
      setIsLoading(false)
    }
  }, [delegateSmartAccount, delegatorSmartAccount, signedDelegation, refreshBalances])

  // Start Native DCA with immediate execution and scheduler
  const startNativeDca = useCallback(async (amountMon: string, slippageBps: number, outToken: `0x${string}`, intervalSeconds: number, aiEnabled: boolean = false, aiCallback?: (balances: Record<string, string>) => Promise<{ amount: string, token: `0x${string}`, interval: number } | null>, conditionCallback?: (ctx: { mode: 'manual' | 'ai', balances: Record<string, string>, outToken: `0x${string}` }) => Promise<{ allow: boolean, stop?: boolean, reason?: string }>) => {
    setIsLoading(true)
    try {
      if (!aiEnabled) {
        // Manual DCA mode
        lastDcaConfigRef.current = { mode: 'manual', amountMon, slippageBps, outToken, intervalSeconds, conditionCallback }
        lastAiCallbackRef.current = null
        let allowNow = true
        let stopNow = false
        if (conditionCallback) {
          try {
            const res = await conditionCallback({ mode: 'manual', balances: balances as Record<string, string>, outToken })
            allowNow = res?.allow !== false
            stopNow = !!res?.stop
          } catch {}
        }
        if (stopNow) {
          dcaScheduler.stop()
          setDcaStatus(prev => ({ ...prev, isActive: false, nextExecution: undefined }))
        }
        if (allowNow) {
          await enqueueOp(() => runNativeSwapMonToToken(amountMon, slippageBps, outToken, true))
        }
        dcaScheduler.start({
          intervalSeconds,
          onExecute: async () => {
            const cfg = lastDcaConfigRef.current
            if (cfg?.conditionCallback) {
              try {
                const res = await cfg.conditionCallback({ mode: 'manual', balances: balances as Record<string, string>, outToken })
                if (res?.stop) {
                  dcaScheduler.stop()
                  setDcaStatus(prev => ({ ...prev, isActive: false, nextExecution: undefined }))
                  return
                }
                if (res && res.allow === false) return
              } catch {}
            }
            await enqueueOp(() => runNativeSwapMonToToken(amountMon, slippageBps, outToken, true))
          },
          onError: (error) => {
            setDcaStatus(prev => ({ ...prev, lastError: error.message }))
          },
          onStatusChange: (isActive, nextExecution) => {
            setDcaStatus(prev => ({ ...prev, isActive, nextExecution }))
          }
        })
      } else {
        // AI-controlled DCA mode
        let currentInterval = intervalSeconds
        lastDcaConfigRef.current = { mode: 'ai', amountMon, slippageBps, outToken, intervalSeconds, conditionCallback }
        lastAiCallbackRef.current = aiCallback || null

        // Immediate AI decision and execution before starting scheduler
        if (aiCallback) {
          try {
            const firstDecision = await aiCallback(balances as Record<string, string>)
            if (firstDecision) {
              const src = (firstDecision as any).sourceToken as string | undefined
              if (src && src.toUpperCase() !== 'MON') {
                const meta = TOKENS[src.toUpperCase() as keyof typeof TOKENS]
                if (meta && !meta.isNative) {
                  let allowed = true
                  let stop = false
                  if (conditionCallback) {
                    try {
                      const res = await conditionCallback({ mode: 'ai', balances: balances as Record<string, string>, outToken: firstDecision.token })
                      allowed = res?.allow !== false
                      stop = !!res?.stop
                    } catch {}
                  }
                  if (stop) {
                    dcaScheduler.stop()
                    setDcaStatus(prev => ({ ...prev, isActive: false, nextExecution: undefined }))
                  }
                  if (allowed) await enqueueOp(() => runErc20SwapToToken(meta.address as `0x${string}`, meta.decimals, (firstDecision as any).amount, slippageBps, firstDecision.token))
                } else {
                  let allowed = true
                  let stop = false
                  if (conditionCallback) {
                    try {
                      const res = await conditionCallback({ mode: 'ai', balances: balances as Record<string, string>, outToken: firstDecision.token })
                      allowed = res?.allow !== false
                      stop = !!res?.stop
                    } catch {}
                  }
                  if (stop) {
                    dcaScheduler.stop()
                    setDcaStatus(prev => ({ ...prev, isActive: false, nextExecution: undefined }))
                  }
                  if (allowed) await enqueueOp(() => runNativeSwapMonToToken(firstDecision.amount, slippageBps, firstDecision.token, true))
                }
              } else {
                let allowed = true
                let stop = false
                if (conditionCallback) {
                  try {
                    const res = await conditionCallback({ mode: 'ai', balances: balances as Record<string, string>, outToken: firstDecision.token })
                    allowed = res?.allow !== false
                    stop = !!res?.stop
                  } catch {}
                }
                if (stop) {
                  dcaScheduler.stop()
                  setDcaStatus(prev => ({ ...prev, isActive: false, nextExecution: undefined }))
                }
                if (allowed) await enqueueOp(() => runNativeSwapMonToToken(firstDecision.amount, slippageBps, firstDecision.token, true))
              }
              currentInterval = firstDecision.interval
            }
          } catch (e) {
            await enqueueOp(() => runNativeSwapMonToToken(amountMon, slippageBps, outToken, true))
          }
        }

        dcaScheduler.start({
          intervalSeconds: currentInterval,
          onExecute: async () => {
            if (aiCallback) {
              try {
                const aiDecision = await aiCallback(balances as Record<string, string>)
                if (aiDecision) {
                  const src = (aiDecision as any).sourceToken as string | undefined
                  if (src && src.toUpperCase() !== 'MON') {
                    const meta = TOKENS[src.toUpperCase() as keyof typeof TOKENS]
                    if (meta && !meta.isNative) {
                      const cfg = lastDcaConfigRef.current
                      if (cfg?.conditionCallback) {
                        try {
                          const res = await cfg.conditionCallback({ mode: 'ai', balances: balances as Record<string, string>, outToken: aiDecision.token })
                          if (res?.stop) {
                            dcaScheduler.stop()
                            setDcaStatus(prev => ({ ...prev, isActive: false, nextExecution: undefined }))
                            return
                          }
                          if (res && res.allow === false) return
                        } catch {}
                      }
                      await enqueueOp(() => runErc20SwapToToken(meta.address as `0x${string}`, meta.decimals, (aiDecision as any).amount, slippageBps, aiDecision.token))
                    } else {
                      const cfg = lastDcaConfigRef.current
                      if (cfg?.conditionCallback) {
                        try {
                          const res = await cfg.conditionCallback({ mode: 'ai', balances: balances as Record<string, string>, outToken: aiDecision.token })
                          if (res?.stop) {
                            dcaScheduler.stop()
                            setDcaStatus(prev => ({ ...prev, isActive: false, nextExecution: undefined }))
                            return
                          }
                          if (res && res.allow === false) return
                        } catch {}
                      }
                      await enqueueOp(() => runNativeSwapMonToToken(aiDecision.amount, slippageBps, aiDecision.token, true))
                    }
                  } else {
                    const cfg = lastDcaConfigRef.current
                    if (cfg?.conditionCallback) {
                      try {
                        const res = await cfg.conditionCallback({ mode: 'ai', balances: balances as Record<string, string>, outToken: aiDecision.token })
                        if (res?.stop) {
                          dcaScheduler.stop()
                          setDcaStatus(prev => ({ ...prev, isActive: false, nextExecution: undefined }))
                          return
                        }
                        if (res && res.allow === false) return
                      } catch {}
                    }
                    await enqueueOp(() => runNativeSwapMonToToken(aiDecision.amount, slippageBps, aiDecision.token, true))
                  }
                  // Update interval for next execution
                  currentInterval = aiDecision.interval
                  dcaScheduler.updateInterval(currentInterval)
                } else {
                  // AI decided to HOLD - just wait for next interval
                  console.log('[ai-dca] AI decided to HOLD')
                }
              } catch (error) {
                console.error('[ai-dca] AI decision failed, falling back to manual params:', error)
                await enqueueOp(() => runNativeSwapMonToToken(amountMon, slippageBps, outToken, true))
              }
            } else {
              // Fallback to manual if no AI callback
              await enqueueOp(() => runNativeSwapMonToToken(amountMon, slippageBps, outToken, true))
            }
          },
          onError: (error) => {
            setDcaStatus(prev => ({ ...prev, lastError: error.message }))
          },
          onStatusChange: (isActive, nextExecution) => {
            setDcaStatus(prev => ({ ...prev, isActive, nextExecution }))
          }
        })
      }
    } catch (error) {
      setDcaStatus(prev => ({ ...prev, lastError: (error as Error).message }))
      throw error
    } finally {
      setIsLoading(false)
    }
  }, [runNativeSwapMonToToken, balances])

  // Run Native DCA once (shortcut)
  const runNativeNow = useCallback(async (amountMon: string, slippageBps: number, outToken: `0x${string}`) => {
    await enqueueOp(async () => {
      setIsLoading(true)
      try {
        await runNativeSwapMonToToken(amountMon, slippageBps, outToken, true)
      } finally {
        setIsLoading(false)
      }
    })
  }, [enqueueOp, runNativeSwapMonToToken])

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

  // Withdraw a specific ERC20 token to EOA (full balance if amount not provided)
  const withdrawToken = useCallback(async (symbol: string, amount?: string) => {
    if (!delegateSmartAccount || !delegatorSmartAccount || !address) {
      throw new Error('Smart accounts not initialized')
    }
    const token = TOKENS[symbol as keyof typeof TOKENS]
    if (!token || token.isNative) throw new Error('Unsupported token')
    const balanceStr = (balances as any)[symbol] || '0'
    const amt = (amount && amount !== '') ? amount : balanceStr
    try {
      const fresh = await getOrCreateDelegation(delegatorSmartAccount, delegateSmartAccount)
      if (fresh && fresh !== signedDelegation) setSignedDelegation(fresh)
      const uoHash = await redeemErc20TransferDelegation(
        delegateSmartAccount,
        fresh || signedDelegation,
        token.address as `0x${string}`,
        token.decimals,
        amt,
        address as `0x${string}`
      )
      setDcaStatus(prev => ({ ...prev, lastUserOpHash: uoHash }))
      await refreshBalances()
      return uoHash
    } catch (e: any) {
      const msg = (e?.message || '').toString()
      if (msg.includes('AllowedMethodsEnforcer') || msg.includes('method-not-allowed')) {
        const renewed = await createCoreDelegation(delegatorSmartAccount, delegateSmartAccount)
        setSignedDelegation(renewed)
        const uoHash = await redeemErc20TransferDelegation(
          delegateSmartAccount,
          renewed,
          token.address as `0x${string}`,
          token.decimals,
          amt,
          address as `0x${string}`
        )
        setDcaStatus(prev => ({ ...prev, lastUserOpHash: uoHash }))
        await refreshBalances()
        return uoHash
      }
      throw e
    }
  }, [delegateSmartAccount, delegatorSmartAccount, signedDelegation, address, balances, refreshBalances])

  // Withdraw all ERC20 tokens (non-native, excluding WMON) to EOA
  const withdrawAllTokens = useCallback(async () => {
    if (!delegateSmartAccount || !delegatorSmartAccount || !address) {
      throw new Error('Smart accounts not initialized')
    }
    await enqueueOp(async () => {
      setIsLoading(true)
      try {
        const fresh = (signedDelegation && !isDelegationExpired(signedDelegation)) ? signedDelegation : null
        if (!fresh) {
          console.warn('[withdrawAllTokens] No valid ERC20 delegation; skipping token withdrawals to avoid extra signature')
        }
        let hadNonzero = false
        for (const t of Object.values(TOKENS)) {
          if (t.isNative || t.symbol === 'WMON') continue
          const balStr = (balances as any)[t.symbol] || '0'
          let hasBalance = false
          try {
            hasBalance = parseUnits(balStr, t.decimals) > 0n
          } catch {
            hasBalance = parseFloat(balStr) > 0
          }
          if (!hasBalance) continue
          hadNonzero = true
          if (!fresh) continue
          try {
            const uoHash = await redeemErc20TransferDelegation(
              delegateSmartAccount,
              fresh,
              t.address as `0x${string}`,
              t.decimals,
              balStr,
              address as `0x${string}`
            )
            setDcaStatus(prev => ({ ...prev, lastUserOpHash: uoHash }))
          } catch (err: any) {
            const msg = String(err?.message || '')
            if (msg.includes('AllowedMethodsEnforcer') || msg.includes('method-not-allowed') || msg.includes('expired')) {
              console.warn(`[withdrawAllTokens] Missing/expired scope for ${t.symbol}; skipping without prompting.`)
              continue
            }
            console.warn(`[withdrawAllTokens] ${t.symbol} withdraw failed:`, err)
          }
        }
        if (!fresh && hadNonzero) {
          setDcaStatus(prev => ({ ...prev, lastError: 'ERC20 skipped: missing/expired delegation. Click Renew.' }))
        }
        await refreshBalances()
      } finally {
        setIsLoading(false)
      }
    })
  }, [delegateSmartAccount, delegatorSmartAccount, signedDelegation, address, balances, enqueueOp, refreshBalances])

  

  const convertAllToMon = useCallback(async (slippageBps: number = 300) => {
    if (!delegateSmartAccount || !delegatorSmartAccount || !signedDelegation) {
      throw new Error('Smart accounts not initialized')
    }
    if (isDelegationExpired(signedDelegation)) {
      throw new Error('Delegation expired. Please renew the delegation to continue.')
    }

    if (dcaStatus.isActive) {
      dcaScheduler.stop()
      setDcaStatus(prev => ({ ...prev, isActive: false, nextExecution: undefined }))
    }

    await enqueueOp(async () => {
      // Stop manual DCA if active
      if (dcaStatus.isActive) {
        dcaScheduler.stop()
        setDcaStatus(prev => ({ ...prev, isActive: false, nextExecution: undefined }))
      }
      setIsLoading(true)
      try {
        const addr = delegatorSmartAccount.address as `0x${string}`
        console.log('[convertAllToMon] Starting conversion for address:', addr)
        console.log('[convertAllToMon] Current balances:', balances)

        // Convert every ERC20 (excluding WMON) into WMON
        for (const t of Object.values(TOKENS)) {
          if (t.isNative) continue // skip MON (native)
          if (t.symbol === 'WMON') continue // skip WMON (will unwrap later)
          const balStr = (balances as any)[t.symbol] || '0'
          let hasBalance = false
          try {
            const units = parseUnits(balStr, t.decimals)
            hasBalance = units > 0n
          } catch {
            const amt = parseFloat(balStr)
            hasBalance = amt > 0
          }
          if (!hasBalance) continue
          try {
            console.log(`[convertAllToMon] Converting ${t.symbol}:`, balStr)
            let uoHash: `0x${string}`
            if (t.symbol === 'USDC') {
              uoHash = await redeemSwapDelegation(
                delegateSmartAccount,
                signedDelegation,
                balStr,
                slippageBps,
                addr
              )
            } else if (t.symbol === 'CHOG') {
              uoHash = await redeemSwapChogDelegation(
                delegateSmartAccount,
                signedDelegation,
                balStr,
                slippageBps,
                addr
              )
            } else {
              uoHash = await redeemSwapErc20ToWmonDelegation(
                delegateSmartAccount,
                signedDelegation,
                t.address,
                t.decimals,
                balStr,
                slippageBps,
                addr
              )
            }
            console.log(`[convertAllToMon] ${t.symbol} conversion UO:`, uoHash)
            setDcaStatus(prev => ({ ...prev, lastUserOpHash: uoHash }))
          } catch (error) {
            console.warn(`[convertAllToMon] ${t.symbol} conversion failed:`, error)
            // Continue with other tokens
          }
        }

        // Refresh balances and unwrap WMON
        console.log('[convertAllToMon] Refreshing balances...')
        const latest = await getAllBalances(addr)
        setBalances(latest)
        console.log('[convertAllToMon] Updated balances:', latest)
        
        const wmonAmount = parseUnits(latest.WMON, 18)
        if (wmonAmount > 0n) {
          console.log('[convertAllToMon] Unwrapping WMON:', latest.WMON)
          const uoHash = await redeemUnwrapDelegation(
            delegateSmartAccount,
            signedDelegation,
            wmonAmount
          )
          console.log('[convertAllToMon] WMON unwrap UO:', uoHash)
          setDcaStatus(prev => ({ ...prev, lastUserOpHash: uoHash }))
        }

        // Final balance refresh
        await refreshBalances()
        console.log('[convertAllToMon] Conversion completed')
      } catch (error) {
        console.error('[convertAllToMon] Conversion failed:', error)
        setDcaStatus(prev => ({ ...prev, lastError: (error as Error).message }))
        throw error
      } finally {
        setIsLoading(false)
      }
    })
  }, [delegateSmartAccount, delegatorSmartAccount, signedDelegation, balances, enqueueOp, refreshBalances, dcaStatus.isActive])


  const renewDelegation = useCallback(async () => {
    if (!delegatorSmartAccount || !delegateSmartAccount) {
      throw new Error('Smart accounts not initialized')
    }
    setIsLoading(true)
    try {
      // Clear local caches before renewing to ensure fresh delegation scope and SA deployment state
      try { clearCache() } catch {}
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
      setDcaStatus(prev => ({ ...prev, lastError: undefined }))
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

  // Sell a specific ERC20 to MON (via WMON), optionally for a given amount. Defaults to full balance.
  const sellTokenToMon = useCallback(async (symbol: string, amount?: string, slippage: number = 300) => {
    if (!delegateSmartAccount || !delegatorSmartAccount || !signedDelegation) {
      throw new Error('Smart accounts not initialized')
    }
    const t = TOKENS[symbol as keyof typeof TOKENS]
    if (!t) throw new Error('Unknown token')
    if (t.isNative) throw new Error('Use value transfer for MON; selling MON is not supported')

    // Determine amount string (defaults to full balance string)
    const balStr = (balances as any)[symbol] || '0'
    const amt = (amount && amount !== '') ? amount : balStr
    if (!amt || parseFloat(amt) <= 0) throw new Error('Amount must be > 0')

    // Perform swap to WMON, or unwrap if token is WMON
    if (symbol === 'WMON') {
      const wmonAmount = parseUnits(amt, 18)
      if (wmonAmount === 0n) throw new Error('No WMON to unwrap')
      const uoHash = await redeemUnwrapDelegation(
        delegateSmartAccount,
        signedDelegation,
        wmonAmount
      )
      setDcaStatus(prev => ({ ...prev, lastUserOpHash: uoHash }))
      await refreshBalances()
      return uoHash
    }

    const delegatorAddr = delegatorSmartAccount.address as `0x${string}`
    let uoHash: `0x${string}`
    if (symbol === 'USDC') {
      uoHash = await redeemSwapDelegation(
        delegateSmartAccount,
        signedDelegation,
        amt,
        slippage,
        delegatorAddr
      )
    } else if (symbol === 'CHOG') {
      uoHash = await redeemSwapChogDelegation(
        delegateSmartAccount,
        signedDelegation,
        amt,
        slippage,
        delegatorAddr
      )
    } else {
      uoHash = await redeemSwapErc20ToWmonDelegation(
        delegateSmartAccount,
        signedDelegation,
        t.address,
        t.decimals,
        amt,
        slippage,
        delegatorAddr
      )
    }
    setDcaStatus(prev => ({ ...prev, lastUserOpHash: uoHash }))

    // After swap, unwrap any WMON to MON
    const latest = await getAllBalances(delegatorAddr)
    setBalances(latest)
    const wmonBal = parseUnits(latest.WMON || '0', 18)
    if (wmonBal > 0n) {
      const unwrapHash = await redeemUnwrapDelegation(
        delegateSmartAccount,
        signedDelegation,
        wmonBal
      )
      setDcaStatus(prev => ({ ...prev, lastUserOpHash: unwrapHash }))
    }
    await refreshBalances()
    return uoHash
  }, [delegateSmartAccount, delegatorSmartAccount, signedDelegation, balances, refreshBalances])

  // Withdraw all MON to EOA (uses current MON balance)
  const withdrawAllMon = useCallback(async () => {
    if (!delegatorSmartAccount) return
    const latest = await getAllBalances(delegatorSmartAccount.address)
    const monBal = latest.MON || '0'
    try {
      if (parseUnits(monBal, 18) > 0n) {
        await withdrawMon(monBal)
        // Second pass: attempt to withdraw residual dust if any
        try {
          await new Promise(res => setTimeout(res, 800))
        } catch {}
        const after = await getAllBalances(delegatorSmartAccount.address)
        const residualWei = parseUnits(after.MON || '0', 18)
        if (residualWei > 0n) {
          await withdrawMon(after.MON)
        }
      }
    } catch (e) {
      throw e
    }
  }, [delegatorSmartAccount, withdrawMon])

  // Withdraw all assets: pause DCA, pre-create value delegation (single prompt now), withdraw ERC20s, redeem MON, then resume DCA
  const withdrawAll = useCallback(async () => {
    if (!delegatorSmartAccount || !delegateSmartAccount || !address) throw new Error('Smart accounts not initialized')
    const wasActive = dcaStatus.isActive
    if (wasActive) {
      try { dcaScheduler.stop() } catch {}
      setDcaStatus(prev => ({ ...prev, isActive: false, nextExecution: undefined }))
    }
    // Prepare value delegation immediately to show the signature prompt now
    const latest = await getAllBalances(delegatorSmartAccount.address as `0x${string}`)
    const monWei = parseUnits(latest.MON || '0', 18)
    let vd: any = null
    if (monWei > 0n) {
      vd = await getOrCreateValueDelegation(
        delegatorSmartAccount,
        delegateSmartAccount,
        address as `0x${string}`,
        monWei
      )
    }
    // Withdraw ERC20s (no prompt; skips if no valid ERC20 delegation)
    await withdrawAllTokens()
    // Redeem prepared value delegation to transfer MON
    if (vd) {
      await enqueueOp(async () => {
        setIsLoading(true)
        try {
          const uoHash = await redeemValueTransferDelegation(
            delegateSmartAccount,
            vd,
            address as `0x${string}`,
            monWei
          )
          setDcaStatus(prev => ({ ...prev, lastUserOpHash: uoHash }))
          await refreshBalances()
        } finally {
          setIsLoading(false)
        }
      })
    } else {
      await refreshBalances()
    }

    // Resume DCA if it was active, without immediate run
    if (wasActive && lastDcaConfigRef.current) {
      const cfg = lastDcaConfigRef.current
      if (cfg.mode === 'manual') {
        dcaScheduler.start({
          intervalSeconds: cfg.intervalSeconds,
          onExecute: async () => {
            await enqueueOp(() => runNativeSwapMonToToken(cfg.amountMon, cfg.slippageBps, cfg.outToken, true))
          },
          onError: (error) => {
            setDcaStatus(prev => ({ ...prev, lastError: error.message }))
          },
          onStatusChange: (isActive, nextExecution) => {
            setDcaStatus(prev => ({ ...prev, isActive, nextExecution }))
          }
        })
      } else {
        let currentInterval = cfg.intervalSeconds
        const aiCb = lastAiCallbackRef.current
        dcaScheduler.start({
          intervalSeconds: currentInterval,
          onExecute: async () => {
            if (aiCb) {
              try {
                const aiDecision = await aiCb(balances as Record<string, string>)
                if (aiDecision) {
                  await enqueueOp(() => runNativeSwapMonToToken(aiDecision.amount, cfg.slippageBps, aiDecision.token, true))
                  currentInterval = aiDecision.interval
                  dcaScheduler.updateInterval(currentInterval)
                }
              } catch (error) {
                console.error('[ai-dca][resume] AI decision failed; fallback manual params:', error)
                await enqueueOp(() => runNativeSwapMonToToken(cfg.amountMon, cfg.slippageBps, cfg.outToken, true))
              }
            } else {
              await enqueueOp(() => runNativeSwapMonToToken(cfg.amountMon, cfg.slippageBps, cfg.outToken, true))
            }
          },
          onError: (error) => {
            setDcaStatus(prev => ({ ...prev, lastError: error.message }))
          },
          onStatusChange: (isActive, nextExecution) => {
            setDcaStatus(prev => ({ ...prev, isActive, nextExecution }))
          }
        })
      }
    }
  }, [delegatorSmartAccount, delegateSmartAccount, address, withdrawAllTokens, enqueueOp, refreshBalances, dcaStatus.isActive, runNativeSwapMonToToken, balances])

  // Panic: convert everything to MON, withdraw all MON to EOA, clear cache
  const panic = useCallback(async () => {
    try {
      await convertAllToMon(300)
    } catch (e) {
      console.warn('[panic] convertAllToMon failed:', e)
    }
    try {
      await withdrawAllMon()
    } catch (e) {
      console.warn('[panic] withdrawAllMon failed:', e)
    }
    try {
      // Revoke all active delegations on-chain for safety
      const { revokeAllDelegationsOnChain } = await import('../lib/delegation')
      if (delegatorSmartAccount) {
        await revokeAllDelegationsOnChain(delegatorSmartAccount)
      }
    } catch (e) {
      console.warn('[panic] revokeAllDelegationsOnChain failed:', e)
    }
    try {
      clearCache()
    } catch {}
    try {
      dcaScheduler.stop()
      setDcaStatus(prev => ({ ...prev, isActive: false, nextExecution: undefined }))
    } catch {}
    // Force re-initialization and fresh signature next time
    try {
      setSignedDelegation(null)
      setDelegatorSmartAccount(null)
      setDelegateSmartAccount(null)
      setIsInitialized(false)
      setDelegationExpiresAt(undefined)
      setDelegationExpired(true)
      setBalances({ MON: '0.0', USDC: '0.0', WMON: '0.0', CHOG: '0.0' })
    } catch {}
  }, [convertAllToMon, withdrawAllMon, clearCache, delegatorSmartAccount])
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
    convertAllToMon,
    topUpMon,
    withdrawMon,
    sellTokenToMon,
    withdrawToken,
    withdrawAllTokens,
    withdrawAll,
    
    runNativeSwapMonToToken,
    refreshBalances: () => refreshBalances(),
    reinitialize: initialize,
    clearCache,
    panic,
    delegationExpired,
    delegationExpiresAt,
    renewDelegation,
  }
}
