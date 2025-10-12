import { EnvioDataAdapter } from './src/adapters/envio-data-adapter.ts';

// Test avec les données historiques disponibles (mars 2025)
async function testWithHistoricalData() {
  console.log('📚 Test avec données historiques Envio (mars 2025)...\n');

  const adapter = new EnvioDataAdapter({
    endpoint: 'https://indexer.dev.hyperindex.xyz/e8e559a/v1/graphql'
  });

  try {
    // Override la méthode pour utiliser toutes les données disponibles
    const originalMethod = adapter.getRecentTransfers;
    adapter.getRecentTransfers = async function(tokenSymbol, hours) {
      // Get all historical data instead of recent
      const query = `
        query GetAllWMONTransfers {
          TokenTransfer(
            where: {
              tokenAddress: {_eq: "0x760afe86e5de5fa0ee542fc7b7b713e1c5425701"}
            }
            order_by: {blockTimestamp: desc}
            limit: 100
          ) {
            id
            tokenAddress
            from
            to
            value
            blockTimestamp
            blockNumber
            transactionHash
          }
        }
      `;
      
      try {
        const { request, gql } = await import('graphql-request');
        const data = await request(this.config.endpoint, gql`${query}`);
        console.log(`[Historical] Loaded ${data.TokenTransfer.length} WMON transfers from march`);
        return data.TokenTransfer;
      } catch (error) {
        console.error('Failed to fetch historical data:', error);
        return [];
      }
    };

    console.log('📊 Génération features IA avec données historiques...');
    const aiFeatures = await adapter.generateAIFeatures();
    
    console.log('\n✅ Features IA générées avec données mars 2025:');
    console.log(JSON.stringify(aiFeatures, null, 2));
    
    console.log('\n📈 Analyse des métriques HISTORIQUES:');
    const features = aiFeatures.features;
    
    console.log(`  • Momentum court terme: ${features.momentum_short_15m.toFixed(2)}%`);
    console.log(`  • Momentum long terme: ${features.momentum_long_1h.toFixed(2)}%`);
    console.log(`  • Score d'activité whale: ${features.whale_activity_score.toFixed(2)}%`);
    console.log(`  • Transfers whale détectés: ${features.whale_transfer_count}`);
    console.log(`  • Score de santé réseau: ${features.network_activity_score.toFixed(2)}`);
    console.log(`  • Fréquence transfers: ${features.transfer_frequency}`);
    console.log(`  • Volume 1h: ${(features.volume_1h / 1e18).toFixed(4)} WMON`);
    console.log(`  • Volume 24h: ${(features.volume_24h / 1e18).toFixed(4)} WMON`);
    console.log(`  • Score de risque: ${features.risk_score.toFixed(2)}`);
    console.log(`  • Score de timing DCA: ${features.timing_score.toFixed(2)}`);
    
    console.log('\n🎯 Recommandation IA (basée sur historique):');
    if (features.timing_score > 70) {
      console.log('  ✅ EXECUTE DCA - Conditions favorables détectées');
    } else if (features.risk_score > 70) {
      console.log('  ⚠️  PAUSE DCA - Risque élevé détecté');
    } else if (features.whale_activity_score > 30) {
      console.log('  🐋 CAUTION - Activité whale modérée');
    } else {
      console.log('  ⏳ WAIT - Conditions neutres');
    }
    
    console.log(`\n📊 Sources: ${aiFeatures.metadata.data_points.transfers_24h} transfers historiques`);
    
    if (features.whale_transfer_count > 0) {
      console.log(`\n🐋 Whale analysis: ${features.whale_transfer_count} transfers > 10K WMON detected`);
    }
    
  } catch (error) {
    console.error('❌ Erreur:', error.message);
  }
}

testWithHistoricalData();