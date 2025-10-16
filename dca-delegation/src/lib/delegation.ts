import { 
  contracts,
  createDelegation, 
  createExecution, 
  ExecutionMode,
  getDeleGatorEnvironment
} from '@metamask/delegation-toolkit'
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
    WMON,
    delegatorSA: delegatorSmartAccount.address
  })
  
  // Use string selectors per DTK docs (not bytes4)
  const selectors = [
    'approve(address,uint256)',
    'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
    'withdraw(uint256)',
  ]

  const env = getDeleGatorEnvironment(CHAIN_ID) as any

  const delegation = createDelegation({
    from: delegatorSmartAccount.address,
    to: delegateSmartAccount.address,
    environment: env,
    scope: {
      type: 'functionCall',
      targets: [
        USDC,
        UNISWAP_V2_ROUTER02,
        WMON,
        delegatorSmartAccount.address  // SA utilisateur
      ],
      selectors,
    }
  })
  
  console.log('[delegation] Delegation created:', delegation)
  console.log('[delegation] Delegation scope details:', {
    type: (delegation as any).scope?.type,
    targets: (delegation as any).scope?.targets,
    selectors: (delegation as any).scope?.selectors
  })

  // Sign the delegation (DTK encoders expect a flat object with signature)
  const signature = await delegatorSmartAccount.signDelegation({ delegation })
  const signedDelegation = { ...delegation, signature, permissionContexts: (delegation as any).permissionContexts ?? [] }

  // Store delegation locally for reuse
  localStorage.setItem('dca-delegation', JSON.stringify(signedDelegation))
  
  console.log('[delegation] Signed delegation:', signedDelegation)
  console.log('[delegation] Signed delegation scope:', {
    type: (signedDelegation as any).scope?.type,
    targets: (signedDelegation as any).scope?.targets,
    selectors: (signedDelegation as any).scope?.selectors,
    caveats: signedDelegation.caveats?.length || 0
  })
  console.log('[delegation] Caveats details:', signedDelegation.caveats)
  
  // Log each caveat in detail
  signedDelegation.caveats?.forEach((caveat: any, index: number) => {
    console.log(`[delegation] Caveat ${index}:`, {
      enforcer: caveat.enforcer,
      terms: caveat.terms,
      args: caveat.args
    })
  })
  return signedDelegation
}

