# Envio GraphQL Playground Test Queries

Une fois ton indexer déployé sur Envio, utilise ces requêtes dans le GraphQL Playground du dashboard pour tester ton déploiement.

## 🔍 1. Vérifier les données de base

### Test de connectivité et schéma
```graphql
query SchemaTest {
  __schema {
    types {
      name
    }
  }
}
```

### Vérifier les entités disponibles
```graphql
query EntitiesCheck {
  __type(name: "Query") {
    fields {
      name
      type {
        name
      }
    }
  }
}
```

## 🪙 2. Tester les TokenTransfers (Wildcard ERC20)

### Récupérer les derniers transfers
```graphql
query RecentTransfers {
  tokenTransfers(
    orderBy: blockTimestamp
    orderDirection: desc
    first: 10
  ) {
    id
    tokenAddress
    from
    to
    value
    blockNumber
    blockTimestamp
    transactionHash
  }
}
```

### Transfers USDC seulement
```graphql
query USDCTransfers {
  tokenTransfers(
    where: { 
      tokenAddress: "0xf817257fed379853cDe0fa4F97AB987181B1E5Ea"
    }
    orderBy: blockTimestamp
    orderDirection: desc
    first: 20
  ) {
    id
    from
    to
    value
    blockNumber
    blockTimestamp
  }
}
```

### Transfers WMON seulement
```graphql
query WMONTransfers {
  tokenTransfers(
    where: { 
      tokenAddress: "0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701"
    }
    orderBy: blockTimestamp
    orderDirection: desc
    first: 20
  ) {
    id
    from
    to
    value
    blockNumber
    blockTimestamp
  }
}
```

### Transfers dans les dernières 24h
```graphql
query RecentTransfers24h($timestamp: BigInt!) {
  tokenTransfers(
    where: { 
      blockTimestamp_gte: $timestamp
    }
    orderBy: blockTimestamp
    orderDirection: desc
    first: 100
  ) {
    id
    tokenAddress
    from
    to
    value
    blockTimestamp
  }
}

# Variables (remplace par timestamp actuel - 86400):
# { "timestamp": "1728691200" }
```

## 📊 3. Tester les TokenMetrics (Agrégations)

### Métriques générales des tokens
```graphql
query TokenMetrics {
  tokenMetrics(
    orderBy: lastUpdate
    orderDirection: desc
    first: 10
  ) {
    id
    tokenAddress
    tokenSymbol
    totalTransfers
    totalVolume
    uniqueHolders
    priceUSD
    lastUpdate
  }
}
```

### Métriques USDC/WMON spécifiquement
```graphql
query TrackedTokenMetrics {
  tokenMetrics(
    where: {
      tokenSymbol_in: ["USDC", "WMON"]
    }
  ) {
    id
    tokenAddress
    tokenSymbol
    totalTransfers
    totalVolume
    uniqueHolders
    priceUSD
    lastUpdate
    hourlyVolume
    dailyVolume
    volatilityScore
    momentumScore
  }
}
```

## 🔄 4. Tester les SwapEvents (Universal Router)

### Derniers swaps
```graphql
query RecentSwaps {
  swapEvents(
    orderBy: blockTimestamp
    orderDirection: desc
    first: 10
  ) {
    id
    pairKey
    tokenIn
    tokenOut
    amountIn
    amountOut
    price
    recipient
    blockNumber
    blockTimestamp
    transactionHash
  }
}
```

### Swaps WMON/USDC seulement
```graphql
query WMONUSDCSwaps {
  swapEvents(
    where: {
      pairKey: "WMON_USDC"
    }
    orderBy: blockTimestamp
    orderDirection: desc
    first: 50
  ) {
    id
    tokenIn
    tokenOut
    amountIn
    amountOut
    price
    blockTimestamp
  }
}
```

## 📈 5. Tester les PairMetrics (Agrégations Trading)

### Métriques des paires de trading
```graphql
query PairMetrics {
  pairMetrics(
    orderBy: lastUpdate
    orderDirection: desc
    first: 10
  ) {
    id
    pairKey
    hour
    swapCount
    totalVolumeIn
    totalVolumeOut
    highPrice
    lowPrice
    openPrice
    closePrice
    lastUpdate
  }
}
```

