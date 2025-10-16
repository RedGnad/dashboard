import { createDelegation, createExecution, ExecutionMode, getDeleGatorEnvironment } from '@metamask/delegation-toolkit'
import { DelegationManager } from '@metamask/delegation-toolkit/contracts'
import { encodeFunctionData, parseUnits } from 'viem'
import { bundlerClient, paymasterClient } from './clients'
import { USDC, WMON, UNISWAP_V2_ROUTER02, SWAP_PATH } from './tokens'
import { CHAIN_ID } from './chain'

// ERC20 ABI for approve function
const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable'
  },
  {
    name: 'withdraw',
    type: 'function',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable'
  }
] as const

// Uniswap V2 Router ABI for swap function
const UNISWAP_V2_ROUTER_ABI = [
  {
    name: 'swapExactTokensForTokens',
    type: 'function',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' }
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'nonpayable'
  }
] as const

// Create core delegation with function call scope for DCA operations
export async function createCoreDelegation(delegatorSmartAccount: any, delegateSmartAccount: any) {
  console.log('[delegation] Creating delegation with targets:', {
    USDC,
    UNISWAP_V2_ROUTER02,
    WMON
  })
  
  // Use string selectors per DTK docs (not bytes4)
  const selectors = [
    'approve(address,uint256)',
    'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
    'withdraw(uint256)',
  ]

  const delegation = createDelegation({
    from: delegatorSmartAccount.address,
    to: delegateSmartAccount.address,
    environment: getDeleGatorEnvironment(CHAIN_ID) as any,
    scope: {
      type: 'functionCall',
      targets: [USDC, UNISWAP_V2_ROUTER02, WMON],
      selectors,
    }
  })
  
  console.log('[delegation] Delegation created:', delegation)

  // Sign the delegation (DTK encoders expect a flat object with signature)
  const signature = await delegatorSmartAccount.signDelegation({ delegation })
  const signedDelegation = { ...delegation, signature, permissionContexts: (delegation as any).permissionContexts ?? [] }

  // Store delegation locally for reuse
  localStorage.setItem('dca-delegation', JSON.stringify(signedDelegation))
  
  console.log('[delegation] Signed delegation:', signedDelegation)
  return signedDelegation
}

// Get stored delegation or create new one
export async function getOrCreateDelegation(delegatorSmartAccount: any, delegateSmartAccount: any) {
  const stored = localStorage.getItem('dca-delegation')
  if (stored) {
    try {
      const signed = JSON.parse(stored)
      console.log('[delegation] Found cached delegation:', signed)

      const matchDelegator = signed.delegator?.toLowerCase() === delegatorSmartAccount.address.toLowerCase()
      const matchDelegate = signed.delegate?.toLowerCase() === delegateSmartAccount.address.toLowerCase()
      if (matchDelegator && matchDelegate && signed.signature) {
        // Ensure permissionContexts exists to satisfy encoder expectations
        if (!Array.isArray(signed.permissionContexts)) signed.permissionContexts = []
        console.log('[delegation] Using cached delegation')
        return signed
      }
      console.log('[delegation] Cached delegation mismatch, creating new one')
      localStorage.removeItem('dca-delegation')
    } catch (error) {
      console.warn('Failed to parse stored delegation:', error)
      localStorage.removeItem('dca-delegation')
    }
  }

  console.log('[delegation] Creating new delegation')
  return await createCoreDelegation(delegatorSmartAccount, delegateSmartAccount)
}

