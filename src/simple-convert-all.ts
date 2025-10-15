// Simple Convert All to MON - Clean implementation
import { Address, encodeFunctionData as viemEncodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Implementation, toMetaMaskSmartAccount, getDeleGatorEnvironment } from '@metamask/delegation-toolkit'
import { publicClient, asToolkitClient, monadTestnet } from './clients'
import { TOKENS } from './tokens'
import { WMON, UNISWAP_V2_ROUTER02 } from './constants'
import { encodePermissionContextsFromDelegations, encodeExecutionCalldatasWithModes } from './encoding'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// Helper to read ERC20 balance
async function readErc20Balance(tokenAddress: Address, holderAddress: Address): Promise<bigint> {
  try {
    return await publicClient.readContract({
      address: tokenAddress,
      abi: [{ type: 'function', name: 'balanceOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
      functionName: 'balanceOf',
      args: [holderAddress]
    }) as bigint
  } catch {
    return 0n
  }
}

export async function simpleConvertAllToMon(delegatorSA: string) {
  console.log(`[simple-convert] Starting for ${delegatorSA}`)
  
  // 1. Setup Delegate SA
  const pk = process.env.DELEGATE_PRIVATE_KEY as `0x${string}`
  if (!pk) throw new Error('Missing DELEGATE_PRIVATE_KEY')
  
  const eoa = privateKeyToAccount(pk)
  const env = getDeleGatorEnvironment(monadTestnet.id)
  const sa = await toMetaMaskSmartAccount({
    client: asToolkitClient(),
    implementation: Implementation.Hybrid,
    deployParams: [eoa.address, [], [], []],
    deploySalt: '0x',
    signer: { account: eoa },
    environment: env,
  })
  
  // 2. Load delegation
  const file = join(process.cwd(), 'data', 'delegations', `${delegatorSA.toLowerCase()}.json`)
  if (!existsSync(file)) throw new Error('No delegation found')
  
  const json = JSON.parse(readFileSync(file, 'utf8'))
  const signed = json.signedDelegation
  
  const flat = {
    delegate: signed.delegation.delegate,
    delegator: signed.delegation.delegator,
    authority: signed.delegation.authority,
    caveats: (signed.delegation.caveats || []).map((c: any) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args })),
    salt: signed.delegation.salt,
    signature: signed.signature,
  }
  const [ctx] = encodePermissionContextsFromDelegations([[flat as any]])
  
  // 3. Find tokens with balance > 0 (exclude WMON since we convert TO it first)
  const tokensToConvert = Object.values(TOKENS).filter(t => t.address.toLowerCase() !== WMON.toLowerCase())
  const tokensWithBalance: Array<{ symbol: string, address: string, balance: bigint }> = []
  
  for (const token of tokensToConvert) {
    const balance = await readErc20Balance(token.address as Address, delegatorSA as Address)
    if (balance > 0n) {
      tokensWithBalance.push({ symbol: token.symbol, address: token.address, balance })
      console.log(`[simple-convert] Found ${token.symbol}: ${balance.toString()} (${Number(balance) / 1e18})`)
    }
  }
  
  if (tokensWithBalance.length === 0) {
    console.log('[simple-convert] No tokens to convert')
    return { success: true, message: 'Aucun token à convertir', conversions: 0 }
  }
  
  console.log(`[simple-convert] Converting ${tokensWithBalance.length} tokens to WMON first...`)
  
  // 4. Step 1: Convert all tokens → WMON (batch in single UserOp)
  const step1Executions = []
  
  for (const token of tokensWithBalance) {
    // Approve
    step1Executions.push({
      target: token.address as Address,
      value: 0n,
      callData: viemEncodeFunctionData({
        abi: [{ type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }] }],
        functionName: 'approve',
        args: [UNISWAP_V2_ROUTER02 as Address, token.balance]
      })
    })
    
    // Swap token → WMON
    step1Executions.push({
      target: UNISWAP_V2_ROUTER02 as Address,
      value: 0n,
      callData: viemEncodeFunctionData({
        abi: [{ type: 'function', name: 'swapExactTokensForTokens', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }] }],
        functionName: 'swapExactTokensForTokens',
        args: [token.balance, 0n, [token.address, WMON] as Address[], delegatorSA as Address, BigInt(Math.floor(Date.now() / 1000) + 3600)]
      })
    })
  }
  
  // Send Step 1: All tokens → WMON
  const step1ExecGroups = [step1Executions] // Single batch
  const { calldatas: step1Calldatas, modes: step1Modes } = encodeExecutionCalldatasWithModes(step1ExecGroups)
  const step1PermissionContexts = step1ExecGroups.map(() => ctx)
  const step1Data = viemEncodeFunctionData({ 
    abi: [{ type: 'function', name: 'redeemDelegations', stateMutability: 'nonpayable', inputs: [{ name: '_permissionContexts', type: 'bytes[]' }, { name: '_modes', type: 'bytes32[]' }, { name: '_executionCallDatas', type: 'bytes[]' }], outputs: [] }], 
    functionName: 'redeemDelegations', 
    args: [step1PermissionContexts as any, step1Modes as any, step1Calldatas as any] 
  }) as `0x${string}`
  
  console.log('[simple-convert] Sending Step 1: Tokens → WMON...')
  
  // Import sendUserOpWithOptionalPaymaster from server context
  const { sendUserOpWithOptionalPaymaster } = await import('./server-utils')
  
  const step1Hash = await sendUserOpWithOptionalPaymaster({
    account: sa,
    calls: [{ to: env.DelegationManager as Address, data: step1Data }],
  })
  
  console.log(`[simple-convert] Step 1 sent: ${step1Hash}`)
  
  // 5. Wait a bit for Step 1 to confirm, then do Step 2: WMON → MON
  console.log('[simple-convert] Waiting 10s for Step 1 to confirm...')
  await new Promise(r => setTimeout(r, 10000))
  
  // Check WMON balance
  const wmonBalance = await readErc20Balance(WMON as Address, delegatorSA as Address)
  console.log(`[simple-convert] WMON balance after Step 1: ${wmonBalance.toString()} (${Number(wmonBalance) / 1e18})`)
  
  if (wmonBalance === 0n) {
    console.log('[simple-convert] No WMON to unwrap, Step 1 might still be confirming')
    return { 
      success: true, 
      message: `Étape 1 envoyée (${tokensWithBalance.length} tokens → WMON). Unwrap WMON → MON manuellement après confirmation.`,
      conversions: tokensWithBalance.length,
      step1Hash
    }
  }
  
  // 6. Step 2: WMON → MON (unwrap)
  console.log('[simple-convert] Step 2: Unwrapping WMON → MON...')
  
  const step2Executions = [{
    target: WMON as Address,
    value: 0n,
    callData: viemEncodeFunctionData({
      abi: [{ type: 'function', name: 'withdraw', inputs: [{ name: 'wad', type: 'uint256' }] }],
      functionName: 'withdraw',
      args: [wmonBalance]
    })
  }]
  
  const step2ExecGroups = [step2Executions]
  const { calldatas: step2Calldatas, modes: step2Modes } = encodeExecutionCalldatasWithModes(step2ExecGroups)
  const step2PermissionContexts = step2ExecGroups.map(() => ctx)
  const step2Data = viemEncodeFunctionData({ 
    abi: [{ type: 'function', name: 'redeemDelegations', stateMutability: 'nonpayable', inputs: [{ name: '_permissionContexts', type: 'bytes[]' }, { name: '_modes', type: 'bytes32[]' }, { name: '_executionCallDatas', type: 'bytes[]' }], outputs: [] }], 
    functionName: 'redeemDelegations', 
    args: [step2PermissionContexts as any, step2Modes as any, step2Calldatas as any] 
  }) as `0x${string}`
  
  const step2Hash = await sendUserOpWithOptionalPaymaster({
    account: sa,
    calls: [{ to: env.DelegationManager as Address, data: step2Data }],
  })
  
  console.log(`[simple-convert] Step 2 sent: ${step2Hash}`)
  
  return {
    success: true,
    message: `Conversion complète! ${tokensWithBalance.length} tokens → WMON → MON`,
    conversions: tokensWithBalance.length,
    step1Hash,
    step2Hash,
    wmonConverted: wmonBalance.toString()
  }
}
