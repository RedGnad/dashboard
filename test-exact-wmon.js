/**
 * Test WMON transfers with exact address from debug
 */

import { request, gql } from 'graphql-request';

async function testExactWMONAddress() {
  console.log('🔍 Testing WMON with exact address from debug...\n');

  const endpoint = 'https://indexer.dev.hyperindex.xyz/e8e559a/v1/graphql';
  
  // Use the exact address found in our previous debug
  const exactWMONAddress = '0x760afe86e5de5fa0ee542fc7b7b713e1c5425701';
  
  const query = gql`
    query TestExactWMON($tokenAddress: String!) {
      TokenTransfer(
        where: { tokenAddress: {_eq: $tokenAddress} }
        order_by: {blockTimestamp: desc}
        limit: 10
      ) {
        id
        tokenAddress
        value
        blockTimestamp
        from
        to
      }
    }
  `;

  try {
    const data = await request(endpoint, query, { tokenAddress: exactWMONAddress });
    console.log(`Found ${data.TokenTransfer.length} WMON transfers:`);
    data.TokenTransfer.forEach((transfer, i) => {
      const timestamp = new Date(transfer.blockTimestamp * 1000);
      const value = parseFloat(transfer.value) / (10 ** 18); // Convert to readable units
      console.log(`  ${i + 1}. ${value.toFixed(4)} WMON at ${timestamp.toISOString()}`);
    });

    if (data.TokenTransfer.length > 0) {
      // Test our adapter with the exact address
      console.log('\n🧪 Testing EnvioDataAdapter with exact address...');
      const { EnvioDataAdapter } = await import('./src/adapters/envio-data-adapter.js');
      
      const adapter = new EnvioDataAdapter({
        endpoint: 'https://indexer.dev.hyperindex.xyz/e8e559a/v1/graphql',
        refreshIntervalMs: 30000,
      });

      const transfers90d = await adapter.getAggregatedMonTransfers(24 * 90);
      console.log(`Adapter found: ${transfers90d.length} transfers`);

      if (transfers90d.length > 0) {
        console.log('\n🤖 Generating AI Features...');
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

        const shouldExecute = aiFeatures.features.timing_score > 0.7;
        console.log(`\n🎯 DCA Decision: ${shouldExecute ? '✅ EXECUTE DCA' : '❌ WAIT'}`);
        
        console.log(`\n📋 Source: ${aiFeatures.metadata.source}`);
        console.log(`📝 Note: ${aiFeatures.metadata.note}`);
      }
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run the test
testExactWMONAddress()
  .then(() => {
    console.log('\n✅ Exact WMON address test completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Test execution failed:', error);
    process.exit(1);
  });