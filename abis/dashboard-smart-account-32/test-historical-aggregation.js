/**
 * Test with wider time range to find historical MON/WMON data
 */

import { EnvioDataAdapter } from './src/adapters/envio-data-adapter.js';

async function testHistoricalData() {
  console.log('🧪 Testing MON + WMON with Historical Data...\n');

  const adapter = new EnvioDataAdapter({
    endpoint: 'https://indexer.dev.hyperindex.xyz/e8e559a/v1/graphql',
    refreshIntervalMs: 30000,
  });

  try {
    // Test with much larger time windows to find March 2025 data
    console.log('📊 Fetching with extended time ranges...');
    const transfers30d = await adapter.getAggregatedMonTransfers(24 * 30); // 30 days
    const transfers90d = await adapter.getAggregatedMonTransfers(24 * 90); // 90 days

    console.log(`\n📈 Transfer Statistics:`);
    console.log(`  • Last 30 days: ${transfers30d.length} transfers`);
    console.log(`  • Last 90 days: ${transfers90d.length} transfers`);

    if (transfers90d.length > 0) {
      // Analyze the historical data
      const firstTransfer = transfers90d[transfers90d.length - 1];
      const lastTransfer = transfers90d[0];

      console.log(`\n📅 Data Range:`);
      console.log(`  • First: ${new Date(firstTransfer.blockTimestamp * 1000).toISOString()}`);
      console.log(`  • Last: ${new Date(lastTransfer.blockTimestamp * 1000).toISOString()}`);

      // Group by token address to show aggregation
      const byToken = transfers90d.reduce((acc, transfer) => {
        const token = transfer.tokenAddress.toLowerCase();
        if (!acc[token]) acc[token] = [];
        acc[token].push(transfer);
        return acc;
      }, {});

      console.log(`\n🔄 Token Distribution:`);
      Object.entries(byToken).forEach(([address, transfers]) => {
        const volume = transfers.reduce((sum, t) => sum + parseFloat(t.value), 0);
        const isWMON = address.includes('760afe86');
        console.log(`  • ${isWMON ? 'WMON' : 'Unknown'} (${address}): ${transfers.length} transfers, ${volume.toFixed(4)} volume`);
      });

      // Test AI features with historical data
      console.log(`\n🤖 Testing AI Features with Historical Data...`);
      
      // Override the method temporarily to use our historical data
      const originalMethod = adapter.getAggregatedMonTransfers;
      adapter.getAggregatedMonTransfers = async (hours) => {
        // For testing, return last 100 transfers as "recent" and all as "historical"
        return hours === 1 ? transfers90d.slice(0, 100) : transfers90d;
      };

      const aiFeatures = await adapter.generateAIFeatures();
      
      // Restore original method
      adapter.getAggregatedMonTransfers = originalMethod;

      console.log('\n📊 AI Feature Results:');
      console.log(`  • Momentum Short: ${(aiFeatures.features.momentum_short_15m * 100).toFixed(1)}%`);
      console.log(`  • Momentum Long: ${(aiFeatures.features.momentum_long_1h * 100).toFixed(1)}%`);
      console.log(`  • Whale Activity: ${aiFeatures.features.whale_activity_score}`);
      console.log(`  • Network Health: ${(aiFeatures.features.network_activity_score * 100).toFixed(1)}%`);
      console.log(`  • Volume 1h: ${aiFeatures.features.volume_1h.toFixed(4)}`);
      console.log(`  • Volume 24h: ${aiFeatures.features.volume_24h.toFixed(4)}`);
      console.log(`  • Risk Score: ${(aiFeatures.features.risk_score * 100).toFixed(1)}%`);
      console.log(`  • Timing Score: ${(aiFeatures.features.timing_score * 100).toFixed(1)}%`);

      // DCA Decision Logic
      const shouldExecute = aiFeatures.features.timing_score > 0.7;
      console.log(`\n🎯 DCA Decision: ${shouldExecute ? '✅ EXECUTE DCA' : '❌ WAIT'}`);
      
      console.log(`\n📋 Metadata:`);
      console.log(`  • Source: ${aiFeatures.metadata.source}`);
      console.log(`  • Data Points 1h: ${aiFeatures.metadata.data_points.transfers_1h}`);
      console.log(`  • Data Points 24h: ${aiFeatures.metadata.data_points.transfers_24h}`);

    } else {
      console.log('\n⚠️  No historical transfers found in 90-day window');
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
    if (error.response) {
      console.error('GraphQL Response:', error.response);
    }
  }
}

// Run the test
testHistoricalData()
  .then(() => {
    console.log('\n✅ Historical MON/WMON aggregation test completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Test execution failed:', error);
    process.exit(1);
  });