import { createDelegation, getDeleGatorEnvironment } from '@metamask/delegation-toolkit'
import { Address } from 'viem'
import { monadTestnet } from '../clients'

export interface BuildDelegationParams {
  chainId?: number
  from: Address // delegator smart account (or EOA if using open delegation pattern)
  to: Address   // delegate smart account (executor)
  scope: any    // pass-through scope object matching toolkit documented scopes
  caveats?: any[] // optional declarative caveats (already in 0.13.0 format)
}

export function buildDelegation(params: BuildDelegationParams) {
  const chainId = params.chainId ?? monadTestnet.id
  const env = getDeleGatorEnvironment(chainId)
  // Minimal validation (avoid throwing deep inside toolkit with opaque messages)
  const addrRe = /^0x[0-9a-fA-F]{40}$/
  if (!addrRe.test(params.from)) throw new Error('Invalid from address')
  if (!addrRe.test(params.to)) throw new Error('Invalid to address')
  if (!params.scope || typeof params.scope !== 'object') throw new Error('Missing scope object')
  // Delegate to toolkit createDelegation (v0.13.0 supports declarative caveats directly)
  const delegation = createDelegation({
    environment: env as any,
    from: params.from,
    to: params.to,
    scope: params.scope as any,
    caveats: params.caveats as any,
  })
  return delegation
}

export interface SubmitDelegationPayload {
  signedDelegation: { delegation: any; signature: `0x${string}` }
  delegatorSA: Address
  role?: string
  job?: any
}

/**
 * Lightweight shape validation to ensure immutability (we do NOT re-compute the hash here yet).
 * Future: add EIP-712 hash recomputation & signature recovery to ensure signer === delegation.delegator.
 */
export function validateSignedDelegationShape(sd: any) {
  if (!sd || typeof sd !== 'object') throw new Error('signedDelegation missing')
  if (!sd.delegation || typeof sd.delegation !== 'object') throw new Error('delegation object missing')
  if (typeof sd.signature !== 'string' || !sd.signature.startsWith('0x')) throw new Error('signature missing/invalid')
  const d = sd.delegation
  const addrRe = /^0x[0-9a-fA-F]{40}$/
  for (const k of ['delegator','delegate']) {
    if (!addrRe.test(d[k] || '')) throw new Error(`delegation.${k} invalid`)
  }
  if (d.scope == null && !d.caveats) {
    // In 0.13.0 scope is mandatory at creation; only warn if absent (some older JSON files?)
    console.warn('[validateSignedDelegationShape] scope missing')
  }
  return true
}
