/**
 * Test direct du backend API pour vérifier les vraies données Envio
 * Via l'EnvioDataAdapter du backend
 */

const BACKEND_URL = 'http://localhost:3001'; // Port par défaut du backend

async function testBackendRealData() {
  console.log('🔍 Test des VRAIES données via le Backend API');
  console.log('🌐 Backend URL:', BACKEND_URL);

  try {
    console.log('\n⏳ Test de connexion au backend...');
    
    // Test de health check
    const healthResponse = await fetch(`${BACKEND_URL}/health`);
    if (!healthResponse.ok) {
      throw new Error(`Backend not accessible: ${healthResponse.status}`);
    }
    
    console.log('✅ Backend accessible');
    
    // Test des features AI avec vraies données
    console.log('\n🤖 Récupération des AI Features avec VRAIES données Envio...');
    const featuresResponse = await fetch(`${BACKEND_URL}/api/features`);
    
    if (!featuresResponse.ok) {
      throw new Error(`Features API error: ${featuresResponse.status}`);
    }
    
    const featuresData = await featuresResponse.json();
    
    console.log('\n📈 AI Features RÉELLES (Backend + Envio):');
    console.log(`  • Source: ${featuresData.metadata?.source || 'N/A'}`);
    console.log(`  • Timestamp: ${new Date(featuresData.timestamp).toLocaleString()}`);
    
    // Vérifier les métadonnées d'agrégation
    if (featuresData.metadata?.aggregation) {
      console.log(`\n🔄 Agrégation RÉELLE MON+WMON:`);
      console.log(`  • Native MON transfers: ${featuresData.metadata.aggregation.native_mon}`);
      console.log(`  • WMON ERC20 transfers: ${featuresData.metadata.aggregation.wmon_erc20}`);
      console.log(`  • Total aggregated: ${featuresData.metadata.aggregation.native_mon + featuresData.metadata.aggregation.wmon_erc20}`);
    }
    
    if (featuresData.metadata?.data_points) {
      console.log(`\n📊 Points de données RÉELS:`);
      console.log(`  • Transfers 1h: ${featuresData.metadata.data_points.transfers_1h}`);
      console.log(`  • Transfers 24h: ${featuresData.metadata.data_points.transfers_24h}`);
    }
    
    // Afficher les features principales
    console.log(`\n🎯 Features AI RÉELLES:`);
    console.log(`  • Volume 1h: ${featuresData.features.volume_1h?.toFixed(4) || 'N/A'} MON équivalent`);
    console.log(`  • Volume 24h: ${featuresData.features.volume_24h?.toFixed(4) || 'N/A'} MON équivalent`);
    console.log(`  • Momentum Short: ${(featuresData.features.momentum_short_15m * 100)?.toFixed(1) || 'N/A'}%`);
    console.log(`  • Momentum Long: ${(featuresData.features.momentum_long_1h * 100)?.toFixed(1) || 'N/A'}%`);
    console.log(`  • Whale Activity: ${featuresData.features.whale_activity_score?.toFixed(2) || 'N/A'}`);
    console.log(`  • Network Activity: ${(featuresData.features.network_activity_score * 100)?.toFixed(1) || 'N/A'}%`);
    console.log(`  • Transfer Frequency: ${featuresData.features.transfer_frequency?.toFixed(2) || 'N/A'}/h`);
    console.log(`  • Risk Score: ${(featuresData.features.risk_score * 100)?.toFixed(1) || 'N/A'}%`);
    console.log(`  • Timing Score: ${(featuresData.features.timing_score * 100)?.toFixed(1) || 'N/A'}%`);

    // Décision DCA basée sur les vraies données
    const shouldExecute = featuresData.features.timing_score > 0.7;
    console.log(`\n🎯 Décision DCA RÉELLE:`);
    console.log(`   ${shouldExecute ? '✅ EXÉCUTER DCA' : '❌ ATTENDRE'}`);
    console.log(`   Confiance: ${(featuresData.features.timing_score * 100)?.toFixed(1) || 'N/A'}%`);
    
    // Test spécifique des transfers Envio
    console.log('\n📋 Test direct des transfers Envio...');
    const transfersResponse = await fetch(`${BACKEND_URL}/api/transfers?hours=24`);
    
    if (transfersResponse.ok) {
      const transfersData = await transfersResponse.json();
      console.log(`  • Transfers trouvés: ${transfersData.length}`);
      
      if (transfersData.length > 0) {
        // Analyser par type
        const nativeTransfers = transfersData.filter(t => t.tokenAddress === '0x0000000000000000000000000000000000000000');
        const wmonTransfers = transfersData.filter(t => t.tokenAddress === '0x760afe86e5de5fa0ee542fc7b7b713e1c5425701');
        
        console.log(`  • Native MON: ${nativeTransfers.length} transfers`);
        console.log(`  • WMON ERC20: ${wmonTransfers.length} transfers`);
        
        // Afficher quelques exemples
        console.log(`\n📄 Exemples de transfers RÉELS (max 3):`);
        transfersData.slice(0, 3).forEach((transfer, i) => {
          const isNative = transfer.tokenAddress === '0x0000000000000000000000000000000000000000';
          const type = isNative ? 'Native MON' : 'WMON ERC20';
          const amount = (parseFloat(transfer.value) / (10 ** 18)).toFixed(4);
          const date = new Date(transfer.blockTimestamp * 1000).toLocaleString();
          
          console.log(`    ${i + 1}. ${type}: ${amount} (${date})`);
          console.log(`       Tx: ${transfer.transactionHash.slice(0, 12)}...`);
        });
      } else {
        console.log(`  ⚠️  Aucun transfer trouvé dans les dernières 24h`);
        console.log(`      🔄 L'indexer pourrait encore traiter les données récentes`);
      }
    } else {
      console.log(`  ❌ Erreur transfers API: ${transfersResponse.status}`);
    }
    
    console.log(`\n✅ Test terminé - Vérification des VRAIES données Envio via Backend`);
    
    if (featuresData.metadata?.note) {
      console.log(`📝 Note: ${featuresData.metadata.note}`);
    }
    
  } catch (error) {
    console.error('\n❌ Erreur lors du test backend:', error.message);
    
    if (error.message.includes('ECONNREFUSED') || error.message.includes('fetch failed')) {
      console.log('\n🔧 Solutions:');
      console.log('  • Vérifier que le backend est démarré sur le port 3001');
      console.log('  • Lancer: npm run start ou npm run api:start');
      console.log('  • Vérifier les logs du backend pour d\'éventuelles erreurs');
    }
  }
}

// Exécuter le test
testBackendRealData();