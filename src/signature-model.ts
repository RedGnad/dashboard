import { publicClient } from './clients'
import { keccak256, encodeAbiParameters } from 'viem'

export type SignatureModel = 'EOA' | 'ERC1271' | 'UNKNOWN' | 'ERC1271_INVALID'

// ERC-1271 magic value pour isValidSignature(hash, signature)
const MAGIC = '0x1626ba7e'

export interface DetectSignatureModelParams {
  delegator: `0x${string}`
  digest: `0x${string}`
  signature: `0x${string}`
  quick?: boolean // si true, ne fait que check code size pour heuristique
}

export interface SignatureDetectionResult {
  model: SignatureModel
  warnings: string[]
  recovered?: string | null
  erc1271Valid?: boolean
  contract?: boolean
}

export async function detectSignatureModel(params: DetectSignatureModelParams): Promise<SignatureDetectionResult> {
  const { delegator, digest, signature, quick } = params
  const warnings: string[] = []
  let code: `0x${string}` | null = null
  try { const fetched = await publicClient.getCode({ address: delegator }); if (fetched && fetched !== '0x') code = fetched as `0x${string}` } catch {}
  const isContract = code !== null
  if (!isContract) {
    // Tentative de recover EOA
    try {
      const { recoverAddress } = await import('viem')
      const rec = await recoverAddress({ hash: digest, signature })
      if (rec.toLowerCase() === delegator.toLowerCase()) {
        return { model: 'EOA', warnings, recovered: rec, contract: false }
      }
      warnings.push('SIGNER_MISMATCH')
      return { model: 'UNKNOWN', warnings, recovered: rec, contract: false }
    } catch (e) {
      warnings.push('RECOVER_FAILED')
      return { model: 'UNKNOWN', warnings, recovered: null, contract: false }
    }
  }
  if (quick) {
    // Heuristique seulement
    warnings.push('POSSIBLE_ERC1271_CONTRACT')
    return { model: 'UNKNOWN', warnings, contract: true }
  }
  // Contrat: essayer isValidSignature(hash, signature)
  // ABI minimal: function isValidSignature(bytes32,bytes) returns (bytes4)
  const sigData = encodeAbiParameters(
    [ { type: 'bytes32' }, { type: 'bytes' } ],
    [ digest, signature ],
  )
  // 0x1626ba7e = bytes4(keccak256("isValidSignature(bytes32,bytes)"))
  // Appel low-level via call() publicClient
  let valid = false
  try {
    const selector = '0x1626ba7e'
    const callData = selector + sigData.slice(2)
    const ret = await publicClient.call({ to: delegator, data: callData as `0x${string}` })
    const out = ret.data || '0x'
    if (out.slice(0, 10).toLowerCase() === MAGIC) valid = true
  } catch (e) {
    warnings.push('ERC1271_CALL_FAILED')
  }
  if (valid) {
    return { model: 'ERC1271', warnings, erc1271Valid: true, contract: true }
  } else {
    warnings.push('ERC1271_INVALID_SIGNATURE')
    return { model: 'ERC1271_INVALID', warnings, erc1271Valid: false, contract: true }
  }
}
