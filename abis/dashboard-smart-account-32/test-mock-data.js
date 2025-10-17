// Test avec données simulées pour valider la logique IA

const mockTransfers = [
  {
    value: '4000000000000000000000', // 4,000 WMON
    from: '0x3aE6D8A282D67893e17AA70ebFFb33EE5aa65893',
    to: '0x0B924f975F67632C1b8Af61B5B63415976a88791',
    blockTimestamp: Math.floor(Date.now() / 1000) - 1800 // 30 min ago
  },
  {
    value: '2000000000000000000000', // 2,000 WMON
    from: '0x1234567890123456789012345678901234567890',
    to: '0x9876543210987654321098765432109876543210',
    blockTimestamp: Math.floor(Date.now() / 1000) - 3600 // 1h ago
  },
  {
    value: '15000000000000000000000', // 15,000 WMON (whale!)
    from: '0xabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd',
    to: '0x1111111111111111111111111111111111111111',
    blockTimestamp: Math.floor(Date.now() / 1000) - 600 // 10 min ago
  }
];

class MockEnvioAdapter {
  calculateTransferMomentum(recent, historical) {
    const recentCount = recent.length;
    const historicalAvg = historical.length / 24;
    
    const shortMomentum = recentCount > 0 ? 
      ((recentCount - historicalAvg) / Math.max(historicalAvg, 1)) * 100 : 0;
    
    const recentVolume = recent.reduce((sum, t) => sum + Number(t.value), 0);
    const historicalVolume = historical.reduce((sum, t) => sum + Number(t.value), 0);
    const hourlyVolAvg = historicalVolume / 24;
    
    const longMomentum = hourlyVolAvg > 0 ? 
      ((recentVolume - hourlyVolAvg) / hourlyVolAvg) * 100 : 0;

    return {
      short: Math.max(-100, Math.min(100, shortMomentum)),
      long: Math.max(-100, Math.min(100, longMomentum))
    };
  }

  detectWhaleActivity(transfers) {
    const whaleThreshold = BigInt('10000000000000000000000'); // 10,000 MON
    
    const whaleTransfers = transfers.filter(t => 
      BigInt(t.value) >= whaleThreshold
    );
    
    const totalVolume = transfers.reduce((sum, t) => sum + Number(t.value), 0);
    const whaleVolume = whaleTransfers.reduce((sum, t) => sum + Number(t.value), 0);
    const whalePercentage = totalVolume > 0 ? (whaleVolume / totalVolume) * 100 : 0;
    
    return {
      count: whaleTransfers.length,
      score: Math.min(100, whalePercentage),
      threshold: Number(whaleThreshold)
    };
  }

  calculateNetworkHealth(transfers) {
    const uniqueAddresses = new Set();
    transfers.forEach(t => {
      uniqueAddresses.add(t.from);
      uniqueAddresses.add(t.to);
    });
    
    const frequency = transfers.length;
    const diversity = uniqueAddresses.size;
    const healthScore = Math.min(100, (frequency * 10) + (diversity * 5));
    
    return {
      score: healthScore,
      frequency,
      diversity
    };
  }

  calculateRiskScore(whaleActivity, networkHealth) {
    const whaleRisk = whaleActivity.score;
    const networkRisk = 100 - networkHealth.score;
    
    return Math.min(100, (whaleRisk * 0.6) + (networkRisk * 0.4));
  }

  calculateTimingScore(momentum, volume) {
    const momentumScore = 50 + (momentum.short * 0.3) + (momentum.long * 0.2);
    const volumeScore = Math.min(100, Math.abs(volume.momentum) * 2);
    
    return Math.max(0, Math.min(100, (momentumScore + volumeScore) / 2));
  }
}

// Test avec données simulées
console.log('🧪 Test avec données simulées WMON transfers...\n');

const adapter = new MockEnvioAdapter();

// Simule 1h récent vs 24h historique
const recent1h = mockTransfers.slice(0, 2); // 2 récents
const historical24h = [...mockTransfers, ...mockTransfers, ...mockTransfers]; // 9 au total

const momentum = adapter.calculateTransferMomentum(recent1h, historical24h);
const whaleActivity = adapter.detectWhaleActivity(recent1h);
const networkHealth = adapter.calculateNetworkHealth(recent1h);
const riskScore = adapter.calculateRiskScore(whaleActivity, networkHealth);

const volumeMetrics = {
  volume1h: recent1h.reduce((sum, t) => sum + Number(t.value), 0),
  volume24h: historical24h.reduce((sum, t) => sum + Number(t.value), 0),
  momentum: 25 // Simulé
};

const timingScore = adapter.calculateTimingScore(momentum, volumeMetrics);

console.log('📊 Résultats de l\'analyse:');
console.log(`  • Momentum court: ${momentum.short.toFixed(2)}%`);
console.log(`  • Momentum long: ${momentum.long.toFixed(2)}%`);
console.log(`  • Whale activity: ${whaleActivity.count} transfers (${whaleActivity.score.toFixed(2)}%)`);
console.log(`  • Network health: ${networkHealth.score.toFixed(2)} (${networkHealth.diversity} addresses)`);
console.log(`  • Volume 1h: ${(volumeMetrics.volume1h / 1e18).toFixed(2)} WMON`);
console.log(`  • Risk score: ${riskScore.toFixed(2)}`);
console.log(`  • Timing score: ${timingScore.toFixed(2)}`);

console.log('\n🎯 Décision IA:');
if (timingScore > 70) {
  console.log('  ✅ EXECUTE DCA - Conditions favorables');
} else if (riskScore > 70) {
  console.log('  ⚠️  PAUSE DCA - Risque élevé détecté');
} else {
  console.log('  ⏳ WAIT - Conditions neutres');
}

console.log('\n🔍 Détails whale detection:');
console.log(`  • Threshold: ${whaleActivity.threshold / 1e18} WMON`);
console.log(`  • Whale transfers détectés: ${whaleActivity.count}`);
console.log(`  • % du volume total: ${whaleActivity.score.toFixed(2)}%`);