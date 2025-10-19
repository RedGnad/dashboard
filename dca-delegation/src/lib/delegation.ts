import { 
  contracts,
  createDelegation, 
  createExecution, 
  ExecutionMode,
  getDeleGatorEnvironment,
  createCaveat
} from '@metamask/delegation-toolkit'
import { encodeFunctionData, parseUnits, toHex } from 'viem'
import { bundlerClient, paymasterClient, publicClient } from './clients'
import { USDC, WMON, UNISWAP_V2_ROUTER02, SWAP_PATH, CHOG, TOKENS, ROUTER_V2_CANDIDATES, KURU_ROUTER, FLOW_ROUTER } from './tokens'
import { CHAIN_ID } from './chain'

async function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms))
}

// Minimal ABI for disabling a delegation on-chain (delegator must call)
const DELEGATION_MANAGER_DISABLE_ABI = [
  {
    name: 'disableDelegation',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: '_delegation',
        type: 'tuple',
        components: [
          { name: 'delegate', type: 'address' },
          { name: 'delegator', type: 'address' },
          { name: 'authority', type: 'bytes32' },
          {
            name: 'caveats',
            type: 'tuple[]',
            components: [
              { name: 'enforcer', type: 'address' },
              { name: 'terms', type: 'bytes' },
              { name: 'args', type: 'bytes' },
            ],
          },
          { name: 'salt', type: 'uint256' },
          { name: 'signature', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
  },
] as const

function normalizeToDelegationStruct(signed: any) {
  const d = signed?.delegation ?? signed
  return {
    delegate: (d.delegate || d.to) as `0x${string}`,
    delegator: (d.delegator || d.from) as `0x${string}`,
    authority: (d.authority || '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff') as `0x${string}`,
    caveats: (d.caveats || []).map((c: any) => ({
      enforcer: c.enforcer as `0x${string}`,
      terms: (c.terms || '0x') as `0x${string}`,
      args: (c.args || '0x') as `0x${string}`,
    })),
    salt: BigInt(d.salt || 0),
    signature: (signed.signature || d.signature || '0x') as `0x${string}`,
  }
}

export async function revokeAllDelegationsOnChain(
  delegatorSmartAccount: any,
) {
  const env = getDeleGatorEnvironment(CHAIN_ID) as any
  const dm = env.DelegationManager as `0x${string}`

  // Collect likely cached delegations
  const candidates: any[] = []
  try {
    const globalCore = localStorage.getItem('dca-delegation')
    if (globalCore) candidates.push(JSON.parse(globalCore))
  } catch {}
  try {
    // scan scoped keys for current delegator
    const keys = Object.keys(localStorage)
    for (const k of keys) {
      if (k.startsWith('dca-delegation-')) {
        try { candidates.push(JSON.parse(localStorage.getItem(k)!)) } catch {}
      }
    }
  } catch {}
  try {
    const val = localStorage.getItem('dca-value-delegation')
    if (val) candidates.push(JSON.parse(val))
  } catch {}
  try {
    const nat = localStorage.getItem('dca-native-swap-delegation')
    if (nat) candidates.push(JSON.parse(nat))
  } catch {}

  // De-duplicate by (delegator, delegate, salt)
  const seen = new Set<string>()
  const normalized = candidates
    .map(normalizeToDelegationStruct)
    .filter((d) => {
      if (!d.delegator || !d.delegate) return false
      const key = `${d.delegator.toLowerCase()}_${d.delegate.toLowerCase()}_${d.salt.toString()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

  if (normalized.length === 0) {
    console.log('[revoke] No cached delegations found to revoke')
    return [] as `0x${string}`[]
  }

  const hashes: `0x${string}`[] = []
  for (const d of normalized) {
    try {
      const data = encodeFunctionData({
        abi: DELEGATION_MANAGER_DISABLE_ABI,
        functionName: 'disableDelegation',
        args: [d],
      })
      const uoHash = await sendUserOpWithRetry({
        account: delegatorSmartAccount,
        calls: [{ to: dm, data }],
        paymaster: paymasterClient,
      })
      const { receipt } = await bundlerClient.waitForUserOperationReceipt({ hash: uoHash })
      console.log('[revoke] disableDelegation tx hash:', receipt.transactionHash)
      hashes.push(uoHash)
    } catch (e) {
      console.warn('[revoke] disableDelegation failed for delegation:', d, e)
    }
  }
  return hashes
}

export async function getOrCreateValueDelegation(
  delegatorSmartAccount: any,
  delegateSmartAccount: any,
  recipient: `0x${string}`,
  maxValueWei: bigint,
) {
  const stored = localStorage.getItem('dca-value-delegation')
  if (stored) {
    try {
      const signed = JSON.parse(stored)
      const scope = signed.delegation?.scope ?? signed.scope
      const match = signed.from?.toLowerCase?.() === delegatorSmartAccount.address.toLowerCase()
        && signed.to?.toLowerCase?.() === delegateSmartAccount.address.toLowerCase()
        && signed.recipient?.toLowerCase?.() === recipient.toLowerCase()
        && !isDelegationExpired(signed)
        && signed.valueDelegationVersion === 2
      if (match) {
        console.log('[value-delegation] Using cached value delegation with scope:', scope)
        return signed
      } else {
        console.log('[value-delegation] Cached value delegation invalid or outdated. Recreating...')
      }
    } catch {}
  }
  return await createValueDelegation(delegatorSmartAccount, delegateSmartAccount, recipient, maxValueWei)
}

export async function redeemValueTransferDelegation(
  delegateSmartAccount: any,
  signedDelegation: any,
  recipient: `0x${string}`,
  amountWei: bigint,
) {
  const execution = createExecution({ target: recipient, value: amountWei, callData: '0x' as `0x${string}` })
  const normalizedSignedDelegation = signedDelegation?.delegation
    ? { ...signedDelegation.delegation, signature: signedDelegation.signature, permissionContexts: signedDelegation.permissionContexts ?? [] }
    : { ...signedDelegation, permissionContexts: signedDelegation?.permissionContexts ?? [] }

  const redeemCalldata = contracts.DelegationManager.encode.redeemDelegations({
    delegations: [[normalizedSignedDelegation]],
    modes: [ExecutionMode.SingleDefault],
    executions: [[execution]],
  })
  const env = getDeleGatorEnvironment(CHAIN_ID) as any
  const uoHash = await sendUserOpWithRetry({
    account: delegateSmartAccount,
    calls: [{ to: env.DelegationManager, data: redeemCalldata }],
    paymaster: paymasterClient,
  })
  const { receipt } = await bundlerClient.waitForUserOperationReceipt({ hash: uoHash })
  console.log('[value] Transfer tx hash:', receipt.transactionHash)
  return uoHash
}

async function sendUserOpWithRetry({
  account,
  calls,
  paymaster,
  maxRetries = 2,
}: {
  account: any
  calls: { to: `0x${string}`; data: `0x${string}` }[]
  paymaster: any
  maxRetries?: number
}) {
  let attempt = 0
  let lastError: any
  while (attempt <= maxRetries) {
    try {
      return await bundlerClient.sendUserOperation({ account, calls, paymaster })
    } catch (e: any) {
      const msg = (e?.message || '').toString()
      if (msg.includes('AA25') || msg.toLowerCase().includes('invalid account nonce')) {
        const backoff = [250, 500, 1000][attempt] || 1000
        console.warn(`[uop] AA25 invalid nonce, retrying in ${backoff}ms (attempt ${attempt + 1})`)
        await sleep(backoff)
        attempt++
        lastError = e
        continue
      }
      throw e
    }
  }
  throw lastError
}

// ERC20 ABI for approve/allowance and WMON withdraw
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
    name: 'allowance',
    type: 'function',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view'
  },
  {
    name: 'transfer',
    type: 'function',
    inputs: [
      { name: 'to', type: 'address' },
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

// Uniswap V2 Router ABI for ETH->Tokens
const UNISWAP_V2_ROUTER_ETH_ABI = [
  {
    name: 'swapExactETHForTokens',
    type: 'function',
    inputs: [
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' }
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'payable'
  }
] as const

// Uniswap V2 Router read ABI
const UNISWAP_V2_ROUTER_READ_ABI = [
  {
    name: 'getAmountsOut',
    type: 'function',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'path', type: 'address[]' }
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'view'
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
    'swapExactETHForTokens(uint256,address[],address,uint256)',
    'transfer(address,uint256)',
    'withdraw(uint256)',
  ]

  const env = getDeleGatorEnvironment(CHAIN_ID) as any

  // 24h validity window using TimestampEnforcer
  const nowSec = Math.floor(Date.now() / 1000)
  const afterTs = BigInt(nowSec - 1) // allow immediate use
  const beforeTs = BigInt(nowSec + 24 * 60 * 60) // +24h
  const timestampTerms = toHex((afterTs << 128n) | beforeTs, { size: 32 }) as `0x${string}`
  const timestampCaveat = createCaveat(
    env.caveatEnforcers.TimestampEnforcer,
    timestampTerms
  )

  // Allow approval and swaps for all ERC20 tokens we support (exclude native MON)
  const allErc20Targets = [
    ...Object.values(TOKENS).filter(t => !t.isNative).map(t => t.address),
    UNISWAP_V2_ROUTER02,
    KURU_ROUTER,
    FLOW_ROUTER,
  ] as `0x${string}`[]

  const delegation = createDelegation({
    from: delegatorSmartAccount.address,
    to: delegateSmartAccount.address,
    environment: env,
    scope: {
      type: 'functionCall',
      targets: allErc20Targets,
      selectors,
    },
    caveats: [timestampCaveat],
  })
  
  console.log('[delegation] Delegation created:', delegation)
  console.log('[delegation] Delegation scope details:', {
    type: (delegation as any).scope?.type,
    targets: (delegation as any).scope?.targets,
    selectors: (delegation as any).scope?.selectors
  })

  // Sign the delegation (DTK encoders expect a flat object with signature)
  const signature = await delegatorSmartAccount.signDelegation({ delegation })
  const signedDelegation = { 
    ...delegation, 
    signature, 
    permissionContexts: (delegation as any).permissionContexts ?? [],
    expiresAt: Number(beforeTs)
  }

  // Store delegation locally for reuse (scoped + legacy)
  try {
    const scopedKey = `dca-delegation-${delegatorSmartAccount.address.toLowerCase()}-${delegateSmartAccount.address.toLowerCase()}`
    localStorage.setItem(scopedKey, JSON.stringify(signedDelegation))
  } catch {}
  try {
    localStorage.setItem('dca-delegation', JSON.stringify(signedDelegation))
  } catch {}
  
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

export function isDelegationExpired(delegation: any): boolean {
  const now = Math.floor(Date.now() / 1000)
  const exp = typeof delegation?.expiresAt === 'number' ? delegation.expiresAt : undefined
  if (!exp) return false
  return now >= exp
}

// Get stored delegation or create new one
export async function getOrCreateDelegation(delegatorSmartAccount: any, delegateSmartAccount: any) {
  const scopedKey = `dca-delegation-${delegatorSmartAccount.address.toLowerCase()}-${delegateSmartAccount.address.toLowerCase()}`
  let stored = localStorage.getItem(scopedKey)
  if (!stored) stored = localStorage.getItem('dca-delegation')
  if (stored) {
    try {
      const signed = JSON.parse(stored)
      console.log('[delegation] Found cached delegation:', signed)

      const matchDelegator = signed.delegator?.toLowerCase?.() === delegatorSmartAccount.address.toLowerCase()
        || signed.from?.toLowerCase?.() === delegatorSmartAccount.address.toLowerCase()
      const matchDelegate = signed.delegate?.toLowerCase?.() === delegateSmartAccount.address.toLowerCase()
        || signed.to?.toLowerCase?.() === delegateSmartAccount.address.toLowerCase()

      const notExpired = !isDelegationExpired(signed)
      const scope = signed.delegation?.scope || signed.scope || {}
      const selectors: string[] = scope.selectors || []
      const targets: string[] = scope.targets || []
      const requiredSelectors = new Set([
        'approve(address,uint256)',
        'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
        'swapExactETHForTokens(uint256,address[],address,uint256)',
        'transfer(address,uint256)',
        'withdraw(uint256)'
      ])
      const selectorSet = new Set(Array.isArray(selectors) ? selectors : [])
      const hasAllSelectors = [...requiredSelectors].every((s) => selectorSet.has(s))
      const requiredTargets = new Set<string>([
        ...Object.values(TOKENS).filter(t=>!t.isNative).map(t=>t.address.toLowerCase()),
        UNISWAP_V2_ROUTER02.toLowerCase(),
        KURU_ROUTER.toLowerCase(),
        FLOW_ROUTER.toLowerCase(),
      ])
      const hasAllTargets = Array.isArray(targets) && [...requiredTargets].every(t => targets.map((x:string)=>x.toLowerCase()).includes(t))

      // Minimal checks + scope completeness for our features
      if (matchDelegator && matchDelegate && signed.signature && notExpired && hasAllSelectors && hasAllTargets) {
        // Ensure permissionContexts exists to satisfy encoder expectations
        if (!Array.isArray(signed.permissionContexts)) signed.permissionContexts = []
        console.log('[delegation] Using cached delegation')
        return signed
      }
      console.log('[delegation] Cached delegation mismatch/expired or lacks required scope, creating new one')
      localStorage.removeItem(scopedKey)
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
  console.log('[swap] Starting swap with params:', { usdcAmount, slippageBps, delegatorAddress })
  console.log('[swap] Using delegation:', {
    delegator: signedDelegation.delegator || signedDelegation.from,
    delegate: signedDelegation.delegate || signedDelegation.to,
    caveats: signedDelegation.caveats?.length || 0,
  })

  const amountIn = parseUnits(usdcAmount, 6) // USDC has 6 decimals
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300) // 5 minutes
  // Try all V2 routers and choose best quote for USDC->WMON
  let best: { router: `0x${string}`; path: `0x${string}`[]; minOut: bigint } | null = null
  for (const router of ROUTER_V2_CANDIDATES) {
    try {
      const path = [USDC as `0x${string}`, WMON as `0x${string}`] as `0x${string}`[]
      const amounts = await publicClient.readContract({
        address: router,
        abi: UNISWAP_V2_ROUTER_READ_ABI,
        functionName: 'getAmountsOut',
        args: [amountIn, path]
      }) as bigint[]
      const out = amounts?.[amounts.length - 1]
      if (typeof out === 'bigint' && out > 0n) {
        const minOut = out * BigInt(10000 - slippageBps) / 10000n
        if (!best || minOut > best.minOut) best = { router: router as `0x${string}`, path, minOut }
      }
    } catch {}
  }
  if (!best) {
    console.warn('[swap] No V2 router returned a quote; proceeding with minOut=0 on default router')
    best = { router: UNISWAP_V2_ROUTER02 as `0x${string}`, path: [USDC as `0x${string}`, WMON as `0x${string}`], minOut: 0n }
  }

  // Create executions for the swap using the chosen router; skip approve if allowance sufficient
  let needApprove = true
  try {
    const current = await publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [delegatorAddress, best.router]
    }) as bigint
    needApprove = current < amountIn
  } catch {}
  const execSwapOnly = createExecution({
    target: best.router,
    value: 0n,
    callData: encodeFunctionData({ abi: UNISWAP_V2_ROUTER_ABI, functionName: 'swapExactTokensForTokens', args: [amountIn, best.minOut, best.path, delegatorAddress, deadline] })
  })
  const execApprove = createExecution({
    target: USDC,
    value: 0n,
    callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [best.router, amountIn] })
  })

  const normalizedSignedDelegation = signedDelegation?.delegation
    ? { ...signedDelegation.delegation, signature: signedDelegation.signature, permissionContexts: signedDelegation.permissionContexts ?? [] }
    : { ...signedDelegation, permissionContexts: signedDelegation?.permissionContexts ?? [] }
  // AllowedMethodsEnforcer: use SingleDefault execs; send both approve+swap in ONE redeem
  const env = getDeleGatorEnvironment(CHAIN_ID) as any
  const redeemBoth = needApprove
    ? contracts.DelegationManager.encode.redeemDelegations({
        delegations: [[normalizedSignedDelegation], [normalizedSignedDelegation]],
        modes: [ExecutionMode.SingleDefault, ExecutionMode.SingleDefault],
        executions: [[execApprove], [execSwapOnly]],
      })
    : contracts.DelegationManager.encode.redeemDelegations({
        delegations: [[normalizedSignedDelegation]],
        modes: [ExecutionMode.SingleDefault],
        executions: [[execSwapOnly]],
      })

  const uoHash = await sendUserOpWithRetry({
    account: delegateSmartAccount,
    calls: [{ to: env.DelegationManager, data: redeemBoth }],
    paymaster: paymasterClient,
  })
  const { receipt } = await bundlerClient.waitForUserOperationReceipt({ hash: uoHash })
  console.log('[swap] Approve+Swap tx hash:', receipt.transactionHash)
  return uoHash
}

// Generic ERC20 -> WMON swap via delegation
export async function redeemSwapErc20ToWmonDelegation(
  delegateSmartAccount: any,
  signedDelegation: any,
  tokenAddress: `0x${string}`,
  tokenDecimals: number,
  amount: string,
  slippageBps: number,
  delegatorAddress: `0x${string}`
) {
  const amountIn = parseUnits(amount, tokenDecimals)
  // Try all V2 routers with both direct and USDC-bridge paths
  type Best = { router: `0x${string}`; path: `0x${string}`[]; minOut: bigint }
  let best: Best | null = null
  const candidates = [
    [tokenAddress, WMON] as `0x${string}`[],
    [tokenAddress, USDC, WMON] as `0x${string}`[],
  ]
  for (const router of ROUTER_V2_CANDIDATES) {
    for (const p of candidates) {
      try {
        const amounts = await publicClient.readContract({
          address: router,
          abi: UNISWAP_V2_ROUTER_READ_ABI,
          functionName: 'getAmountsOut',
          args: [amountIn, p]
        }) as bigint[]
        const out = amounts?.[amounts.length - 1]
        if (typeof out === 'bigint' && out > 0n) {
          const minOut = out * BigInt(10000 - slippageBps) / 10000n
          if (!best || minOut > best.minOut) best = { router: router as `0x${string}`, path: p, minOut }
        }
      } catch {}
    }
  }
  if (!best) throw new Error('No valid swap path found on supported V2 routers')
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)
  // Skip approve if allowance sufficient for this token
  let needApprove = true
  try {
    const current = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [delegatorAddress, best.router]
    }) as bigint
    needApprove = current < amountIn
  } catch {}
  const execSwap = createExecution({
    target: best.router,
    value: 0n,
    callData: encodeFunctionData({ abi: UNISWAP_V2_ROUTER_ABI, functionName: 'swapExactTokensForTokens', args: [amountIn, best.minOut, best.path, delegatorAddress, deadline] })
  })
  const execApprove = createExecution({
    target: tokenAddress,
    value: 0n,
    callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [best.router, amountIn] })
  })
  const normalizedSignedDelegation = signedDelegation?.delegation
    ? { ...signedDelegation.delegation, signature: signedDelegation.signature, permissionContexts: signedDelegation.permissionContexts ?? [] }
    : { ...signedDelegation, permissionContexts: signedDelegation?.permissionContexts ?? [] }
  const env = getDeleGatorEnvironment(CHAIN_ID) as any
  const redeemBoth = contracts.DelegationManager.encode.redeemDelegations({
    delegations: [[normalizedSignedDelegation], [normalizedSignedDelegation]],
    modes: [ExecutionMode.SingleDefault, ExecutionMode.SingleDefault],
    executions: [[execApprove], [execSwap]],
  })
  const uoHash = await sendUserOpWithRetry({
    account: delegateSmartAccount,
    calls: [{ to: env.DelegationManager, data: redeemBoth }],
    paymaster: paymasterClient,
  })
  const { receipt } = await bundlerClient.waitForUserOperationReceipt({ hash: uoHash })
  console.log('[swap] ERC20->WMON tx hash:', receipt.transactionHash)
  return uoHash
}

export async function redeemSwapChogDelegation(
  delegateSmartAccount: any,
  signedDelegation: any,
  chogAmount: string,
  slippageBps: number,
  delegatorAddress: `0x${string}`
) {
  // Reuse generic path finder for CHOG
  return redeemSwapErc20ToWmonDelegation(
    delegateSmartAccount,
    signedDelegation,
    CHOG,
    18,
    chogAmount,
    slippageBps,
    delegatorAddress
  )
}

// Transfer ERC20 from Delegator SA to recipient via delegation
export async function redeemErc20TransferDelegation(
  delegateSmartAccount: any,
  signedDelegation: any,
  tokenAddress: `0x${string}`,
  tokenDecimals: number,
  amount: string,
  recipient: `0x${string}`,
) {
  const amountWei = parseUnits(amount, tokenDecimals)
  if (amountWei === 0n) throw new Error('Amount is zero')

  const exec = createExecution({
    target: tokenAddress,
    value: 0n,
    callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [recipient, amountWei] })
  })

  const normalizedSignedDelegation = signedDelegation?.delegation
    ? { ...signedDelegation.delegation, signature: signedDelegation.signature, permissionContexts: signedDelegation.permissionContexts ?? [] }
    : { ...signedDelegation, permissionContexts: signedDelegation?.permissionContexts ?? [] }

  const env = getDeleGatorEnvironment(CHAIN_ID) as any
  const redeemCalldata = contracts.DelegationManager.encode.redeemDelegations({
    delegations: [[normalizedSignedDelegation]],
    modes: [ExecutionMode.SingleDefault],
    executions: [[exec]],
  })

  const uoHash = await sendUserOpWithRetry({
    account: delegateSmartAccount,
    calls: [{ to: env.DelegationManager, data: redeemCalldata }],
    paymaster: paymasterClient,
  })
  const { receipt } = await bundlerClient.waitForUserOperationReceipt({ hash: uoHash })
  console.log('[erc20-transfer] tx hash:', receipt.transactionHash)
  return uoHash
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

  const userOperationHash = await sendUserOpWithRetry({
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

// Create a value-only delegation to allow native MON transfers to a specific recipient (EOA)
export async function createValueDelegation(
  delegatorSmartAccount: any,
  delegateSmartAccount: any,
  recipient: `0x${string}`,
  maxValueWei: bigint,
  ttlSeconds = 24 * 60 * 60,
) {
  const env = getDeleGatorEnvironment(CHAIN_ID) as any
  const nowSec = Math.floor(Date.now() / 1000)
  const afterTs = BigInt(nowSec - 1)
  const beforeTs = BigInt(nowSec + ttlSeconds)

  const timestampTerms = toHex((afterTs << 128n) | beforeTs, { size: 32 }) as `0x${string}`

  const caveats = [
    createCaveat(env.caveatEnforcers.TimestampEnforcer, timestampTerms),
  ]

  const delegation = createDelegation({
    from: delegatorSmartAccount.address,
    to: delegateSmartAccount.address,
    environment: env,
    scope: {
      type: 'nativeTokenTransferAmount',
      maxAmount: maxValueWei,
    } as any,
    caveats,
  } as any)

  const signature = await delegatorSmartAccount.signDelegation({ delegation })
  const signedDelegation = {
    ...delegation,
    signature,
    permissionContexts: (delegation as any).permissionContexts ?? [],
    recipient,
    maxValueWei: maxValueWei.toString(),
    expiresAt: Number(beforeTs),
    valueDelegationVersion: 2,
  }
  localStorage.setItem('dca-value-delegation', JSON.stringify(signedDelegation))
  return signedDelegation
}

// Delegation for native swap (MON -> token via router.swapExactETHForTokens)
export async function createNativeSwapDelegation(
  delegatorSmartAccount: any,
  delegateSmartAccount: any,
  maxValueWei: bigint,
  ttlSeconds = 24 * 60 * 60,
) {
  const env = getDeleGatorEnvironment(CHAIN_ID) as any
  const nowSec = Math.floor(Date.now() / 1000)
  const afterTs = BigInt(nowSec - 1)
  const beforeTs = BigInt(nowSec + ttlSeconds)

  const timestampTerms = toHex((afterTs << 128n) | beforeTs, { size: 32 }) as `0x${string}`
  const valueTerms = toHex(maxValueWei, { size: 32 }) as `0x${string}`
  const caveats = [
    createCaveat(env.caveatEnforcers.TimestampEnforcer, timestampTerms),
    createCaveat(env.caveatEnforcers.ValueLteEnforcer, valueTerms),
  ]

  const delegation = createDelegation({
    from: delegatorSmartAccount.address,
    to: delegateSmartAccount.address,
    environment: env,
    scope: {
      type: 'functionCall',
      targets: [...ROUTER_V2_CANDIDATES],
      selectors: ['swapExactETHForTokens(uint256,address[],address,uint256)']
    },
    caveats,
  })

  const signature = await delegatorSmartAccount.signDelegation({ delegation })
  const signedDelegation = {
    ...delegation,
    signature,
    permissionContexts: (delegation as any).permissionContexts ?? [],
    maxValueWei: maxValueWei.toString(),
    expiresAt: Number(beforeTs),
  }
  localStorage.setItem('dca-native-swap-delegation', JSON.stringify(signedDelegation))
  return signedDelegation
}

export async function getOrCreateNativeSwapDelegation(
  delegatorSmartAccount: any,
  delegateSmartAccount: any,
  maxValueWei: bigint,
) {
  const stored = localStorage.getItem('dca-native-swap-delegation')
  if (stored) {
    try {
      const signed = JSON.parse(stored)
      const scopeTargets: string[] = (signed.delegation?.scope?.targets || signed.scope?.targets || [])
      const lower = Array.isArray(scopeTargets) ? scopeTargets.map((x:string)=>x.toLowerCase()) : []
      const hasAllTargets = Array.isArray(scopeTargets) && ROUTER_V2_CANDIDATES.every(r => lower.includes(r.toLowerCase()))
      const match = signed.from?.toLowerCase?.() === delegatorSmartAccount.address.toLowerCase()
        && signed.to?.toLowerCase?.() === delegateSmartAccount.address.toLowerCase()
        && !isDelegationExpired(signed)
        && hasAllTargets
      if (match) return signed
    } catch {}
  }
  return await createNativeSwapDelegation(delegatorSmartAccount, delegateSmartAccount, maxValueWei)
}

export async function redeemNativeSwapDelegation(
  delegateSmartAccount: any,
  signedDelegation: any,
  amountMon: string,
  slippageBps: number,
  outToken: `0x${string}`,
  recipient: `0x${string}`,
) {
  console.log('[native-swap] Starting', { amountMon, slippageBps, outToken, recipient })
  const amountInWei = parseUnits(amountMon, 18)
  const pathCandidates: `0x${string}`[][] = [
    [WMON as `0x${string}`, outToken],
    [WMON as `0x${string}`, USDC as `0x${string}`, outToken],
  ]

  // Pre-check Delegator SA MON balance
  const delegatorAddress = (signedDelegation?.from || signedDelegation?.delegation?.from) as `0x${string}`
  if (delegatorAddress) {
    const bal = await publicClient.getBalance({ address: delegatorAddress })
    if (bal < amountInWei) {
      throw new Error('Insufficient MON balance in Delegator SA for native swap')
    }
  }

  // Compute best router + path using getAmountsOut
  let best: { router: `0x${string}`; path: `0x${string}`[]; minOut: bigint } | null = null
  for (const router of ROUTER_V2_CANDIDATES) {
    for (const p of pathCandidates) {
      try {
        const amounts = await publicClient.readContract({
          address: router,
          abi: UNISWAP_V2_ROUTER_READ_ABI,
          functionName: 'getAmountsOut',
          args: [amountInWei, p]
        }) as bigint[]
        const out = amounts?.[amounts.length - 1]
        if (typeof out === 'bigint' && out > 0n) {
          const minOut = out * BigInt(10000 - slippageBps) / 10000n
          if (!best || minOut > best.minOut) best = { router: router as `0x${string}`, path: p, minOut }
        }
      } catch {}
    }
  }
  if (!best) {
    console.warn('[native-swap] No quote found; proceeding on default router with minOut=0')
    best = { router: UNISWAP_V2_ROUTER02 as `0x${string}`, path: [WMON as `0x${string}`, outToken], minOut: 0n }
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)

  const execution = createExecution({
    target: best.router,
    value: amountInWei,
    callData: encodeFunctionData({
      abi: UNISWAP_V2_ROUTER_ETH_ABI,
      functionName: 'swapExactETHForTokens',
      args: [best.minOut, best.path, recipient, deadline]
    })
  })

  const normalizedSignedDelegation = signedDelegation?.delegation
    ? { ...signedDelegation.delegation, signature: signedDelegation.signature, permissionContexts: signedDelegation.permissionContexts ?? [] }
    : { ...signedDelegation, permissionContexts: signedDelegation?.permissionContexts ?? [] }

  const redeemCalldata = contracts.DelegationManager.encode.redeemDelegations({
    delegations: [[normalizedSignedDelegation]],
    modes: [ExecutionMode.SingleDefault],
    executions: [[execution]],
  })

  const env = getDeleGatorEnvironment(CHAIN_ID) as any
  const uoHash = await sendUserOpWithRetry({
    account: delegateSmartAccount,
    calls: [{ to: env.DelegationManager, data: redeemCalldata }],
    paymaster: paymasterClient,
  })
  const { receipt } = await bundlerClient.waitForUserOperationReceipt({ hash: uoHash })
  console.log('[native-swap] tx hash:', receipt.transactionHash)
  return uoHash
}

// Generic ERC20 -> ERC20 swap via delegation
export async function redeemSwapErc20ToErc20Delegation(
  delegateSmartAccount: any,
  signedDelegation: any,
  tokenIn: `0x${string}`,
  tokenInDecimals: number,
  amount: string,
  slippageBps: number,
  tokenOut: `0x${string}`,
  recipient: `0x${string}`,
) {
  const amountIn = parseUnits(amount, tokenInDecimals)
  type Best = { router: `0x${string}`; path: `0x${string}`[]; minOut: bigint }
  let best: Best | null = null
  const candidates: `0x${string}`[][] = [
    [tokenIn, tokenOut],
    [tokenIn, WMON as `0x${string}`, tokenOut],
    [tokenIn, USDC as `0x${string}`, tokenOut],
  ]
  for (const router of ROUTER_V2_CANDIDATES) {
    for (const p of candidates) {
      try {
        const amounts = await publicClient.readContract({
          address: router,
          abi: UNISWAP_V2_ROUTER_READ_ABI,
          functionName: 'getAmountsOut',
          args: [amountIn, p]
        }) as bigint[]
        const out = amounts?.[amounts.length - 1]
        if (typeof out === 'bigint' && out > 0n) {
          const minOut = out * BigInt(10000 - slippageBps) / 10000n
          if (!best || minOut > best.minOut) best = { router: router as `0x${string}`, path: p, minOut }
        }
      } catch {}
    }
  }
  if (!best) throw new Error('No valid swap path found on supported V2 routers')
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)
  let needApprove = true
  try {
    const current = await publicClient.readContract({
      address: tokenIn,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [recipient, best.router]
    }) as bigint
    needApprove = current < amountIn
  } catch {}
  const execApprove = createExecution({
    target: tokenIn,
    value: 0n,
    callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [best.router, amountIn] })
  })
  const execSwap = createExecution({
    target: best.router,
    value: 0n,
    callData: encodeFunctionData({ abi: UNISWAP_V2_ROUTER_ABI, functionName: 'swapExactTokensForTokens', args: [amountIn, best.minOut, best.path, recipient, deadline] })
  })
  const normalizedSignedDelegation = signedDelegation?.delegation
    ? { ...signedDelegation.delegation, signature: signedDelegation.signature, permissionContexts: signedDelegation.permissionContexts ?? [] }
    : { ...signedDelegation, permissionContexts: signedDelegation?.permissionContexts ?? [] }
  const env = getDeleGatorEnvironment(CHAIN_ID) as any
  const data = needApprove
    ? contracts.DelegationManager.encode.redeemDelegations({
        delegations: [[normalizedSignedDelegation], [normalizedSignedDelegation]],
        modes: [ExecutionMode.SingleDefault, ExecutionMode.SingleDefault],
        executions: [[execApprove], [execSwap]],
      })
    : contracts.DelegationManager.encode.redeemDelegations({
        delegations: [[normalizedSignedDelegation]],
        modes: [ExecutionMode.SingleDefault],
        executions: [[execSwap]],
      })
  const uoHash = await sendUserOpWithRetry({
    account: delegateSmartAccount,
    calls: [{ to: env.DelegationManager, data }],
    paymaster: paymasterClient,
  })
  const { receipt } = await bundlerClient.waitForUserOperationReceipt({ hash: uoHash })
  console.log('[swap] ERC20->ERC20 tx hash:', receipt.transactionHash)
  return uoHash
}
