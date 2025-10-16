// Token addresses on Monad Testnet
export const USDC = '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea' as const // 6 decimals
export const WMON = '0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701' as const // 18 decimals
export const UNISWAP_V2_ROUTER02 = '0xfb8e1c3b833f9e67a71c859a132cf783b645e436' as const

// Token metadata
export const TOKEN_DECIMALS = {
  USDC: 6,
  WMON: 18,
  MON: 18,
} as const

// Function selectors for delegation permissions
export const FUNCTION_SELECTORS = {
  APPROVE: 'approve(address,uint256)',
  SWAP_EXACT_TOKENS_FOR_TOKENS: 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
  WITHDRAW: 'withdraw(uint256)',
} as const

// Swap path for USDC -> WMON
export const SWAP_PATH = [USDC, WMON] as const
