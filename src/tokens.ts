export type TokenMeta = {
  symbol: string
  address: `0x${string}`
  decimals: number
  isStable?: boolean
}

// Central registry of supported tokens on Monad testnet
export const TOKENS: Record<string, TokenMeta> = {
  USDC: { symbol: 'USDC', address: '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea', decimals: 6, isStable: true },
  WMON: { symbol: 'WMON', address: '0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701', decimals: 18 },
  BEAN: { symbol: 'BEAN', address: '0x268e4e24e0051ec27b3d27a95977e71ce6875a05', decimals: 18 },
  CHOG: { symbol: 'CHOG', address: '0xe0590015a873bf326bd645c3e1266d4db41c4e6b', decimals: 18 },
  DAK: { symbol: 'DAK', address: '0x0f0bdebf0f83cd1ee3974779bcb7315f9808c714', decimals: 18 },
  YAKI: { symbol: 'YAKI', address: '0xfe140e1dCe99Be9F4F15d657CD9b7BF622270C50', decimals: 18 },
  WBTC: { symbol: 'WBTC', address: '0xcf5a6076cfa32686c0Df13aBaDa2b40dec133F1d', decimals: 8 },
  DAKIMAKURA: { symbol: 'DAKIMAKURA', address: '0x0569049E527BB151605EEC7bf48Cfd55bD2Bf4c8', decimals: 18 },
}

export function getToken(symbol: string): TokenMeta | null {
  const key = symbol.toUpperCase()
  return TOKENS[key] || null
}

export function listTradables(): TokenMeta[] {
  // Tradables exclude USDC as a target; we treat USDC as base/numéraire.
  return Object.values(TOKENS).filter(t => !t.isStable)
}
