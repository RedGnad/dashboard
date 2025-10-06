import { keccak256, encodeAbiParameters, Hex, Address } from 'viem'

// Domain par défaut (ajustable via env)
export interface DelegationDomainConfig {
  name: string
  version: string
  chainId: number
  verifyingContract: Address
}

export interface RawDelegationStruct {
  delegator: Address
  delegate: Address
  authority: Hex // bytes32
  caveats: { enforcer: Address; terms: Hex; args?: Hex }[]
  salt: Hex | string | number | bigint
}

export interface Hashes {
  caveatsRoot: Hex
  structHash: Hex
  domainSeparator: Hex
  digest: Hex
}

let _cachedDomainSep: { key: string; sep: Hex } | null = null

export function computeDomainSeparator(domain: DelegationDomainConfig): Hex {
  // Clé simple pour cache (le hashing complet eip712 typehash non implémenté ici: instrumentation only)
  const key = `${domain.name}|${domain.version}|${domain.chainId}|${domain.verifyingContract.toLowerCase()}`
  if (_cachedDomainSep && _cachedDomainSep.key === key) return _cachedDomainSep.sep
  // Instrumentation: on s'autorise un domainSep simplifié => keccak256(encode(name,version,chainId,verifyingContract))
  const sep = keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'string' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [domain.name, domain.version, BigInt(domain.chainId), domain.verifyingContract],
    ),
  )
  _cachedDomainSep = { key, sep }
  return sep
}

export function normalizeSalt(s: any): bigint {
  if (typeof s === 'bigint') return s
  if (typeof s === 'number') return BigInt(s)
  if (typeof s === 'string') {
    if (s === '' || s === '0x' || s === '0') return 0n
    if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s)
    return BigInt(s)
  }
  return 0n
}

export function computeDelegationHashes(d: RawDelegationStruct, domain: DelegationDomainConfig): Hashes {
  const caveats = Array.isArray(d.caveats) ? d.caveats : []
  const packed = caveats.map((c) =>
    keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes' }, { type: 'bytes' }],
        [c.enforcer, c.terms, c.args ?? '0x'],
      ),
    ),
  )
  const caveatsRoot = keccak256(
    encodeAbiParameters([{ type: 'bytes32[]' }], [packed]),
  )
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'address' }, // delegator
        { type: 'address' }, // delegate
        { type: 'bytes32' }, // authority
        { type: 'uint256' }, // salt
        { type: 'bytes32' }, // caveatsRoot
      ],
      [d.delegator, d.delegate, d.authority, normalizeSalt(d.salt), caveatsRoot],
    ),
  )
  const domainSeparator = computeDomainSeparator(domain)
  const digest = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes1' },
        { type: 'bytes1' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      ['0x19', '0x01', domainSeparator, structHash],
    ),
  )
  return { caveatsRoot, structHash, domainSeparator, digest }
}

export interface WarningContext {
  recovered?: string | null
  expectedDelegator?: string
  salt?: bigint
  duplicateStruct?: boolean
  domainMismatch?: boolean
  hasCaveats?: boolean
}

export function computeWarnings(ctx: WarningContext): string[] {
  const w: string[] = []
  if (ctx.recovered && ctx.expectedDelegator && ctx.recovered.toLowerCase() !== ctx.expectedDelegator.toLowerCase()) {
    w.push('SIGNER_MISMATCH')
  }
  if (ctx.salt === 0n) w.push('ZERO_SALT')
  if (ctx.duplicateStruct) w.push('REPLAY_RISK_DUPLICATE_STRUCT_HASH')
  if (ctx.domainMismatch) w.push('DOMAIN_MISMATCH')
  if (!ctx.hasCaveats) w.push('NO_CAVEATS')
  return w
}
