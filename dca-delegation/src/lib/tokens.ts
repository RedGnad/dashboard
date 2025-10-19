// Token addresses on Monad Testnet
export type TokenMeta = {
  symbol: string
  address: `0x${string}`
  decimals: number
  isStable?: boolean
  isNative?: boolean
  logoUrl?: string
}

// Central registry of supported tokens on Monad testnet
export const TOKENS: Record<string, TokenMeta> = {
  MON: { symbol: 'MON', address: '0x0000000000000000000000000000000000000000', decimals: 18, isNative: true, logoUrl: '/tokens/mon.png' },
  USDC: { symbol: 'USDC', address: '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea', decimals: 6, isStable: true, logoUrl: '/tokens/usdc.png' },
  WMON: { symbol: 'WMON', address: '0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701', decimals: 18, logoUrl: '/tokens/wmon.png' },
  BEAN: { symbol: 'BEAN', address: '0x268e4e24e0051ec27b3d27a95977e71ce6875a05', decimals: 18, logoUrl: '/tokens/bean.png' },
  CHOG: { symbol: 'CHOG', address: '0xe0590015a873bf326bd645c3e1266d4db41c4e6b', decimals: 18, logoUrl: '/tokens/chog.png' },
  DAK: { symbol: 'DAK', address: '0x0f0bdebf0f83cd1ee3974779bcb7315f9808c714', decimals: 18, logoUrl: '/tokens/dak.png' },
  YAKI: { symbol: 'YAKI', address: '0xfe140e1dCe99Be9F4F15d657CD9b7BF622270C50', decimals: 18, logoUrl: '/tokens/yaki.png' },
  WBTC: { symbol: 'WBTC', address: '0xcf5a6076cfa32686c0Df13aBaDa2b40dec133F1d', decimals: 8, logoUrl: '/tokens/wbtc.png' },
  PINGU: { symbol: 'PINGU', address: '0xA2426cD97583939E79Cfc12aC6E9121e37D0904d', decimals: 18, logoUrl: '/tokens/pingu.png' },
  OCTO: { symbol: 'OCTO', address: '0xCa9A4F46Faf5628466583486FD5ACE8AC33ce126', decimals: 18, logoUrl: '/tokens/octo.png' },
  KB: { symbol: 'KB', address: '0x34d1ae6076aee4072f54e1156d2e507dd564a355', decimals: 18, logoUrl: '/tokens/kb.png' },
  WSOL: { symbol: 'WSOL', address: '0x5387C85A4965769f6B0Df430638a1388493486F1', decimals: 9, logoUrl: '/tokens/wsol.png' },
}

// Legacy exports for backward compatibility
export const USDC = TOKENS.USDC.address
export const WMON = TOKENS.WMON.address
export const CHOG = TOKENS.CHOG.address

export function getToken(symbol: string): TokenMeta | null {
  const key = symbol.toUpperCase()
  return TOKENS[key] || null
}

export function getSourceTokens(): TokenMeta[] {
  // Tokens that can be used as source for buying (MON and USDC)
  return [TOKENS.MON, TOKENS.USDC]
}

export function getTargetTokens(): TokenMeta[] {
  // Tokens that can be bought (exclude MON and USDC as targets)
  return Object.values(TOKENS).filter(t => !t.isNative && !t.isStable)
}

export function getAllTradableTokens(): TokenMeta[] {
  // All tokens except native MON
  return Object.values(TOKENS).filter(t => !t.isNative)
}

// Uniswap V2 Router on Monad testnet
export const UNISWAP_V2_ROUTER02 = '0xfb8e1c3b833f9e67a71c859a132cf783b645e436'

// Swap path for USDC -> WMON
export const SWAP_PATH = [USDC, WMON]

// Additional DEX routers on Monad testnet
export const KURU_ROUTER = '0xc816865f172d640d93712C68a7E1F83F3fA63235'
export const FLOW_ROUTER = '0x1B61Fab9544FF34735B2d7A0f7ff3544D8aa6536'
export const AMBIENT_CROC_DEX = '0x88B96aF200c8a9c35442C8AC6cd3D22695AaE4F0'

// UniswapV2-compatible routers we can try for swapExactTokensForTokens/getAmountsOut
export const ROUTER_V2_CANDIDATES = [
  UNISWAP_V2_ROUTER02,
  KURU_ROUTER,
  FLOW_ROUTER,
] as const

export const STAKE_MANAGER = '0x2c9C959516e9AAEdB2C748224a41249202ca8BE7'
