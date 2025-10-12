#!/usr/bin/env node

/**
 * Test script to validate MON + WMON aggregation in AI features
 * This tests that we treat MON and WMON as the same economic value
 */

import { EnvioDataAdapter } from './src/adapters/envio-data-adapter.js';

async function testMonWmonAggregation() {
  console.log('🧪 Testing MON + WMON Token Aggregation...\n');

  const adapter = new EnvioDataAdapter({
    endpoint: 'https://indexer.dev.hyperindex.xyz/e8e559a/v1/graphql',
    refreshIntervalMs: 30000,
  });

  try {
    console.log('📊 Fetching aggregated MON/WMON transfers...');
    const transfers1h = await adapter.getAggregatedMonTransfers(1);
    const transfers24h = await adapter.getAggregatedMonTransfers(24);

    console.log(`\n📈 Transfer Statistics:`);
    console.log(`  • Last 1 hour: ${transfers1h.length} transfers`);
    console.log(`  • Last 24 hours: ${transfers24h.length} transfers`);

    if (transfers24h.length > 0) {
      // Group by token address to show aggregation
      const byToken = transfers24h.reduce((acc, transfer) => {
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

      console.log(`\n🤖 Generating AI Features with Aggregation...`);
      const aiFeatures = await adapter.generateAIFeatures();
      
      console.log('\n📊 AI Feature Results:');
      console.log(`  • Momentum Short: ${(aiFeatures.features.momentum_short_15m * 100).toFixed(1)}%`);
      console.log(`  • Momentum Long: ${(aiFeatures.features.momentum_long_1h * 100).toFixed(1)}%`);
      console.log(`  • Whale Activity: ${aiFeatures.features.whale_activity_score}`);
      console.log(`  • Network Health: ${(aiFeatures.features.network_activity_score * 100).toFixed(1)}%`);
      console.log(`  • Volume 1h: ${aiFeatures.features.volume_1h.toFixed(4)}`);
      console.log(`  • Volume 24h: ${aiFeatures.features.volume_24h.toFixed(4)}`);
      console.log(`  • Risk Score: ${(aiFeatures.features.risk_score * 100).toFixed(1)}%`);
      console.log(`  • Timing Score: ${(aiFeatures.features.timing_score * 100).toFixed(1)}%`);

      // DCA Decision Logic (simplified)
      const shouldExecute = aiFeatures.features.timing_score > 0.7;
      console.log(`\n🎯 DCA Decision: ${shouldExecute ? '✅ EXECUTE DCA' : '❌ WAIT'}`);
      
      console.log(`\n📋 Metadata:`);
      console.log(`  • Source: ${aiFeatures.metadata.source}`);
      console.log(`  • Data Points 1h: ${aiFeatures.metadata.data_points.transfers_1h}`);
      console.log(`  • Data Points 24h: ${aiFeatures.metadata.data_points.transfers_24h}`);
      console.log(`  • Timestamp: ${new Date(aiFeatures.metadata.timestamp).toISOString()}`);

    } else {
      console.log('\n⚠️  No transfers found - may be using historical data or indexer not synced');
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
    if (error.response) {
      console.error('GraphQL Response:', error.response);
    }
  }
}

// Run the test
testMonWmonAggregation()
  .then(() => {
    console.log('\n✅ MON/WMON aggregation test completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Test execution failed:', error);
    process.exit(1);
  });