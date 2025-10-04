import { Address, encodeFunctionData, zeroAddress, parseUnits } from 'viem';
import { UNISWAP_V2_ROUTER02, USDC, WMON } from './constants';
import { createExecution, ExecutionMode } from '@metamask/delegation-toolkit';
import { DelegationManager } from '@metamask/delegation-toolkit/contracts';

export type DcaParams = {
  amountUSDC: bigint; // in USDC (6 decimals) smallest units
  slippageBps: number; // basis points for minOut derivation (not currently enforced server-side)
  unwrapToMon: boolean;
  // Optional guaranteed minimum output for swap (pre-quoted). If omitted, defaults to 0 (unsafe in prod).
  amountOutMin?: bigint;
  // Optional amount to unwrap (defaults to amountOutMin when unwrapToMon=true).
  withdrawAmount?: bigint;
};

// Minimal ABIs
const erc20Abi = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [
    { name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }
  ], outputs: [{ name: '', type: 'bool' }] },
];

const routerAbi = [
  { name: 'swapExactTokensForTokens', type: 'function', stateMutability: 'nonpayable', inputs: [
    { name: 'amountIn', type: 'uint256' },
    { name: 'amountOutMin', type: 'uint256' },
    { name: 'path', type: 'address[]' },
    { name: 'to', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ], outputs: [{ name: 'amounts', type: 'uint256[]' }] },
];

const wmonAbi = [
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [
    { name: 'wad', type: 'uint256' }
  ], outputs: [] },
];

export function buildExecutions(params: DcaParams & { recipient: Address }) {
  const { amountUSDC, unwrapToMon, recipient, amountOutMin, withdrawAmount } = params;

  // If caller did not supply a min-out, fall back to 0 (demo only, not safe in production).
  const minOut = amountOutMin ?? 0n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 30); // generous AA deadline

  const approveRouter = createExecution({
    target: USDC,
    value: 0n,
    callData: encodeFunctionData({ abi: erc20Abi as any, functionName: 'approve', args: [UNISWAP_V2_ROUTER02, amountUSDC] }),
  });

  const swap = createExecution({
    target: UNISWAP_V2_ROUTER02,
    value: 0n,
    callData: encodeFunctionData({
      abi: routerAbi as any,
      functionName: 'swapExactTokensForTokens',
      args: [amountUSDC, minOut, [USDC, WMON], recipient, deadline],
    }),
  });

  const executions = [approveRouter, swap];

  if (unwrapToMon) {
    // Withdraw only an amount we are confident exists (withdrawAmount or minOut). Avoids revert on insufficient balance.
    const wad = withdrawAmount ?? minOut;
    if (wad > 0n) {
      const unwrap = createExecution({
        target: WMON,
        value: 0n,
        callData: encodeFunctionData({ abi: wmonAbi as any, functionName: 'withdraw', args: [wad] }),
      });
      executions.push(unwrap);
    }
  }

  return { executions };
}

export function encodeRedeemCalldata(signedDelegation: any, executions: any[]) {
  const sdel = signedDelegation?.delegation || {}
  const saltVal = typeof sdel?.salt === 'string' && sdel.salt.startsWith('0x')
    ? BigInt(sdel.salt === '0x' ? '0x0' : sdel.salt)
    : (sdel?.salt ?? 0n)
  const encSigned = { ...sdel, salt: saltVal, signature: signedDelegation.signature }
  return DelegationManager.encode.redeemDelegations({
    delegations: [encSigned as any],
    modes: [ExecutionMode.SingleDefault],
    executions: [executions],
  })
}
