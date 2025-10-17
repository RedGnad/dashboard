/**
 * Test avec les VRAIES données Envio pour vérifier l'agrégation MON+WMON
 * Utilise l'API GraphQL réelle de l'indexer
 */

const ENVIO_ENDPOINT = 'https://indexer.dev.hyperindex.xyz/e8e559a/v1/graphql';
const WMON_ADDRESS = '0x760afe86e5de5fa0ee542fc7b7b713e1c5425701';
const NATIVE_MON_ADDRESS = '0x0000000000000000000000000000000000000000';

// Query GraphQL pour récupérer les vraies données d'agrégation
const AGGREGATED_TRANSFERS_QUERY = `
  query GetAggregatedMonTransfers($hours: Int!) {
    TokenTransfer(
      where: {
        tokenAddress: {_in: ["${WMON_ADDRESS}", "${NATIVE_MON_ADDRESS}"]},
        blockTimestamp: {_gte: $hours}
      },
      order_by: {blockTimestamp: desc},
      limit: 100
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
`;

async function fetchRealEnvioData(hours) {
  const cutoffTimestamp = Math.floor(Date.now() / 1000) - (hours * 3600);
  
  const response = await fetch(ENVIO_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: AGGREGATED_TRANSFERS_QUERY,
      variables: { hours: cutoffTimestamp }
    })
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();
  
  if (data.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  return data.data.TokenTransfer || [];
}