// Get stored delegation or create new one
export async function getOrCreateDelegation(delegatorSmartAccount: any, delegateSmartAccount: any) {
  const stored = localStorage.getItem('dca-delegation')
  if (stored) {
    try {
      const signed = JSON.parse(stored)
      console.log('[delegation] Found cached delegation:', signed)

      const matchDelegator = signed.delegator?.toLowerCase?.() === delegatorSmartAccount.address.toLowerCase()
        || signed.from?.toLowerCase?.() === delegatorSmartAccount.address.toLowerCase()
      const matchDelegate = signed.delegate?.toLowerCase?.() === delegateSmartAccount.address.toLowerCase()
        || signed.to?.toLowerCase?.() === delegateSmartAccount.address.toLowerCase()

      // Validate scope includes required targets & selectors
      const scope = signed.delegation?.scope ?? signed.scope
      const targets: string[] = (scope?.targets ?? []).map((t: string) => t.toLowerCase())
      const selectors: string[] = scope?.selectors ?? []

      const env = getDeleGatorEnvironment(CHAIN_ID) as any
      const requiredTargets = [
        USDC.toLowerCase(), 
        UNISWAP_V2_ROUTER02.toLowerCase(), 
        WMON.toLowerCase(),
        env.DelegationManager.toLowerCase()
      ]
      const requiredSelectors = [
        'approve(address,uint256)',
        'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
        'withdraw(uint256)'
      ]

      console.log('[delegation] Cache validation:', {
        matchDelegator,
        matchDelegate,
        hasSignature: !!signed.signature,
        currentTargets: targets,
        requiredTargets,
        currentSelectors: selectors,
        requiredSelectors
      })

      const hasTargets = requiredTargets.every((t) => targets.includes(t))
      const hasSelectors = requiredSelectors.every((s) => selectors.includes(s))

      console.log('[delegation] Cache validation result:', {
        hasTargets,
        hasSelectors,
        missingTargets: requiredTargets.filter(t => !targets.includes(t)),
        missingSelectors: requiredSelectors.filter(s => !selectors.includes(s))
      })

      if (matchDelegator && matchDelegate && signed.signature && hasTargets && hasSelectors) {
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

  // Log delegation details before redemption
  console.log('[swap] Using delegation:', {
    delegator: signedDelegation.delegator || signedDelegation.from,
    delegate: signedDelegation.delegate || signedDelegation.to,
    scope: signedDelegation.delegation?.scope || signedDelegation.scope,
    caveats: signedDelegation.caveats?.length || 0,
    hasSignature: !!signedDelegation.signature
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

  const normalizedSignedDelegation = signedDelegation?.delegation
    ? { ...signedDelegation.delegation, signature: signedDelegation.signature, permissionContexts: signedDelegation.permissionContexts ?? [] }
    : { ...signedDelegation, permissionContexts: signedDelegation?.permissionContexts ?? [] }

  // AllowedMethodsEnforcer only supports Single callType and Default execType.
  // Split into two SingleDefault entries: approve then swap.
  const execApprove = executions[0]
  const execSwap = executions[1]

  const env = getDeleGatorEnvironment(CHAIN_ID) as any

  // 1) Approve as a SingleDefault redeem
  const redeemApprove = contracts.DelegationManager.encode.redeemDelegations({
    delegations: [[normalizedSignedDelegation]],
    modes: [ExecutionMode.SingleDefault],
    executions: [[execApprove]],
  })

  console.log('[swap] Approve redeem details:', {
    delegationManagerAddress: env.DelegationManager,
    target: execApprove.target,
    mode: 'SingleDefault',
    callDataLength: redeemApprove.length
  })

  const approveUoHash = await bundlerClient.sendUserOperation({
    account: delegateSmartAccount,
    calls: [{ to: env.DelegationManager, data: redeemApprove }],
    paymaster: paymasterClient,
  })

  const { receipt: approveReceipt } = await bundlerClient.waitForUserOperationReceipt({ hash: approveUoHash })
  console.log('[swap] Approve tx hash:', approveReceipt.transactionHash)

  // 2) Swap as a SingleDefault redeem
  const redeemSwap = contracts.DelegationManager.encode.redeemDelegations({
    delegations: [[normalizedSignedDelegation]],
    modes: [ExecutionMode.SingleDefault],
    executions: [[execSwap]],
  })

  console.log('[swap] Swap redeem details:', {
    delegationManagerAddress: env.DelegationManager,
    target: execSwap.target,
    mode: 'SingleDefault',
    callDataLength: redeemSwap.length
  })

  const swapUoHash = await bundlerClient.sendUserOperation({
    account: delegateSmartAccount,
    calls: [{ to: env.DelegationManager, data: redeemSwap }],
    paymaster: paymasterClient,
  })

  const { receipt: swapReceipt } = await bundlerClient.waitForUserOperationReceipt({ hash: swapUoHash })
  console.log('[swap] Swap tx hash:', swapReceipt.transactionHash)
  return swapUoHash
}

// Execute WMON -> MON unwrap via delegation
export async function redeemUnwrapDelegation(
  delegateSmartAccount: any,
  signedDelegation: any,
  wmonAmount: bigint
) {
  console.log('[unwrap] Starting unwrap with params:', { wmonAmount: wmonAmount.toString() })
  
  // Log delegation details before redemption
  console.log('[unwrap] Using delegation:', {
    delegator: signedDelegation.delegator || signedDelegation.from,
    delegate: signedDelegation.delegate || signedDelegation.to,
    scope: signedDelegation.delegation?.scope || signedDelegation.scope,
    caveats: signedDelegation.caveats?.length || 0,
    hasSignature: !!signedDelegation.signature
  })

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

  const normalizedSignedDelegation2 = signedDelegation?.delegation
    ? { ...signedDelegation.delegation, signature: signedDelegation.signature, permissionContexts: signedDelegation.permissionContexts ?? [] }
    : { ...signedDelegation, permissionContexts: signedDelegation?.permissionContexts ?? [] }

  const redeemDelegationCalldata = contracts.DelegationManager.encode.redeemDelegations({
    delegations: [[normalizedSignedDelegation2]],
    modes: [ExecutionMode.SingleDefault],
    executions: [[execution]]
  })

  const env = getDeleGatorEnvironment(CHAIN_ID) as any

  const userOperationHash = await bundlerClient.sendUserOperation({
    account: delegateSmartAccount,
    calls: [{
      to: env.DelegationManager,
      data: redeemDelegationCalldata,
    }],
    paymaster: paymasterClient,
  })

  // Wait for the transaction receipt (DTK best practice)
  const { receipt } = await bundlerClient.waitForUserOperationReceipt({
    hash: userOperationHash
  })

  console.log('Unwrap transaction hash:', receipt.transactionHash)
  return userOperationHash
}
