import 'dotenv/config'
import { Address, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Implementation, toMetaMaskSmartAccount, ExecutionMode, getDeleGatorEnvironment } from '@metamask/delegation-toolkit'
import { DelegationManager } from '@metamask/delegation-toolkit/contracts'
import { publicClient, bundlerClient, paymasterClient, monadTestnet } from './clients'
import { buildExecutions } from './dca'
import { USDC, UNISWAP_V2_ROUTER02, WMON } from './constants'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDebugBundle, summarizeExecutions } from './utils/debug'
import { encodePermissionContextsFromDelegations, encodeExecutionCalldatasWithModes } from './encoding'

export async function runOnceForDelegator(delegatorSA: Address) {
  const pk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}`
  if (!pk) throw new Error('Missing DELEGATE_PRIVATE_KEY')

  const delegateEOA = privateKeyToAccount(pk)
  const env = getDeleGatorEnvironment(monadTestnet.id)
  const delegateSA = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [delegateEOA.address, [], [], []],
    deploySalt: '0x',
    signer: { account: delegateEOA },
    environment: env as any,
  })

  const file = join(process.cwd(), 'data', 'delegations', `${delegatorSA}.json`)
  const json = JSON.parse(readFileSync(file, 'utf-8'))
  const signed = json.signedDelegation
  const delegation = { ...signed.delegation, signature: signed.signature }
  // Validate input early with clear messages
  if (!delegation?.delegator || !delegation?.signature) {
    throw new Error('Malformed signedDelegation: missing delegator or signature')
  }

  const amountUSDC = parseUnits(String(json.job?.amountUSDC ?? '1'), 6)
  const slippageBps = Number(json.job?.slippageBps ?? 100)
  const unwrapToMon = Boolean(json.job?.unwrapToMon ?? false)

  // Pre-check: ensure delegator has enough USDC to avoid simulation revert (TransferHelper: TRANSFER_FROM_FAILED)
  try {
    const erc20Abi = [
      { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
    ] as const
    const bal = (await publicClient.readContract({
      address: USDC,
      abi: erc20Abi as any,
      functionName: 'balanceOf',
      args: [delegatorSA],
    })) as bigint
    if (bal < amountUSDC) {
      const msg = `Insufficient USDC: have ${bal.toString()}, need ${amountUSDC.toString()}`
      console.warn('[runner] skip execution:', msg)
      throw new Error(msg)
    }
  } catch (e) {
    // If read fails, proceed (bundler may still simulate); but prefer explicit error
    if (e instanceof Error && /Insufficient USDC/.test(e.message)) throw e
  }

  // Prefer executions passed from the frontend (to match exactExecutionBatch caveat); otherwise build locally.
  let executions = Array.isArray(json.job?.executions) && json.job.executions.length
    ? (json.job.executions as any[]).map((e) => ({
        target: e.target as Address,
        value: typeof e.value === 'string' ? BigInt(e.value) : BigInt(e.value ?? 0),
        callData: e.callData as `0x${string}`,
      }))
    : buildExecutions({ amountUSDC, slippageBps, unwrapToMon, recipient: delegatorSA }).executions
  // If first call is USDC.approve and allowance already sufficient, drop the approve to make repeats succeed
  try {
    const sel = (executions?.[0]?.callData as string | undefined)?.slice(0, 10)
    if (executions?.[0]?.target?.toLowerCase() === USDC.toLowerCase() && sel === '0x095ea7b3') {
      // read allowance(delegatorSA, router)
      const erc20Abi = [
        { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [ { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' } ], outputs: [ { name: '', type: 'uint256' } ] },
      ] as const
      const allowance = await publicClient.readContract({
        address: USDC,
        abi: erc20Abi as any,
        functionName: 'allowance',
        args: [delegatorSA, UNISWAP_V2_ROUTER02],
      }) as bigint
      if (allowance >= amountUSDC) {
        executions = executions.slice(1)
      }
    }
  } catch {}
  // Minimal debug context without simulations
  const debugBundle = { ...buildDebugBundle({
    label: 'runner.pre-encode',
    env,
    delegatorSA,
    delegateSA: delegateSA.address,
    signedDelegation: signed,
    executions,
  }) }
  console.log('[runner] context', JSON.stringify(debugBundle, null, 2))
  // No supportsExecutionMode probe per requirement

  // Encode redeem using the typed variant to ensure correct struct packing (one group, SingleDefault mode)
  // Normalize signed delegation shape for encode (uint256 salt, include signature)
  const flat = {
    delegate: signed.delegation.delegate,
    delegator: signed.delegation.delegator,
    authority: signed.delegation.authority,
    caveats: (signed.delegation.caveats || []).map((c: any) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args })),
    salt: signed.delegation.salt,
    signature: signed.signature,
  }
  const { encodeFunctionData, encodeAbiParameters } = await import('viem')
  // Encode permission contexts (ABI bytes for DelegationManager.redeemDelegations)
  console.log('[runner] encoding permission contexts…')
  const encodedCtxArr = encodePermissionContextsFromDelegations([[flat as any]])
  console.log('[runner] encodedCtxArr meta', { isArray: Array.isArray(encodedCtxArr), len: encodedCtxArr?.length })
  if (!Array.isArray(encodedCtxArr) || encodedCtxArr.length === 0) {
    throw new Error('encodePermissionContextsFromDelegations returned empty array')
  }
  const [ctx] = encodedCtxArr
  // Build 1 redemption per execution using SingleDefault to match enforcer expectations
  const execGroups = executions.map((e) => [e])
  const { calldatas, modes } = encodeExecutionCalldatasWithModes(execGroups)
  const permissionContexts = execGroups.map(() => ctx)
  const DM_REDEEM_ABI = [
    { type: 'function', name: 'redeemDelegations', stateMutability: 'nonpayable', inputs: [
      { name: '_permissionContexts', type: 'bytes[]' },
      { name: '_modes', type: 'bytes32[]' },
      { name: '_executionCallDatas', type: 'bytes[]' },
    ], outputs: [] },
  ] as const
  const calldata = encodeFunctionData({ abi: DM_REDEEM_ABI as any, functionName: 'redeemDelegations', args: [permissionContexts as any, modes as any, calldatas as any] }) as `0x${string}`
  console.log('[runner] calldata size', { bytes: (calldata as string).length / 2 - 1, executions: executions.length, permissionContexts: permissionContexts.length, modes: modes.length, execCalldatas: calldatas.length })
  // Resolve gas prices: prefer bundler's pimlico_getUserOperationGasPrice, then public getGasPrice, then sane floor
  let maxFeePerGas: bigint = 0n
  let maxPriorityFeePerGas: bigint = 0n
  const MIN_GAS = 80n * 10n ** 9n // 80 gwei safety floor to satisfy bundler minimums
  try {
    const res: any = await (bundlerClient as any).request?.({ method: 'pimlico_getUserOperationGasPrice', params: [] })
    const pick = res?.standard || res?.fast || res?.slow || res
    const parse = (v: any) => (typeof v === 'string' ? BigInt(v) : (typeof v === 'number' ? BigInt(v) : 0n))
    const mf = parse(pick?.maxFeePerGas)
    const mp = parse(pick?.maxPriorityFeePerGas)
    if (mf > 0n && mp > 0n) {
      maxFeePerGas = mf
      maxPriorityFeePerGas = mp
    }
  } catch {}
  if (maxFeePerGas === 0n) {
    try {
      const gp = await publicClient.getGasPrice()
      // EIP-1559: set both to gasPrice baseline; bundler can bump as needed
      maxFeePerGas = gp
      maxPriorityFeePerGas = gp / 2n || 1n
    } catch {}
  }
  if (maxFeePerGas < MIN_GAS) maxFeePerGas = MIN_GAS
  if (maxPriorityFeePerGas === 0n) maxPriorityFeePerGas = maxFeePerGas / 2n
  // Default paymaster OFF to avoid external policy reverts during debugging; can be enabled via env or job.usePaymaster
  let usePm = (process.env.USE_PAYMASTER ?? 'false').toLowerCase() === 'true'
  if (typeof json.job?.usePaymaster === 'boolean') usePm = json.job.usePaymaster
  console.log('[runner] sending userOp', {
    bundlerSet: !!process.env.ZERO_DEV_BUNDLER_RPC,
    paymasterSet: !!process.env.ZERO_DEV_PAYMASTER_RPC,
    usePm,
    delegateSA: delegateSA.address,
    dm: env.DelegationManager,
  maxFeePerGas: String(maxFeePerGas),
  maxPriorityFeePerGas: String(maxPriorityFeePerGas),
  })
  let uoHash: `0x${string}`
  try {
    uoHash = await bundlerClient.sendUserOperation({
      account: delegateSA,
  calls: [{ to: env.DelegationManager as Address, data: calldata }],
      maxFeePerGas,
      maxPriorityFeePerGas,
      ...(usePm ? { paymaster: paymasterClient } : {}),
    })
    console.log('[runner] userOp sent', { userOperationHash: uoHash })
  } catch (err: any) {
    const enriched = new Error(err?.message || 'sendUserOperation failed') as any
    enriched.cause = err?.cause || err?.stack || String(err)
    enriched.details = err?.details || err?.shortMessage
    enriched.debugBundle = debugBundle
    // Try a secondary estimate to extract inner revert data (if bundler exposes it)
    // Do not run extra simulations; still enrich error with context if available
    console.error('[runner] sendUserOperation error', {
      message: enriched.message,
      details: enriched.details,
      cause: String(enriched.cause),
      executions: summarizeExecutions(executions),
    })
    throw enriched
  }
  console.log('Sent DCA userOperationHash', uoHash)
  return uoHash
}