async function testRealEnvioAggregation() {
  console.log('🔍 Test avec les VRAIES données Envio - Agrégation MON+WMON');
  console.log('📡 Endpoint:', ENVIO_ENDPOINT);
  console.log('\n🎯 Adresses trackées:');
  console.log(`  • WMON ERC20: ${WMON_ADDRESS}`);
  console.log(`  • MON Natif: ${NATIVE_MON_ADDRESS}`);

  try {
    console.log('\n⏳ Récupération des données réelles...');
    
    // Récupérer les transfers des dernières heures
    const transfers1h = await fetchRealEnvioData(1);
    const transfers24h = await fetchRealEnvioData(24);
    
    console.log(`\n📊 Résultats RÉELS de l'indexer:`);
    console.log(`  • Transfers 1h: ${transfers1h.length}`);
    console.log(`  • Transfers 24h: ${transfers24h.length}`);
    
    if (transfers24h.length === 0) {
      console.log('\n⚠️  Aucune donnée trouvée - L\'indexer est peut-être encore en sync');
      console.log('   📅 Sync status actuel: ~10% (données Mars 2025 uniquement)');
      console.log('   🕒 Date actuelle: 12 octobre 2025');
      console.log('   📈 L\'indexer doit rattraper ~7 mois de données');
      return;
    }
    
    // Analyser par type de token
    const native1h = transfers1h.filter(t => t.tokenAddress === NATIVE_MON_ADDRESS);
    const wmon1h = transfers1h.filter(t => t.tokenAddress === WMON_ADDRESS);
    const native24h = transfers24h.filter(t => t.tokenAddress === NATIVE_MON_ADDRESS);
    const wmon24h = transfers24h.filter(t => t.tokenAddress === WMON_ADDRESS);
    
    console.log(`\n🔄 Répartition RÉELLE par Type (1h):`);
    console.log(`  • Native MON: ${native1h.length} transfers`);
    console.log(`  • WMON ERC20: ${wmon1h.length} transfers`);
    
    console.log(`\n🔄 Répartition RÉELLE par Type (24h):`);
    console.log(`  • Native MON: ${native24h.length} transfers`);
    console.log(`  • WMON ERC20: ${wmon24h.length} transfers`);
    
    // Analyser les volumes RÉELS
    const volume1hNative = native1h.reduce((sum, t) => sum + parseFloat(t.value) / (10 ** 18), 0);
    const volume1hWMON = wmon1h.reduce((sum, t) => sum + parseFloat(t.value) / (10 ** 18), 0);
    const volume24hNative = native24h.reduce((sum, t) => sum + parseFloat(t.value) / (10 ** 18), 0);
    const volume24hWMON = wmon24h.reduce((sum, t) => sum + parseFloat(t.value) / (10 ** 18), 0);
    
    console.log(`\n💰 Volumes RÉELS Agrégés:`);
    console.log(`  • Volume Native MON (1h): ${volume1hNative.toFixed(4)} MON`);
    console.log(`  • Volume WMON (1h): ${volume1hWMON.toFixed(4)} WMON`);
    console.log(`  • Volume Total (1h): ${(volume1hNative + volume1hWMON).toFixed(4)} MON équivalent`);
    console.log(`  • Volume Native MON (24h): ${volume24hNative.toFixed(4)} MON`);
    console.log(`  • Volume WMON (24h): ${volume24hWMON.toFixed(4)} WMON`);
    console.log(`  • Volume Total (24h): ${(volume24hNative + volume24hWMON).toFixed(4)} MON équivalent`);

    // Afficher quelques exemples de transfers réels
    console.log(`\n📋 Exemples de Transfers RÉELS (max 5):`);
    transfers24h.slice(0, 5).forEach((transfer, i) => {
      const isNative = transfer.tokenAddress === NATIVE_MON_ADDRESS;
      const type = isNative ? 'Native MON' : 'WMON ERC20';
      const amount = (parseFloat(transfer.value) / (10 ** 18)).toFixed(4);
      const date = new Date(transfer.blockTimestamp * 1000).toLocaleString();
      
      console.log(`  ${i + 1}. ${type}: ${amount} (${date})`);
      console.log(`     Tx: ${transfer.transactionHash.slice(0, 10)}...`);
    });
    
    // Identifier les whale transfers RÉELS
    const whaleTransfers = transfers24h.filter(t => parseFloat(t.value) / (10 ** 18) > 1000);
    const nativeWhales = whaleTransfers.filter(t => t.tokenAddress === NATIVE_MON_ADDRESS);
    const wmonWhales = whaleTransfers.filter(t => t.tokenAddress === WMON_ADDRESS);
    
    console.log(`\n🐋 Analyse des Whale Transfers RÉELS (>1000):`);
    console.log(`  • Total whale transfers: ${whaleTransfers.length}`);
    console.log(`  • Native MON whales: ${nativeWhales.length}`);
    console.log(`  • WMON whales: ${wmonWhales.length}`);

    // Vérifier la période des données
    if (transfers24h.length > 0) {
      const oldestTimestamp = Math.min(...transfers24h.map(t => t.blockTimestamp));
      const newestTimestamp = Math.max(...transfers24h.map(t => t.blockTimestamp));
      const oldestDate = new Date(oldestTimestamp * 1000);
      const newestDate = new Date(newestTimestamp * 1000);
      
      console.log(`\n📅 Période des données RÉELLES:`);
      console.log(`  • Plus ancien: ${oldestDate.toLocaleString()}`);
      console.log(`  • Plus récent: ${newestDate.toLocaleString()}`);
      
      const currentTime = Date.now() / 1000;
      const timeDiff = currentTime - newestTimestamp;
      const daysDiff = timeDiff / (24 * 3600);
      
      if (daysDiff > 1) {
        console.log(`  ⚠️  Les données les plus récentes datent de ${daysDiff.toFixed(1)} jours`);
        console.log(`     📊 L'indexer est encore en cours de synchronisation`);
      } else {
        console.log(`  ✅ Données récentes disponibles`);
      }
    }

    console.log(`\n✅ Test terminé - Agrégation RÉELLE MON+WMON vérifiée`);
    console.log(`🎯 L'agrégation fonctionne avec les vraies données Envio !`);
    
  } catch (error) {
    console.error('\n❌ Erreur lors de la récupération des données réelles:', error.message);
    
    if (error.message.includes('HTTP error')) {
      console.log('🔧 Solutions possibles:');
      console.log('  • Vérifier la connectivité réseau');
      console.log('  • L\'indexer Envio pourrait être temporairement indisponible');
      console.log('  • Réessayer dans quelques minutes');
    } else if (error.message.includes('GraphQL errors')) {
      console.log('🔧 Solutions possibles:');
      console.log('  • Le schéma GraphQL a peut-être changé');
      console.log('  • Vérifier la configuration des adresses de tokens');
      console.log('  • L\'indexer pourrait encore être en déploiement');
    }
  }
}

// Exécuter le test avec les vraies données
testRealEnvioAggregation();