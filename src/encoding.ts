import { Address, Hex, encodeAbiParameters, encodePacked } from 'viem'

// Solidity structs for ABI encoding
// struct Caveat { address enforcer; bytes terms; bytes args; }
// struct Delegation { address delegate; address delegator; bytes32 authority; Caveat[] caveats; uint256 salt; bytes signature; }
// struct Execution { address target; uint256 value; bytes callData; }

const CaveatComponent = {
  type: 'tuple',
  name: 'Caveat',
  components: [
    { name: 'enforcer', type: 'address' },
    { name: 'terms', type: 'bytes' },
    { name: 'args', type: 'bytes' },
  ],
} as const

const DelegationComponent = {
  type: 'tuple',
  name: 'Delegation',
  components: [
    { name: 'delegate', type: 'address' },
    { name: 'delegator', type: 'address' },
    { name: 'authority', type: 'bytes32' },
    { name: 'caveats', type: 'tuple[]', components: CaveatComponent.components },
    { name: 'salt', type: 'uint256' },
    { name: 'signature', type: 'bytes' },
  ],
} as const

const ExecutionComponent = {
  type: 'tuple',
  name: 'Execution',
  components: [
    { name: 'target', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'callData', type: 'bytes' },
  ],
} as const

function hexToBigIntOrZero(hex?: Hex): bigint {
  if (!hex || hex === '0x') return 0n
  // BigInt handles 0x-prefixed hex like 0x01...
  return BigInt(hex)
}

type DelegationLike = {
  delegate: Address
  delegator: Address
  authority: Hex
  caveats: { enforcer: Address; terms: Hex; args: Hex }[]
  salt: Hex
  signature: Hex
}

export function encodePermissionContextsFromDelegations(permissionContexts: DelegationLike[][]): Hex[] {
  // Map each context to ABI-serializable tuples with uint256 salt
  return permissionContexts.map((ctx) => {
    const serializable = ctx.map((d) => ({
      delegate: d.delegate,
      delegator: d.delegator,
      authority: d.authority,
      caveats: (d.caveats || []).map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args })),
      salt: hexToBigIntOrZero(d.salt),
      signature: d.signature,
    }))
    return encodeAbiParameters(
      [{ name: '_permissionContexts', type: 'tuple[]', components: DelegationComponent.components }],
      [serializable as any],
    )
  })
}

export function encodeExecutionCallDatasFromExecutions(executionsBatch: { target: Address; value: bigint; callData: Hex }[][]): Hex[] {
  return executionsBatch.map((executions) => {
    const serializable = executions.map((e) => ({ target: e.target, value: e.value, callData: e.callData }))
    return encodeAbiParameters(
      [{ name: '_executionCallDatas', type: 'tuple[]', components: ExecutionComponent.components }],
      [serializable as any],
    )
  })
}

// Encode execution calldatas with correct call-type per group:
// - If group has 1 execution: Single (encodePacked)
// - If group has >1: Batch (tuple[] ABI encoding)
export function encodeExecutionCalldatasWithModes(executionsBatch: { target: Address; value: bigint; callData: Hex }[][]): { calldatas: Hex[]; modes: `0x${string}`[] } {
  const calldatas: Hex[] = []
  const modes: `0x${string}`[] = []
  for (const group of executionsBatch) {
    if (group.length === 1) {
      const e = group[0]!
      calldatas.push(
        encodePacked(['address', 'uint256', 'bytes'], [e.target, e.value ?? 0n, e.callData]) as Hex,
      )
      // 0x... SingleDefault constant (from toolkit types)
      modes.push('0x0000000000000000000000000000000000000000000000000000000000000000')
    } else {
      const serializable = group.map((e) => ({ target: e.target, value: e.value ?? 0n, callData: e.callData }))
      calldatas.push(
        encodeAbiParameters(
          [{ name: '_executionCallDatas', type: 'tuple[]', components: ExecutionComponent.components }],
          [serializable as any],
        ) as Hex,
      )
      // 0x... BatchDefault constant
      modes.push('0x0100000000000000000000000000000000000000000000000000000000000000')
    }
  }
  return { calldatas, modes }
}
