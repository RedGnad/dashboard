import { readContract, getBalance } from 'viem/actions'
import { publicClient } from './clients'
import { USDC, WMON, CHOG, TOKENS, STAKE_MANAGER } from './tokens'
import { formatUnits } from 'viem'

// ERC20 ABI for balance reading
const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view'
  }
] as const

const STAKE_MANAGER_GMON_ABI = [
  {
    name: 'gMON',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view'
  }
] as const

export async function getGMonAddress() {
  try {
    const addr = await readContract(publicClient, {
      address: STAKE_MANAGER as `0x${string}`,
      abi: STAKE_MANAGER_GMON_ABI,
      functionName: 'gMON',
      args: []
    }) as `0x${string}`
    return addr
  } catch {
    return null
  }
}

// Get CHOG balance
export async function getChogBalance(address: `0x${string}`) {
  try {
    const balance = await readContract(publicClient, {
      address: CHOG,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [address]
    })
    return formatUnits(balance, TOKENS.CHOG.decimals)
  } catch (error) {
    console.error('Failed to get CHOG balance:', error)
    return '0.0'
  }
}

// Get MON (native token) balance
export async function getMonBalance(address: `0x${string}`) {
  try {
    const balance = await getBalance(publicClient, { address })
    return formatUnits(balance, TOKENS.MON.decimals)
  } catch (error) {
    console.error('Failed to get MON balance:', error)
    return '0.0'
  }
}

// Get USDC balance
export async function getUsdcBalance(address: `0x${string}`) {
  try {
    const balance = await readContract(publicClient, {
      address: USDC,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [address]
    })
    return formatUnits(balance, TOKENS.USDC.decimals)
  } catch (error) {
    console.error('Failed to get USDC balance:', error)
    return '0.0'
  }
}

// Get WMON balance
export async function getWmonBalance(address: `0x${string}`) {
  try {
    const balance = await readContract(publicClient, {
      address: WMON,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [address]
    })
    return formatUnits(balance, TOKENS.WMON.decimals)
  } catch (error) {
    console.error('Failed to get WMON balance:', error)
    return '0.0'
  }
}

// Get all balances for an address
export async function getAllBalances(address: `0x${string}`) {
  // Build balances for all tokens from TOKENS registry
  const entries = await Promise.all(
    Object.entries(TOKENS).map(async ([symbol, meta]) => {
      try {
        if (meta.isNative) {
          const bal = await getBalance(publicClient, { address })
          return [symbol, formatUnits(bal, meta.decimals)] as const
        }
        const bal = await readContract(publicClient, {
          address: meta.address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address],
        })
        return [symbol, formatUnits(bal, meta.decimals)] as const
      } catch (e) {
        console.warn(`[balances] Failed to load ${symbol} balance`, e)
        return [symbol, '0.0'] as const
      }
    })
  )

  const map: Record<string, string> = {}
  for (const [sym, val] of entries) map[sym] = val
  try {
    const gmon = await getGMonAddress()
    if (gmon) {
      const bal = await readContract(publicClient, {
        address: gmon,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [address],
      })
      map['gMON'] = formatUnits(bal, 18)
    }
  } catch {}
  return map
}