// Execute USDC -> WMON swap via delegation
export async function redeemSwapDelegation(
  delegateSmartAccount: any,
  signedDelegation: any,
  usdcAmount: string,
  slippageBps: number,
  delegatorAddress: `0x${string}`
) {
  console.log('[swap] Starting swap with params:', {
    usdcAmount,
    slippageBps,
    delegatorAddress,
    targets: { USDC, UNISWAP_V2_ROUTER02, WMON }
  })
  
  const amountIn = parseUnits(usdcAmount, 6) // USDC has 6 decimals
  const amountOutMin = amountIn * BigInt(10000 - slippageBps) / BigInt(10000) // Simple slippage calc
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300) // 5 minutes

  // Create executions for the swap
  const executions = [
    // 1. Approve USDC to router
    createExecution({
      target: USDC,
      value: 0n,
      callData: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [UNISWAP_V2_ROUTER02, amountIn]
      })
    }),
    // 2. Swap USDC for WMON
    createExecution({
      target: UNISWAP_V2_ROUTER02,
      value: 0n,
      callData: encodeFunctionData({
        abi: UNISWAP_V2_ROUTER_ABI,
        functionName: 'swapExactTokensForTokens',
        args: [amountIn, amountOutMin, SWAP_PATH, delegatorAddress, deadline]
      })
    })
  ]

  // Encode redemption calldata
  // Normalize signedDelegation: accept flat ({ ...delegation, signature }) or nested ({ delegation, signature })
  const normalizedSignedDelegation = signedDelegation?.delegation
    ? { ...signedDelegation.delegation, signature: signedDelegation.signature, permissionContexts: signedDelegation.permissionContexts ?? [] }
    : { ...signedDelegation, permissionContexts: signedDelegation?.permissionContexts ?? [] }

  // Defensive validation & logging to diagnose shape issues
  const delegationsArg = [[normalizedSignedDelegation]]
  const modesArg = [ExecutionMode.SingleDefault]
  const executionsArg = [executions]

  console.log('[redeem] args check:', {
    hasSignature: Boolean(normalizedSignedDelegation && normalizedSignedDelegation.signature),
    hasDelegator: Boolean(normalizedSignedDelegation && normalizedSignedDelegation.delegator),
    hasDelegate: Boolean(normalizedSignedDelegation && normalizedSignedDelegation.delegate),
    delegationsLen: delegationsArg.length,
    innerDelegationsLen: delegationsArg[0]?.length,
    modesLen: modesArg.length,
    executionsOuterLen: executionsArg.length,
    executionsInnerLen: executionsArg[0]?.length,
  })

  if (!normalizedSignedDelegation || !normalizedSignedDelegation.signature) {
    throw new Error('Invalid signedDelegation: missing signature')
  }
  if (!Array.isArray(executions) || executions.length === 0) {
    throw new Error('Invalid executions: expected non-empty array')
  }

  const redeemDelegationCalldata = DelegationManager.encode.redeemDelegations({
    delegations: delegationsArg,
    modes: modesArg,
    executions: executionsArg,
  })

  // Send UserOperation from the smart account (per DTK docs)
  const userOperationHash = await bundlerClient.sendUserOperation({
    account: delegateSmartAccount,
    calls: [{
      to: delegateSmartAccount.address,
      data: redeemDelegationCalldata
    }],
    paymaster: paymasterClient,
  })

  return userOperationHash
}

// Execute WMON -> MON unwrap via delegation
export async function redeemUnwrapDelegation(
  delegateSmartAccount: any,
  signedDelegation: any,
  wmonAmount: bigint
) {
  // Create execution for unwrap
  const execution = createExecution({
    target: WMON,
    value: 0n,
    callData: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'withdraw',
      args: [wmonAmount]
    })
  })

  // Encode redemption calldata
  // Normalize signedDelegation similarly for unwrap path
  const normalizedSignedDelegation2 = signedDelegation?.delegation
    ? { ...signedDelegation.delegation, signature: signedDelegation.signature, permissionContexts: signedDelegation.permissionContexts ?? [] }
    : { ...signedDelegation, permissionContexts: signedDelegation?.permissionContexts ?? [] }

  const redeemDelegationCalldata = DelegationManager.encode.redeemDelegations({
    delegations: [[normalizedSignedDelegation2]],
    modes: [ExecutionMode.SingleDefault],
    executions: [[execution]]
  })

  // Send UserOperation from the smart account (per DTK docs)
  const userOperationHash = await bundlerClient.sendUserOperation({
    account: delegateSmartAccount,
    calls: [{
      to: delegateSmartAccount.address,
      data: redeemDelegationCalldata
    }],
    paymaster: paymasterClient,
  })

  return userOperationHash
}
