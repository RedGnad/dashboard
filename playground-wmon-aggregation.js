/**
 * Playground pour tester l'agrégation MON/WMON avec des données simulées
 * Simule des transfers WMON récents pour valider la logique AI
 */

import { EnvioDataAdapter } from './src/adapters/envio-data-adapter.js';

// Simulation de données de transfers WMON récents
const mockRecentTransfers = [
  {
    id: '1',
    tokenAddress: '0x760afe86e5de5fa0ee542fc7b7b713e1c5425701',
    from: '0x1234567890123456789012345678901234567890',
    to: '0x0987654321098765432109876543210987654321',
    value: '5000000000000000000', // 5 WMON
    blockNumber: 1000000,
    blockTimestamp: Math.floor(Date.now() / 1000) - 1800, // 30 min ago
    transactionHash: '0xabc123'
  },
  {
    id: '2',
    tokenAddress: '0x760afe86e5de5fa0ee542fc7b7b713e1c5425701',
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    value: '15000000000000000000000', // 15,000 WMON (whale transfer)
    blockNumber: 1000001,
    blockTimestamp: Math.floor(Date.now() / 1000) - 900, // 15 min ago
    transactionHash: '0xdef456'
  },
  {
    id: '3',
    tokenAddress: '0x760afe86e5de5fa0ee542fc7b7b713e1c5425701',
    from: '0x3333333333333333333333333333333333333333',
    to: '0x4444444444444444444444444444444444444444',
    value: '2500000000000000000', // 2.5 WMON
    blockNumber: 1000002,
    blockTimestamp: Math.floor(Date.now() / 1000) - 300, // 5 min ago
    transactionHash: '0xghi789'
  }
];

const mockHistoricalTransfers = [
  ...mockRecentTransfers,
  // Ajouter des transfers plus anciens pour le calcul de momentum
  {
    id: '4',
    tokenAddress: '0x760afe86e5de5fa0ee542fc7b7b713e1c5425701',
    from: '0x5555555555555555555555555555555555555555',
    to: '0x6666666666666666666666666666666666666666',
    value: '1000000000000000000', // 1 WMON
    blockNumber: 999990,
    blockTimestamp: Math.floor(Date.now() / 1000) - 7200, // 2h ago
    transactionHash: '0xjkl012'
  },
  {
    id: '5',
    tokenAddress: '0x760afe86e5de5fa0ee542fc7b7b713e1c5425701',
    from: '0x7777777777777777777777777777777777777777',
    to: '0x8888888888888888888888888888888888888888',
    value: '8000000000000000000', // 8 WMON
    blockNumber: 999980,
    blockTimestamp: Math.floor(Date.now() / 1000) - 14400, // 4h ago
    transactionHash: '0xmno345'
  },
  {
    id: '6',
    tokenAddress: '0x760afe86e5de5fa0ee542fc7b7b713e1c5425701',
    from: '0x9999999999999999999999999999999999999999',
    to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    value: '25000000000000000000000', // 25,000 WMON (autre whale)
    blockNumber: 999970,
    blockTimestamp: Math.floor(Date.now() / 1000) - 21600, // 6h ago
    transactionHash: '0xpqr678'
  }
];

