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
  MON: { symbol: 'MON', address: '0x0000000000000000000000000000000000000000', decimals: 18, isNative: true, logoUrl: 'https://imagedelivery.net/cBNDGgkrsEA-b_ixIp9SkQ/I_t8rg_V_400x400.jpg/public' },
  USDC: { symbol: 'USDC', address: '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea', decimals: 6, isStable: true, logoUrl: 'https://imagedelivery.net/cBNDGgkrsEA-b_ixIp9SkQ/usdc.png/public' },
  WMON: { symbol: 'WMON', address: '0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701', decimals: 18, logoUrl: 'https://imagedelivery.net/cBNDGgkrsEA-b_ixIp9SkQ/I_t8rg_V_400x400.jpg/public' },
  BEAN: { symbol: 'BEAN', address: '0x268e4e24e0051ec27b3d27a95977e71ce6875a05', decimals: 18, logoUrl: 'https://w3-images.s3.ap-southeast-1.amazonaws.com/bean_logo.jpg' },
  CHOG: { symbol: 'CHOG', address: '0xe0590015a873bf326bd645c3e1266d4db41c4e6b', decimals: 18, logoUrl: 'https://imagedelivery.net/tWwhAahBw7afBzFUrX5mYQ/5d1206c2-042c-4edc-9f8b-dcef2e9e8f00/public' },
  DAK: { symbol: 'DAK', address: '0x0f0bdebf0f83cd1ee3974779bcb7315f9808c714', decimals: 18, logoUrl: 'https://imagedelivery.net/tWwhAahBw7afBzFUrX5mYQ/27759359-9374-4995-341c-b2636a432800/public' },
  YAKI: { symbol: 'YAKI', address: '0xfe140e1dCe99Be9F4F15d657CD9b7BF622270C50', decimals: 18, logoUrl: 'https://imagedelivery.net/tWwhAahBw7afBzFUrX5mYQ/6679b698-a845-412b-504b-23463a3e1900/public' },
  WBTC: { symbol: 'WBTC', address: '0xcf5a6076cfa32686c0Df13aBaDa2b40dec133F1d', decimals: 8, logoUrl: 'https://imagedelivery.net/cBNDGgkrsEA-b_ixIp9SkQ/wbtc.png/public' },
  PINGU: { symbol: 'PINGU', address: '0xA2426cD97583939E79Cfc12aC6E9121e37D0904d', decimals: 18, logoUrl: 'https://pingu.exchange/external/token-512.png' },
  OCTO: { symbol: 'OCTO', address: '0xCa9A4F46Faf5628466583486FD5ACE8AC33ce126', decimals: 18, logoUrl: 'https://test.octo.exchange/assets/img/platforms/octoswap.png' },
  // KB: utiliser l'avatar Twitter via unavatar (CORS-friendly). Fallback géré côté UI.
  KB: { symbol: 'KB', address: '0x34d1ae6076aee4072f54e1156d2e507dd564a355', decimals: 18, logoUrl: 'https://unavatar.io/twitter/kryptobaby777' },
  WSOL: { symbol: 'WSOL', address: '0x5387C85A4965769f6B0Df430638a1388493486F1', decimals: 9, logoUrl: 'https://imagedelivery.net/cBNDGgkrsEA-b_ixIp9SkQ/sol.png/public' },
  // Prefer official Magma image; fallback to Pinata IPFS if needed
  gMON: { symbol: 'gMON', address: '0x2c9C959516e9AAEdB2C748224a41249202ca8BE7', decimals: 18, logoUrl: 'https://green-adjacent-sheep-82.mypinata.cloud/ipfs/bafkreie3p6vymabk3f3bp7j2776xkrewhwl5odojxix4lwsrqdgok4ncvm' }, // gMON logo (Pinata fallback)
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
  // Exclude gMON (stake token) from tradeable/metric targets
  return Object.values(TOKENS).filter(t => !t.isNative && !t.isStable && t.symbol !== 'gMON')
}

export function getAllTradableTokens(): TokenMeta[] {
  // All tokens except native MON
  // Exclude gMON from generic tradeable lists
  return Object.values(TOKENS).filter(t => !t.isNative && t.symbol !== 'gMON')
}

// Uniswap V2 Router on Monad testnet
export const UNISWAP_V2_ROUTER02 = '0xfb8e1c3b833f9e67a71c859a132cf783b645e436'

// Swap path for USDC -> WMON
export const SWAP_PATH = [USDC, WMON]

// Additional DEX routers (informational)
export const KURU_ROUTER = '0xc816865f172d640d93712C68a7E1F83F3fA63235'
export const FLOW_ROUTER = '0x1B61Fab9544FF34735B2d7A0f7ff3544D8aa6536'
export const AMBIENT_CROC_DEX = '0x88B96aF200c8a9c35442C8AC6cd3D22695AaE4F0'

// UniswapV2-compatible routers we can try for swapExactTokensForTokens/getAmountsOut
// Fallback quotes: n'utiliser que le routeur Uniswap V2 canonique pour éviter des ABI non-compatibles
export const ROUTER_V2_CANDIDATES = [
  UNISWAP_V2_ROUTER02,
] as const

export const STAKE_MANAGER = '0x2c9C959516e9AAEdB2C748224a41249202ca8BE7'

// Preferred UniswapV2-like pair addresses to compute prices from reserves (more reliable than router on some testnets)
// Keys are token addresses (lowercase). For USDC direct pairs, set usdcPair; for WMON pairs, set wmonPair.
export const PAIR_WMON_USDC = '0x159E8445313aaD3eB0a9a373bfa313db5D4131C5' as const
export const PREFERRED_PAIRS: Record<string, { usdcPair?: `0x${string}`; wmonPair?: `0x${string}` }> = {
  // CHOG/WMON
  [TOKENS.CHOG.address.toLowerCase()]: { wmonPair: '0x4d2E4c5FF07d1C82d512335dEA0a1Aa82c031a86' },
  // DAK/WMON
  [TOKENS.DAK.address.toLowerCase()]: { wmonPair: '0x6007A0804fE538745FFEd91F9c124Cd3ce06102D' },
  // YAKI/WMON
  [TOKENS.YAKI.address.toLowerCase()]: { wmonPair: '0x6DeF0Cf33D16F067C95F9dF8918b876DD360561C' },
  // PINGU/WMON
  [TOKENS.PINGU.address.toLowerCase()]: { wmonPair: '0x3611A3e98fC6546d8fB3235C8A2ae7072915BF28' },
  // WSOL/USDC
  [TOKENS.WSOL.address.toLowerCase()]: { usdcPair: '0xE8736384c92E077dC8536D0d2B974bAeBb52c360' },
  // WBTC/USDC
  [TOKENS.WBTC.address.toLowerCase()]: { usdcPair: '0x1df72ACFf7fd1Fdc392ad44Dd2167f6BAAF6c559' },
}
