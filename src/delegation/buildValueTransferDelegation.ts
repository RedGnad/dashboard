import { Address, encodeAbiParameters, encodePacked } from 'viem'
import { createOpenDelegation, getDeleGatorEnvironment, Implementation, toMetaMaskSmartAccount } from '@metamask/delegation-toolkit'
import { publicClient } from '../clients'

// Placeholder: set deployed ValueTransferEnforcer address after deployment
export const VALUE_TRANSFER_ENFORCER: Address = '0x0000000000000000000000000000000000000000'

export type ValueTransferConfig = {
  ownerEOA: Address
  delegateEOA: Address
  allowedRecipients: Address[]
  maxPerTx?: bigint
  cap?: bigint
}

/**
 * Build + sign a delegation allowing native MON value transfers to allowedRecipients.
 * Returns { delegation, signature }
 */
export async function buildValueTransferDelegation(cfg: ValueTransferConfig) {
  const env = getDeleGatorEnvironment(10143)
  // Derive delegator smart account (ownerEOA) deterministically
  const smart = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [cfg.ownerEOA, [], [], []],
    deploySalt: '0x',
    signer: { walletClient: null as any }, // caller should sign outside if needed
    environment: env as any,
  })
  // Terms encoding: abi.encode(address[] recipients, uint256 maxPerTx, uint256 cap)
  const terms = encodeAbiParameters(
    [
      { name: 'recipients', type: 'address[]' },
      { name: 'maxPerTx', type: 'uint256' },
      { name: 'cap', type: 'uint256' },
    ],
    [cfg.allowedRecipients, cfg.maxPerTx ?? 0n, cfg.cap ?? 0n]
  )
  const delegation = createOpenDelegation({
    environment: env as any,
    from: smart.address as Address,
    scope: {
      type: 'functionCall',
      targets: cfg.allowedRecipients, // value transfer target must be recipient
      selectors: [], // empty => rely on enforcer for value only calls
      caveats: [
        {
          enforcer: VALUE_TRANSFER_ENFORCER,
          // Delegation Toolkit expects terms/args layout; we store terms in `terms`
          terms,
          args: '0x',
        },
      ],
    } as any,
  })
  return { delegation }
}
