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
  const disableMulticallEnv = String((import.meta as any).env?.VITE_DISABLE_MULTICALL ?? 'false') === 'true'
  // Session flag to avoid spamming a broken multicall endpoint
  const sessionFlagKey = 'balances:disableMulticall'
  let disableMulticall = disableMulticallEnv
  try { if (!disableMulticall) disableMulticall = localStorage.getItem(sessionFlagKey) === '1' } catch {}
  // Build balances for all tokens from TOKENS registry using multicall for ERC20s
  const erc20Entries = Object.entries(TOKENS)
    .filter(([symbol, meta]) => !meta.isNative && symbol !== 'gMON')
  const nativeEntries = Object.entries(TOKENS)
    .filter(([_, meta]) => meta.isNative)

  const map: Record<string, string> = {}

  // Native balances (usually just MON)
  for (const [symbol, meta] of nativeEntries) {
    try {
      const bal = await getBalance(publicClient, { address })
      map[symbol] = formatUnits(bal, meta.decimals)
    } catch (e) {
      console.warn(`[balances] Failed to load ${symbol} balance`, e)
      map[symbol] = '0.0'
    }
  }

  // ERC20 balances via multicall (unless disabled)
  if (!disableMulticall) {
    try {
      const calls = erc20Entries.map(([_, meta]) => ({
        address: meta.address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'balanceOf' as const,
        args: [address] as const,
      }))
      const res = await publicClient.multicall({ contracts: calls, allowFailure: true })
      res.forEach((r, i) => {
        const [symbol, meta] = erc20Entries[i]
        try {
          if ((r as any)?.status === 'success') {
            map[symbol] = formatUnits((r as any).result as bigint, (meta as any).decimals)
          } else {
            map[symbol] = '0.0'
          }
        } catch (e) {
          console.warn(`[balances] Failed to parse ${symbol} balance`, e)
          map[symbol] = '0.0'
        }
      })
    } catch (e) {
      console.warn('[balances] Multicall failed, will disable for this session and fall back sequentially')
      try { localStorage.setItem(sessionFlagKey, '1') } catch {}
      disableMulticall = true
    }
  }
  if (disableMulticall) {
    for (const [symbol, meta] of erc20Entries) {
      try {
        const bal = await readContract(publicClient, { address: meta.address as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] })
        map[symbol] = formatUnits(bal, (meta as any).decimals)
      } catch (err) {
        console.warn(`[balances] Failed to load ${symbol} balance`, err)
        map[symbol] = '0.0'
      }
    }
  }
  // Fetch gMON balance via StakeManager.gMON() to get the actual token address
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
    } else {
      // Fallback: if we can't resolve gMON address, default to 0.0 without extra RPC
      map['gMON'] = '0.0'
    }
  } catch (e) {
    console.warn('[balances] Failed to load gMON balance', e)
    if (map['gMON'] === undefined) map['gMON'] = '0.0'
  }
  return map
}
