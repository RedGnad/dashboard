// Server utilities - extracted for reuse
import { paymasterClient } from './clients'

// Helper to parse paymaster flags
function parseUsePaymasterFlag(v?: string): boolean { 
  return !!v && ['true','1','yes','on','enabled'].includes(v.toLowerCase()) 
}

export async function sendUserOpWithOptionalPaymaster(params: any) {
  // inject paymaster client only if enabled & rpc configured
  const pmRpc = process.env.ZERO_DEV_PAYMASTER_RPC || process.env.PIMLICO_PAYMASTER_RPC
  const pmSet = !!pmRpc
  const USE_PAYMASTER = parseUsePaymasterFlag(process.env.USE_PAYMASTER)
  const wantPm = USE_PAYMASTER || parseUsePaymasterFlag(params?.usePaymasterOverride)
  const willInject = wantPm && pmSet
  
  if (willInject) {
    console.log('[paymaster] injecting sponsorship', {
      sender: params?.account?.address,
      calls: Array.isArray(params?.calls) ? params.calls.length : 0,
      pmRpc: pmRpc ? 'set' : 'missing',
    })
  }
  
  // Remove manual gas params - let bundler/paymaster estimate automatically
  const { maxFeePerGas, maxPriorityFeePerGas, ...cleanParams } = params
  
  const augmented = {
    ...cleanParams,
    ...(willInject ? { paymaster: paymasterClient } : {}),
  }
  
  // Import bundlerClient dynamically to avoid circular imports
  const { bundlerClient } = await import('./clients')
  
  return await (bundlerClient as any).sendUserOperation(augmented)
}
