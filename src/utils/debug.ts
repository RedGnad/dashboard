import type { Address } from 'viem'

type AnyDelegation = {
  delegate?: Address
  delegator?: Address
  authority?: string
  salt?: string
  caveats?: any[]
  [k: string]: any
}

type AnyExecution = { target: Address; value?: bigint | string | number; callData: `0x${string}` }

export function summarizeExecutions(executions: AnyExecution[]) {
  try {
    return (executions || []).map((e) => ({
      target: e.target,
      value: (typeof e.value === 'bigint' ? e.value.toString() : String(e.value ?? 0)),
      selector: (e.callData as string)?.slice(0, 10),
      dataLen: (e.callData as string)?.length ?? 0,
    }))
  } catch {
    return []
  }
}

export function summarizeDelegation(input: AnyDelegation) {
  try {
    const d = input || ({} as AnyDelegation)
    const caveats = Array.isArray(d.caveats) ? d.caveats : []
    const caveatSummaries = caveats.map((c: any) => ({
      // Try to surface a human hint if present, fall back to keys
      type: c?.type || c?.enforcer || Object.keys(c || {}),
      keys: Object.keys(c || {}),
      preview: safeTruncate(JSON.stringify(c), 240),
    }))
    return {
      delegate: d.delegate,
      delegator: d.delegator,
      authority: d.authority,
      salt: d.salt,
      caveats: caveatSummaries,
    }
  } catch {
    return { note: 'failed to summarize delegation' }
  }
}

export function safeTruncate(str: string, max = 240) {
  try {
    return (str || '').length > max ? str.slice(0, max) + '…' : str
  } catch {
    return ''
  }
}

export function buildDebugBundle(params: {
  label: string
  env?: any
  delegatorSA?: Address
  delegateSA?: Address
  signedDelegation?: any
  executions?: AnyExecution[]
}) {
  const { label, env, delegatorSA, delegateSA, signedDelegation, executions } = params
  return {
    label,
    chainId: env?.chainId,
    env: env
      ? {
          DelegationManager: env.DelegationManager,
          CaveatEnforcers: env.CaveatEnforcers ?? undefined,
        }
      : undefined,
    actors: { delegatorSA, delegateSA },
    delegation: summarizeDelegation(signedDelegation?.delegation || signedDelegation || {}),
    executions: summarizeExecutions(executions || []),
  }
}
