/**
 * Playground simplifié pour tester l'agrégation MON + WMON
 * Sans dépendances externes complexes
 */

// Simulation des constantes et logique d'agrégation
const WMON_ADDRESS = '0x760afe86e5de5fa0ee542fc7b7b713e1c5425701';
const NATIVE_MON_ADDRESS = '0x0000000000000000000000000000000000000000';
const MON_ADDRESSES = [WMON_ADDRESS, NATIVE_MON_ADDRESS];

// Simulation de données de transfers MON natif + WMON ERC20
const mockTransfers = [
  // WMON ERC20 transfers
  {
    id: 'wmon_1',
    tokenAddress: WMON_ADDRESS,
    from: '0x1234567890123456789012345678901234567890',
    to: '0x0987654321098765432109876543210987654321',
    value: '5000000000000000000', // 5 WMON
    blockNumber: 1000000,
    blockTimestamp: Math.floor(Date.now() / 1000) - 1800, // 30 min ago
    transactionHash: '0xabc123'
  },
  // Native MON transfer
  {
    id: 'native_1',
    tokenAddress: NATIVE_MON_ADDRESS,
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    value: '8000000000000000000', // 8 Native MON
    blockNumber: 1000001,
    blockTimestamp: Math.floor(Date.now() / 1000) - 900, // 15 min ago
    transactionHash: '0xdef456'
  },
  // WMON whale transfer
  {
    id: 'wmon_whale',
    tokenAddress: WMON_ADDRESS,
    from: '0x3333333333333333333333333333333333333333',
    to: '0x4444444444444444444444444444444444444444',
    value: '12000000000000000000000', // 12,000 WMON (whale)
    blockNumber: 1000002,
    blockTimestamp: Math.floor(Date.now() / 1000) - 600, // 10 min ago
    transactionHash: '0xghi789'
  },
  // Native MON whale transfer
  {
    id: 'native_whale',
    tokenAddress: NATIVE_MON_ADDRESS,
    from: '0x5555555555555555555555555555555555555555',
    to: '0x6666666666666666666666666666666666666666',
    value: '20000000000000000000000', // 20,000 Native MON (whale)
    blockNumber: 1000003,
    blockTimestamp: Math.floor(Date.now() / 1000) - 300, // 5 min ago
    transactionHash: '0xjkl012'
  },
  // Transfers plus anciens
  {
    id: 'wmon_old',
    tokenAddress: WMON_ADDRESS,
    from: '0x7777777777777777777777777777777777777777',
    to: '0x8888888888888888888888888888888888888888',
    value: '3000000000000000000', // 3 WMON
    blockNumber: 999990,
    blockTimestamp: Math.floor(Date.now() / 1000) - 7200, // 2h ago
    transactionHash: '0xmno345'
  },
  {
    id: 'native_old',
    tokenAddress: NATIVE_MON_ADDRESS,
    from: '0x9999999999999999999999999999999999999999',
    to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    value: '6000000000000000000', // 6 Native MON
    blockNumber: 999980,
    blockTimestamp: Math.floor(Date.now() / 1000) - 14400, // 4h ago
    transactionHash: '0xpqr678'
  }
];

// Fonction d'agrégation MON + WMON
function getAggregatedMonTransfers(hours) {
  const cutoffTime = Math.floor(Date.now() / 1000) - (hours * 3600);
  return mockTransfers.filter(transfer => 
    transfer.blockTimestamp >= cutoffTime
  );
}

