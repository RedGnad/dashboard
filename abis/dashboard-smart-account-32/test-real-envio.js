import { EnvioDataAdapter } from './src/adapters/envio-data-adapter.ts';

// Test avec le vrai endpoint Envio
async function testRealEnvioData() {
  console.log('🎯 Test avec le vrai endpoint Envio...\n');

  const adapter = new EnvioDataAdapter({
    endpoint: 'https://indexer.dev.hyperindex.xyz/e8e559a/v1/graphql'
  });

  try {
    console.log('📊 Génération des features IA avec données réelles...');
    const aiFeatures = await adapter.generateAIFeatures();
    
    console.log('\n✅ Features IA générées avec succès:');
    console.log(JSON.stringify(aiFeatures, null, 2));
    
    console.log('\n📈 Analyse des métriques RÉELLES:');
    const features = aiFeatures.features;
    
    console.log(`  • Momentum court terme: ${features.momentum_short_15m.toFixed(2)}%`);
    console.log(`  • Momentum long terme: ${features.momentum_long_1h.toFixed(2)}%`);
    console.log(`  • Score d'activité whale: ${features.whale_activity_score.toFixed(2)}%`);
    console.log(`  • Transfers whale détectés: ${features.whale_transfer_count}`);
    console.log(`  • Score de santé réseau: ${features.network_activity_score.toFixed(2)}`);
    console.log(`  • Fréquence transfers: ${features.transfer_frequency}/h`);
    console.log(`  • Volume 1h: ${(features.volume_1h / 1e18).toFixed(4)} WMON`);
    console.log(`  • Volume 24h: ${(features.volume_24h / 1e18).toFixed(4)} WMON`);
    console.log(`  • Momentum volume: ${features.volume_momentum.toFixed(2)}%`);
    console.log(`  • Score de risque: ${features.risk_score.toFixed(2)}`);
    console.log(`  • Score de timing DCA: ${features.timing_score.toFixed(2)}`);
    
    console.log('\n🎯 Recommandation IA LIVE:');
    if (features.timing_score > 70) {
      console.log('  ✅ EXECUTE DCA - Conditions favorables');
      console.log('     → Momentum positif + volume sain');
    } else if (features.risk_score > 70) {
      console.log('  ⚠️  PAUSE DCA - Risque élevé détecté');
      console.log('     → Forte activité whale ou réseau instable');
    } else if (features.whale_activity_score > 50) {
      console.log('  🐋 CAUTION - Forte activité whale');
      console.log('     → Attendre stabilisation');
    } else {
      console.log('  ⏳ WAIT - Conditions neutres');
      console.log('     → Momentum faible ou volume insuffisant');
    }
    
    console.log(`\n📊 Sources de données LIVE:`);
    console.log(`   • ${aiFeatures.metadata.data_points.transfers_1h} transfers sur 1h`);
    console.log(`   • ${aiFeatures.metadata.data_points.transfers_24h} transfers sur 24h`);
    console.log(`   • Threshold whale: ${(10000).toLocaleString()} WMON`);
    
    // Détails pour debugging
    if (features.whale_transfer_count > 0) {
      console.log('\n🐋 Détails activité whale:');
      console.log(`   • ${features.whale_transfer_count} transfer(s) > 10K WMON`);
      console.log(`   • Représente ${features.whale_activity_score.toFixed(1)}% du volume total`);
    }
    
  } catch (error) {
    console.error('❌ Erreur lors du test avec données réelles:', error.message);
    
    if (error.message.includes('fetch failed')) {
      console.log('\n💡 Possible solutions:');
      console.log('   • Vérifier que l\'indexer est bien déployé');
      console.log('   • Confirmer l\'endpoint est correct');
      console.log('   • Attendre que la sync soit terminée');
    }
  }
}

// Test avec données simulées aussi pour comparaison
async function testBoth() {
  console.log('🔬 Test complet: Mock vs Real Data\n');
  
  // D'abord test avec données réelles
  await testRealEnvioData();
  
  console.log('\n' + '='.repeat(50));
  console.log('📝 Pour comparaison, test avec mock data...\n');
  
  // Puis test mock pour comparaison
  const { execSync } = require('child_process');
  execSync('node test-mock-data.js', { stdio: 'inherit' });
}

testBoth();