### Métriques WMON/USDC avec filtrage temporel
```graphql
query WMONUSDCMetrics($fromHour: Int!) {
  pairMetrics(
    where: {
      pairKey: "WMON_USDC"
      hour_gte: $fromHour
    }
    orderBy: hour
    orderDirection: desc
  ) {
    id
    hour
    swapCount
    totalVolumeIn
    totalVolumeOut
    highPrice
    lowPrice
    openPrice
    closePrice
  }
}

# Variables (timestamp dernières 24h divisé par 3600):
# { "fromHour": 480572 }
```

## 🎯 6. Requêtes pour AI Features

### Données complètes pour IA - dernière heure
```graphql
query AIFeatureData($hourAgo: Int!, $timestampAgo: BigInt!) {
  # Métriques tokens
  tokenMetrics(
    where: {
      tokenSymbol_in: ["USDC", "WMON"]
    }
  ) {
    tokenSymbol
    totalVolume
    volatilityScore
    momentumScore
    hourlyVolume
    dailyVolume
  }
  
  # Métriques paires récentes
  pairMetrics(
    where: {
      pairKey: "WMON_USDC"
      hour_gte: $hourAgo
    }
    orderBy: hour
    orderDirection: desc
    first: 24
  ) {
    hour
    swapCount
    highPrice
    lowPrice
    closePrice
    totalVolumeIn
  }
  
  # Transfers récents pour volume
  tokenTransfers(
    where: {
      blockTimestamp_gte: $timestampAgo
    }
    orderBy: blockTimestamp
    orderDirection: desc
    first: 100
  ) {
    tokenAddress
    value
    blockTimestamp
  }
}
```

## 🐛 7. Debugging et monitoring

### Compter les événements par type
```graphql
query EventCounts {
  tokenTransfers(first: 1) {
    id
  }
  swapEvents(first: 1) {
    id
  }
  tokenMetrics(first: 1) {
    id
  }
  pairMetrics(first: 1) {
    id
  }
}
```

### Vérifier la synchro récente
```graphql
query SyncStatus {
  tokenTransfers(
    orderBy: blockNumber
    orderDirection: desc
    first: 1
  ) {
    blockNumber
    blockTimestamp
  }
  
  swapEvents(
    orderBy: blockNumber
    orderDirection: desc
    first: 1
  ) {
    blockNumber
    blockTimestamp
  }
}
```

### Distribution des tokens trackés
```graphql
query TokenDistribution {
  tokenTransfers(
    first: 1000
  ) {
    tokenAddress
  }
}
```

## 🚨 8. Test de performance

### Large query avec pagination
```graphql
query LargeDataSet($skip: Int!) {
  tokenTransfers(
    first: 1000
    skip: $skip
    orderBy: blockTimestamp
    orderDirection: desc
  ) {
    id
    tokenAddress
    value
    blockTimestamp
  }
}

# Variables pour pagination:
# { "skip": 0 }, puis { "skip": 1000 }, etc.
```

---

## 🔧 Instructions d'utilisation

1. **Accéder au Playground :** Dashboard Envio → Ton indexer déployé → "GraphQL Playground"

2. **Endpoint URL :** `https://indexer.envio.dev/v1/graphql/<ton-deployment-id>`

3. **Tests recommandés dans l'ordre :**
   - Connectivité (query 1)
   - Schéma disponible (query 1.2)
   - Transfers de base (query 2.1)
   - Swaps de base (query 4.1)
   - Données AI complètes (query 6)

4. **Debugging si problèmes :**
   - Vérifier sync status (query 7.2)
   - Compter events (query 7.1)
   - Check distribution tokens (query 7.3)

5. **Variables dynamiques :**
   - Timestamps: `Math.floor(Date.now() / 1000)` pour maintenant
   - Hours: `Math.floor(Date.now() / 1000 / 3600)` pour heure actuelle
   - 24h ago: timestamp actuel - 86400

Ces requêtes vont te permettre de valider que :
✅ L'indexing wildcard ERC20 fonctionne  
✅ Les swaps Universal Router sont trackés
✅ Les métriques sont calculées correctement
✅ Les données sont prêtes pour l'IA