import { keccak256, encodeAbiParameters, Hex, Address } from 'viem'

// Typehashes canoniques (structure inférée) – ajuster si la lib officielle expose différents champs.
// EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
const TYPEHASH_DOMAIN = keccak256(Buffer.from('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'))
// Caveat(address enforcer,bytes terms,bytes args)
const TYPEHASH_CAVEAT = keccak256(Buffer.from('Caveat(address enforcer,bytes terms,bytes args)'))
// Delegation(address delegator,address delegate,bytes32 authority,bytes32 caveatsHash,uint256 salt)
const TYPEHASH_DELEGATION = keccak256(Buffer.from('Delegation(address delegator,address delegate,bytes32 authority,bytes32 caveatsHash,uint256 salt)'))

export interface CanonicalDomainConfig {
  name: string
  version: string
  chainId: number
  verifyingContract: Address
}

export interface DelegationCanonicalStruct {
  delegator: Address
  delegate: Address
  authority: Hex
  caveats: { enforcer: Address; terms: Hex; args?: Hex }[]
  salt: Hex | string | number | bigint
}

function normalizeSalt(s: any): bigint {
  if (typeof s === 'bigint') return s
  if (typeof s === 'number') return BigInt(s)
  if (typeof s === 'string') {
    if (s === '' || s === '0x' || s === '0') return 0n
    if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s)
    return BigInt(s)
  }
  return 0n
}

export function hashDomain(cfg: CanonicalDomainConfig): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        TYPEHASH_DOMAIN,
        keccak256(Buffer.from(cfg.name)),
        keccak256(Buffer.from(cfg.version)),
        BigInt(cfg.chainId),
        cfg.verifyingContract,
      ],
    ),
  )
}

export function hashCaveats(caveats: { enforcer: Address; terms: Hex; args?: Hex }[]): Hex {
  const hashes = caveats.map((c) =>
    keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'address' },
          { type: 'bytes' },
          { type: 'bytes' },
        ],
        [TYPEHASH_CAVEAT, c.enforcer, c.terms, c.args ?? '0x'],
      ),
    ),
  )
  return keccak256(
    encodeAbiParameters([{ type: 'bytes32[]' }], [hashes]),
  )
}

export interface CanonicalHashes {
  caveatsHash: Hex
  structHash: Hex
  domainSeparator: Hex
  digest: Hex
}

export function computeCanonicalDelegationHashes(d: DelegationCanonicalStruct, domain: CanonicalDomainConfig): CanonicalHashes {
  const caveatsArr = Array.isArray(d.caveats) ? d.caveats : []
  const caveatsHash = hashCaveats(caveatsArr)
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
      ],
      [
        TYPEHASH_DELEGATION,
        d.delegator,
        d.delegate,
        d.authority,
        caveatsHash,
        normalizeSalt(d.salt),
      ],
    ),
  )
  const domainSeparator = hashDomain(domain)
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
  return { caveatsHash, structHash, domainSeparator, digest }
}

export const typehashes = { TYPEHASH_DOMAIN, TYPEHASH_CAVEAT, TYPEHASH_DELEGATION }
