export const CHAIN_ID = 10143;
export const ENTRY_POINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as const;
export const UNIVERSAL_ROUTER = '0x3ae6d8a282d67893e17aa70ebffb33ee5aa65893' as const;
export const UNISWAP_V2_ROUTER02 = '0xfb8e1c3b833f9e67a71c859a132cf783b645e436' as const;

// Routers
export const KURU_ROUTER = '0xc816865f172d640d93712C68a7E1F83F3fA63235' as const;

// Common tokens
export const WMON = '0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701' as const;
export const USDC = '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea' as const;

// Exotic tokens (available on Kuru)
export const DAKIMAKURA = '0x0569049E527BB151605EEC7bf48Cfd55bD2Bf4c8' as const;
export const WBTC = '0xcf5a6076cfa32686c0Df13aBaDa2b40dec133F1d' as const;
export const BEAN = '0x268e4e24e0051ec27b3d27a95977e71ce6875a05' as const;
export const CHOG = '0xe0590015a873bf326bd645c3e1266d4db41c4e6b' as const;
export const DAK = '0x0f0bdebf0f83cd1ee3974779bcb7315f9808c714' as const;
export const YAKI = '0xfe140e1dCe99Be9F4F15d657CD9b7BF622270C50' as const;

// --- Feature / Strategy Versioning ------------------------------------------------------------
// FEATURE_SET_VERSION roadmap:
// 1 => legacy initial set (only hash with timestamp contained in featureHash)
// 2 => current stable dual-hash publication (featureHash includes ts, featureHashV2 excludes ts)
// 3 => planned extended feature set (momentum, pnl, abnormalTransferFlag, quantized price, etc.)
// This constant is exported so that future logic (serialization, replay) can branch deterministically.
export const FEATURE_SET_VERSION: number = Number(process.env.FEATURE_SET_VERSION || 2)

// Mapping / decision logic version (mapScoreToDecision or any decision mapping semantics)
// Bump to 'map-v2' etc. if the scoring -> action translation changes in a way that impacts replay.
export const MAPPING_VERSION = 'map-v1' as const;