async function testWMONAggregationPlayground() {
  console.log('🎮 WMON Aggregation Playground - Données Simulées\n');
  
  // Créer un adapter avec des méthodes mockées
  const adapter = new EnvioDataAdapter({
    endpoint: 'https://indexer.dev.hyperindex.xyz/e8e559a/v1/graphql',
    refreshIntervalMs: 30000,
  });

  // Override les méthodes pour utiliser nos données simulées
  adapter.getAggregatedMonTransfers = async (hours) => {
    if (hours === 1) {
      return mockRecentTransfers;
    } else {
      return mockHistoricalTransfers;
    }
  };

  console.log('📊 Données de Test:');
  console.log(`  • Transfers récents (1h): ${mockRecentTransfers.length}`);
  console.log(`  • Transfers historiques (24h): ${mockHistoricalTransfers.length}`);
  
  // Analyser les volumes
  const recentVolume = mockRecentTransfers.reduce((sum, t) => 
    sum + parseFloat(t.value) / (10 ** 18), 0
  );
  const totalVolume = mockHistoricalTransfers.reduce((sum, t) => 
    sum + parseFloat(t.value) / (10 ** 18), 0
  );
  
  console.log(`  • Volume récent: ${recentVolume.toFixed(2)} WMON`);
  console.log(`  • Volume total: ${totalVolume.toFixed(2)} WMON`);

  // Identifier les whale transfers
  const whaleTransfers = mockHistoricalTransfers.filter(t => 
    parseFloat(t.value) / (10 ** 18) > 10000 // > 10K WMON
  );
  console.log(`  • Whale transfers: ${whaleTransfers.length}`);

  console.log('\n🤖 Génération des Features AI...');
  
  try {
    const aiFeatures = await adapter.generateAIFeatures();
    
    console.log('\n📈 Résultats AI Features:');
    console.log(`  • Momentum Court Terme: ${(aiFeatures.features.momentum_short_15m * 100).toFixed(1)}%`);
    console.log(`  • Momentum Long Terme: ${(aiFeatures.features.momentum_long_1h * 100).toFixed(1)}%`);
    console.log(`  • Score Activité Whale: ${aiFeatures.features.whale_activity_score}`);
    console.log(`  • Nombre Transfers Whale: ${aiFeatures.features.whale_transfer_count}`);
    console.log(`  • Score Santé Réseau: ${(aiFeatures.features.network_activity_score * 100).toFixed(1)}%`);
    console.log(`  • Fréquence Transfers: ${aiFeatures.features.transfer_frequency.toFixed(2)}/h`);
    console.log(`  • Volume 1h: ${aiFeatures.features.volume_1h.toFixed(2)} WMON`);
    console.log(`  • Volume 24h: ${aiFeatures.features.volume_24h.toFixed(2)} WMON`);
    console.log(`  • Momentum Volume: ${(aiFeatures.features.volume_momentum * 100).toFixed(1)}%`);
    console.log(`  • Score Risque: ${(aiFeatures.features.risk_score * 100).toFixed(1)}%`);
    console.log(`  • Score Timing: ${(aiFeatures.features.timing_score * 100).toFixed(1)}%`);

    // Décision DCA basée sur les features
    const shouldExecute = aiFeatures.features.timing_score > 0.7;
    const confidence = aiFeatures.features.timing_score;
    
    console.log(`\n🎯 Décision DCA:`);
    console.log(`   ${shouldExecute ? '✅ EXÉCUTER DCA' : '❌ ATTENDRE'}`);
    console.log(`   Confiance: ${(confidence * 100).toFixed(1)}%`);
    
    // Analyse détaillée des signaux
    console.log(`\n🔍 Analyse des Signaux:`);
    
    if (aiFeatures.features.whale_activity_score > 0.5) {
      console.log(`   ⚠️  Activité whale élevée détectée`);
    }
    
    if (aiFeatures.features.momentum_long_1h > 0.6) {
      console.log(`   📈 Momentum positif strong`);
    }
    
    if (aiFeatures.features.volume_momentum > 0.5) {
      console.log(`   💹 Volume en croissance`);
    }
    
    if (aiFeatures.features.network_activity_score > 0.7) {
      console.log(`   🟢 Réseau très actif`);
    }
    
    console.log(`\n📋 Métadonnées:`);
    console.log(`   • Source: ${aiFeatures.metadata.source}`);
    console.log(`   • Note: ${aiFeatures.metadata.note}`);
    console.log(`   • Points de données 1h: ${aiFeatures.metadata.data_points.transfers_1h}`);
    console.log(`   • Points de données 24h: ${aiFeatures.metadata.data_points.transfers_24h}`);

  } catch (error) {
    console.error('❌ Erreur lors de la génération des features:', error);
  }
}

// Exécuter le playground
testWMONAggregationPlayground()
  .then(() => {
    console.log('\n✅ Test playground terminé avec succès!');
    console.log('\n💡 Note: Ce test utilise des données simulées pour valider');
    console.log('   la logique d\'agrégation MON/WMON en attendant la sync');
    console.log('   complète de l\'indexer Envio.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Erreur du playground:', error);
    process.exit(1);
  });