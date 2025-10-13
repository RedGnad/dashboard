# Smart Router avec Fallback Kuru

## Vue d'Ensemble

Le Smart Router route automatiquement les swaps via **Uniswap** ou **Kuru** selon la disponibilité des paires.

### Paires Supportées

| Paire | Uniswap | Kuru | Router Utilisé |
|-------|---------|------|----------------|
| WMON/USDC | ✅ | ✅ | Uniswap (défaut) |
| WMON/DAKIMAKURA | ❌ | ✅ | **Kuru (fallback)** |
| WMON/WBTC | ❌ | ✅ | **Kuru (fallback)** |
| WMON/BEAN | ❌ | ✅ | **Kuru (fallback)** |
| WMON/CHOG | ❌ | ✅ | **Kuru (fallback)** |
| WMON/DAK | ❌ | ✅ | **Kuru (fallback)** |
| WMON/YAKI | ❌ | ✅ | **Kuru (fallback)** |

---

## Utilisation

### 1. Swap Standard (USDC → WMON)
```typescript
import { buildExecutions } from './dca';
import { USDC, WMON } from './constants';
import { parseUnits } from 'viem';

// Swap classique via Uniswap
const result = await buildExecutions({
  amountUSDC: parseUnits('100', 6), // 100 USDC
  slippageBps: 50, // 0.5% slippage
  unwrapToMon: false,
  recipient: '0x...',
  amountOutMin: parseUnits('95', 18), // Min 95 WMON
});

console.log('Router utilisé:', result.router); // 'uniswap'
```

### 2. Swap Exotique (WMON → DAKIMAKURA)
```typescript
import { buildExecutions } from './dca';
import { WMON } from './constants';
import { DAKIMAKURA } from './routing/kuru-router';
import { parseUnits } from 'viem';

// Swap exotique via Kuru (fallback automatique)
const result = await buildExecutions({
  tokenIn: WMON,
  tokenOut: DAKIMAKURA,
  amountUSDC: parseUnits('10', 18), // 10 WMON (réutilise le param amountUSDC)
  slippageBps: 100, // 1% slippage
  unwrapToMon: false,
  recipient: '0x...',
  amountOutMin: parseUnits('1000', 18), // Min 1000 DAKIMAKURA
});

console.log('Router utilisé:', result.router); // 'kuru'
```

### 3. Forcer un Router Spécifique
```typescript
// Forcer Kuru même pour une paire disponible sur Uniswap
const result = await buildExecutions({
  amountUSDC: parseUnits('100', 6),
  slippageBps: 50,
  unwrapToMon: false,
  recipient: '0x...',
  forceRouter: 'kuru', // Force Kuru
});
```

---

## Intégration dans runner.ts

Le `runner.ts` peut maintenant supporter des swaps exotiques :

```typescript
// Dans le fichier de délégation (data/delegations/0x....json)
{
  "job": {
    "source": "WMON",
    "amountMON": "10",
    "tokenOut": "0x0569049E527BB151605EEC7bf48Cfd55bD2Bf4c8", // DAKIMAKURA
    "forceRouter": "kuru" // Optionnel
  }
}
```

Puis dans `runner.ts` :
```typescript
const tokenOut = json.job?.tokenOut || WMON;
const forceRouter = json.job?.forceRouter as SwapRoute | undefined;

const { executions, router } = await buildExecutions({
  tokenIn: WMON,
  tokenOut,
  amountUSDC: amountMON,
  slippageBps: 50,
  unwrapToMon: false,
  recipient: delegateSA.address,
  forceRouter,
});

console.log(`[Runner] Using ${router} for swap`);
```

---

## Adresses de Contrats

### Kuru (Monad Testnet)
- **Router**: `0xc816865f172d640d93712C68a7E1F83F3fA63235`
- **MON/USDC Orderbook**: `0xd3af145f1aa1a471b5f0f62c52cf8fcdc9ab55d3`

### Tokens Exotiques
- **DAKIMAKURA**: `0x0569049E527BB151605EEC7bf48Cfd55bD2Bf4c8`
- **WBTC**: `0xcf5a6076cfa32686c0Df13aBaDa2b40dec133F1d`
- **BEAN**: `0x268e4e24e0051ec27b3d27a95977e71ce6875a05`
- **CHOG**: `0xe0590015a873bf326bd645c3e1266d4db41c4e6b`
- **DAK**: `0x0f0bdebf0f83cd1ee3974779bcb7315f9808c714`
- **YAKI**: `0xfe140e1dCe99Be9F4F15d657CD9b7BF622270C50`

---

## Logs de Débogage

Le Smart Router log automatiquement les routes :

```
[SmartRouter] Exotic pair detected, checking Kuru...
[SmartRouter] Using Kuru for exotic pair
[Kuru] Route found: WMON_DAKIMAKURA via market 0xd3af145f...
[SmartRouter] Swap: WMON -> DAKIMAKURA
[SmartRouter] Router: kuru
[SmartRouter] Amount In: 10000000000000000000
[SmartRouter] Min Out: 1000000000000000000000
[SmartRouter] Kuru Markets: 0xd3af145f1aa1a471b5f0f62c52cf8fcdc9ab55d3
```

---

## Limitations Actuelles

### 1. Pas de Quote Kuru
Le module `getKuruQuote()` retourne actuellement `0n`. Pour l'intégrer :
- Utiliser l'API Kuru (nécessite une clé API)
- Ou appeler un contrat estimator on-chain

### 2. Markets Kuru Limités
Seul le market MON/USDC est configuré. Pour ajouter d'autres markets :
1. Trouver l'adresse de l'orderbook sur https://docs.kuru.io/developers/contracts
2. Ajouter dans `KURU_MARKETS` dans `kuru-router.ts`

### 3. Pas de Multi-Hop
Le routing actuel ne supporte que les swaps directs (1 market).
Pour MON → DAKIMAKURA, il faudrait potentiellement :
- MON → USDC (market 1)
- USDC → DAKIMAKURA (market 2)

---

## Tests

### Test 1: Swap USDC → WMON (Uniswap)
```bash
# Devrait utiliser Uniswap
npm run test:swap -- --tokenIn USDC --tokenOut WMON --amount 100
```

### Test 2: Swap WMON → DAKIMAKURA (Kuru)
```bash
# Devrait utiliser Kuru
npm run test:swap -- --tokenIn WMON --tokenOut DAKIMAKURA --amount 10
```

### Test 3: Force Kuru pour USDC → WMON
```bash
# Devrait utiliser Kuru même si Uniswap est disponible
npm run test:swap -- --tokenIn USDC --tokenOut WMON --amount 100 --forceRouter kuru
```

---

## Prochaines Étapes

1. **Intégrer l'API Kuru** pour obtenir des quotes réels
2. **Ajouter plus de markets** Kuru (DAKIMAKURA/USDC, WBTC/USDC, etc.)
3. **Implémenter le multi-hop routing** pour les paires sans market direct
4. **Ajouter des tests unitaires** pour chaque paire
5. **Monitorer les échecs** de swap et ajuster les fallbacks

---

## Support

- **Kuru Docs**: https://docs.kuru.io
- **Kuru SDK**: https://github.com/Kuru-Labs/kuru-sdk
- **Kuru Discord**: https://discord.gg/kuru
