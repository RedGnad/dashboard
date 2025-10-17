export const CHAIN_ID = 10143;
export const ENTRY_POINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as const;
export const UNIVERSAL_ROUTER = '0x3ae6d8a282d67893e17aa70ebffb33ee5aa65893' as const;
export const UNISWAP_V2_ROUTER02 = '0xfb8e1c3b833f9e67a71c859a132cf783b645e436' as const;
export const WMON = '0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701' as const;
export const USDC = '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea' as const;

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