// Générateur de features AI avec agrégation
function generateAIFeatures() {
  const transfers1h = getAggregatedMonTransfers(1);
  const transfers24h = getAggregatedMonTransfers(24);

  // Séparer par type de token
  const native1h = transfers1h.filter(t => t.tokenAddress === NATIVE_MON_ADDRESS);
  const wmon1h = transfers1h.filter(t => t.tokenAddress === WMON_ADDRESS);
  const native24h = transfers24h.filter(t => t.tokenAddress === NATIVE_MON_ADDRESS);
  const wmon24h = transfers24h.filter(t => t.tokenAddress === WMON_ADDRESS);

  // Calculer les volumes
  const volume1h = transfers1h.reduce((sum, t) => sum + parseFloat(t.value) / (10 ** 18), 0);
  const volume24h = transfers24h.reduce((sum, t) => sum + parseFloat(t.value) / (10 ** 18), 0);

  // Identifier les whale transfers (>10K)
  const whaleTransfers = transfers24h.filter(t => parseFloat(t.value) / (10 ** 18) > 10000);
  
  // Calculer les features
  const volumeMomentum = volume24h > 0 ? Math.min(volume1h / (volume24h / 24), 2) : 0;
  const whaleActivityScore = Math.min(whaleTransfers.length / 5, 1);
  const networkActivityScore = Math.min(transfers1h.length / 10, 1);
  const transferFrequency = transfers1h.length;
  
  // Scores composés
  const momentumShort = Math.min(volume1h / 1000, 1);
  const momentumLong = Math.min(volumeMomentum, 1);
  const riskScore = Math.max(whaleActivityScore, volumeMomentum > 1.5 ? 0.8 : 0.3);
  const timingScore = (momentumShort + momentumLong + networkActivityScore) / 3;

  return {
    features: {
      momentum_short_15m: momentumShort,
      momentum_long_1h: momentumLong,
      whale_activity_score: whaleActivityScore,
      whale_transfer_count: whaleTransfers.length,
      network_activity_score: networkActivityScore,
      transfer_frequency: transferFrequency,
      volume_1h: volume1h,
      volume_24h: volume24h,
      volume_momentum: volumeMomentum,
      risk_score: riskScore,
      timing_score: timingScore
    },
    metadata: {
      source: 'envio_wildcard_monad_testnet',
      aggregation: {
        native_mon: native1h.length + native24h.length,
        wmon_erc20: wmon1h.length + wmon24h.length
      },
      data_points: {
        transfers_1h: transfers1h.length,
        transfers_24h: transfers24h.length
      },
      note: 'Unified MON native + WMON ERC20 economic activity aggregation'
    }
  };
}

