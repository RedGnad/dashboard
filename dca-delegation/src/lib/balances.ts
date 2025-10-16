import { readContract, getBalance } from 'viem/actions'
import { publicClient } from './clients'
import { USDC, WMON, TOKEN_DECIMALS } from './tokens'
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

// Get MON (native token) balance
export async function getMonBalance(address: `0x${string}`) {
  try {
    const balance = await getBalance(publicClient, { address })
    return formatUnits(balance, TOKEN_DECIMALS.MON)
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
    return formatUnits(balance, TOKEN_DECIMALS.USDC)
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
    return formatUnits(balance, TOKEN_DECIMALS.WMON)
  } catch (error) {
    console.error('Failed to get WMON balance:', error)
    return '0.0'
  }
}

// Get all balances for an address
export async function getAllBalances(address: `0x${string}`) {
  const [mon, usdc, wmon] = await Promise.all([
    getMonBalance(address),
    getUsdcBalance(address),
    getWmonBalance(address)
  ])

  return { MON: mon, USDC: usdc, WMON: wmon }
}
