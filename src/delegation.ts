import { Address } from 'viem';
import { createDelegation, getDeleGatorEnvironment } from '@metamask/delegation-toolkit';

export type SignedDelegation = {
  delegation: ReturnType<typeof createDelegation>;
  signature: `0x${string}`;
};

export function loadSignedDelegation(path: string): SignedDelegation {
  // Placeholder: implement file/db load later.
  throw new Error(`loadSignedDelegation not implemented for path: ${path}`);
}

export function createSpendingLimitDelegation(params: {
  chainId: number;
  delegator: Address;
  delegate: Address;
  token: Address;
  maxAmount: bigint;
}) {
  const { chainId, delegator, delegate, token, maxAmount } = params;
  const env = getDeleGatorEnvironment(chainId);
  return createDelegation({
    environment: env as any,
    to: delegate,
    from: delegator,
    scope: {
      type: 'erc20TransferAmount',
      tokenAddress: token,
      maxAmount,
    } as any,
  });
}