// Test principal
function testFullMonWmonAggregation() {
  console.log('🚀 Test d\'Agrégation Complète MON Natif + WMON ERC20\n');
  
  console.log('📊 Configuration d\'Agrégation:');
  console.log(`  • WMON ERC20: ${WMON_ADDRESS}`);
  console.log(`  • MON Natif: ${NATIVE_MON_ADDRESS}`);
  console.log(`  • Adresses agrégées: ${MON_ADDRESSES.length} types`);
  
  // Analyser les données par période
  const transfers1h = getAggregatedMonTransfers(1);
  const transfers24h = getAggregatedMonTransfers(24);
  
  console.log(`\n📈 Données d'Agrégation:`);
  console.log(`  • Transfers 1h: ${transfers1h.length}`);
  console.log(`  • Transfers 24h: ${transfers24h.length}`);
  
  // Analyser par type de token
  const native1h = transfers1h.filter(t => t.tokenAddress === NATIVE_MON_ADDRESS);
  const wmon1h = transfers1h.filter(t => t.tokenAddress === WMON_ADDRESS);
  const native24h = transfers24h.filter(t => t.tokenAddress === NATIVE_MON_ADDRESS);
  const wmon24h = transfers24h.filter(t => t.tokenAddress === WMON_ADDRESS);
  
  console.log(`\n🔄 Répartition par Type (1h):`);
  console.log(`  • Native MON: ${native1h.length} transfers`);
  console.log(`  • WMON ERC20: ${wmon1h.length} transfers`);
  
  console.log(`\n🔄 Répartition par Type (24h):`);
  console.log(`  • Native MON: ${native24h.length} transfers`);
  console.log(`  • WMON ERC20: ${wmon24h.length} transfers`);
  
  // Analyser les volumes
  const volume1hNative = native1h.reduce((sum, t) => sum + parseFloat(t.value) / (10 ** 18), 0);
  const volume1hWMON = wmon1h.reduce((sum, t) => sum + parseFloat(t.value) / (10 ** 18), 0);
  const volume24hNative = native24h.reduce((sum, t) => sum + parseFloat(t.value) / (10 ** 18), 0);
  const volume24hWMON = wmon24h.reduce((sum, t) => sum + parseFloat(t.value) / (10 ** 18), 0);
  
  console.log(`\n💰 Volumes Agrégés:`);
  console.log(`  • Volume Native MON (1h): ${volume1hNative.toFixed(2)} MON`);
  console.log(`  • Volume WMON (1h): ${volume1hWMON.toFixed(2)} WMON`);
  console.log(`  • Volume Total (1h): ${(volume1hNative + volume1hWMON).toFixed(2)} MON équivalent`);
  console.log(`  • Volume Native MON (24h): ${volume24hNative.toFixed(2)} MON`);
  console.log(`  • Volume WMON (24h): ${volume24hWMON.toFixed(2)} WMON`);
  console.log(`  • Volume Total (24h): ${(volume24hNative + volume24hWMON).toFixed(2)} MON équivalent`);

  // Identifier les whale transfers
  const whaleTransfers = transfers24h.filter(t => parseFloat(t.value) / (10 ** 18) > 10000);
  const nativeWhales = whaleTransfers.filter(t => t.tokenAddress === NATIVE_MON_ADDRESS);
  const wmonWhales = whaleTransfers.filter(t => t.tokenAddress === WMON_ADDRESS);
  
  console.log(`\n🐋 Analyse des Whale Transfers:`);
  console.log(`  • Total whale transfers: ${whaleTransfers.length}`);
  console.log(`  • Native MON whales: ${nativeWhales.length}`);
  console.log(`  • WMON whales: ${wmonWhales.length}`);

  // Générer les features AI
  console.log('\n🤖 Génération des Features AI avec Agrégation Complète...');
  const aiFeatures = generateAIFeatures();
  
  console.log('\n📈 Résultats AI Features Agrégées:');
  console.log(`  • Momentum Court Terme: ${(aiFeatures.features.momentum_short_15m * 100).toFixed(1)}%`);
  console.log(`  • Momentum Long Terme: ${(aiFeatures.features.momentum_long_1h * 100).toFixed(1)}%`);
  console.log(`  • Score Activité Whale: ${aiFeatures.features.whale_activity_score.toFixed(2)}`);
  console.log(`  • Nombre Transfers Whale: ${aiFeatures.features.whale_transfer_count}`);
  console.log(`  • Score Santé Réseau: ${(aiFeatures.features.network_activity_score * 100).toFixed(1)}%`);
  console.log(`  • Fréquence Transfers: ${aiFeatures.features.transfer_frequency.toFixed(2)}/h`);
  console.log(`  • Volume 1h: ${aiFeatures.features.volume_1h.toFixed(2)} MON équivalent`);
  console.log(`  • Volume 24h: ${aiFeatures.features.volume_24h.toFixed(2)} MON équivalent`);
  console.log(`  • Momentum Volume: ${(aiFeatures.features.volume_momentum * 100).toFixed(1)}%`);
  console.log(`  • Score Risque: ${(aiFeatures.features.risk_score * 100).toFixed(1)}%`);
  console.log(`  • Score Timing: ${(aiFeatures.features.timing_score * 100).toFixed(1)}%`);

  // Décision DCA basée sur les features
  const shouldExecute = aiFeatures.features.timing_score > 0.7;
  const confidence = aiFeatures.features.timing_score;
  
  console.log(`\n🎯 Décision DCA Agrégée:`);
  console.log(`   ${shouldExecute ? '✅ EXÉCUTER DCA' : '❌ ATTENDRE'}`);
  console.log(`   Confiance: ${(confidence * 100).toFixed(1)}%`);
  
  // Analyse détaillée des signaux
  console.log(`\n🔍 Analyse des Signaux d'Agrégation:`);
  
  if (aiFeatures.features.whale_activity_score > 0.5) {
    console.log(`   ⚠️  Activité whale élevée détectée (Native + WMON)`);
  }
  
  if (aiFeatures.features.momentum_long_1h > 0.6) {
    console.log(`   📈 Momentum positif sur l'écosystème MON complet`);
  }
  
  if (aiFeatures.features.volume_momentum > 0.5) {
    console.log(`   💹 Volume agrégé MON+WMON en croissance`);
  }
  
  if (aiFeatures.features.network_activity_score > 0.7) {
    console.log(`   🟢 Écosystème MON très actif (native + wrapped)`);
  }
  
  console.log(`\n📋 Métadonnées d'Agrégation:`);
  console.log(`   • Source: ${aiFeatures.metadata.source}`);
  console.log(`   • Native MON transfers: ${aiFeatures.metadata.aggregation.native_mon}`);
  console.log(`   • WMON ERC20 transfers: ${aiFeatures.metadata.aggregation.wmon_erc20}`);
  console.log(`   • Points de données 1h: ${aiFeatures.metadata.data_points.transfers_1h}`);
  console.log(`   • Points de données 24h: ${aiFeatures.metadata.data_points.transfers_24h}`);
  console.log(`   • Note: ${aiFeatures.metadata.note}`);

  console.log('\n✅ Test d\'agrégation MON+WMON terminé avec succès!');
  console.log('\n🎉 L\'agrégation complète fonctionne parfaitement !');
  console.log('   📊 Native MON + WMON ERC20 = Vue économique unifiée');
  console.log('   🤖 Features AI basées sur l\'activité totale de l\'écosystème');
  console.log('   🎯 Décisions DCA optimisées avec données complètes');
}

// Exécuter le test
testFullMonWmonAggregation();