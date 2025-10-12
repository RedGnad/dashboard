/**
 * Debug what token addresses exist in the historical data
 */

import { request, gql } from 'graphql-request';

async function debugTokenAddresses() {
  console.log('🔍 Debugging Token Addresses in Historical Data...\n');

  const endpoint = 'https://indexer.dev.hyperindex.xyz/e8e559a/v1/graphql';
  
  // Query for distinct token addresses in the last 90 days
  const query = gql`
    query GetDistinctTokens {
      TokenTransfer(
        distinct_on: [tokenAddress]
        order_by: {tokenAddress: asc}
        limit: 50
      ) {
        tokenAddress
        blockTimestamp
      }
    }
  `;

  try {
    const data = await request(endpoint, query);
    console.log('📊 Found Token Addresses:');
    data.TokenTransfer.forEach((transfer, i) => {
      const timestamp = new Date(transfer.blockTimestamp * 1000);
      console.log(`  ${i + 1}. ${transfer.tokenAddress} (last seen: ${timestamp.toISOString()})`);
    });

    // Compare with our expected addresses
    console.log('\n🎯 Expected MON Token Addresses:');
    console.log('  • WMON: 0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701');
    console.log('  • USDC: 0xf817257fed379853cDe0fa4F97AB987181B1E5Ea');

    // Check for case sensitivity issues
    console.log('\n🔍 Case Sensitivity Check:');
    const foundAddresses = data.TokenTransfer.map(t => t.tokenAddress);
    const expectedWMON = '0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701';
    const expectedUSDC = '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea';
    
    const wmonMatch = foundAddresses.find(addr => 
      addr.toLowerCase() === expectedWMON.toLowerCase()
    );
    const usdcMatch = foundAddresses.find(addr => 
      addr.toLowerCase() === expectedUSDC.toLowerCase()
    );

    console.log(`  • WMON Match: ${wmonMatch || 'NOT FOUND'}`);
    console.log(`  • USDC Match: ${usdcMatch || 'NOT FOUND'}`);

    // If we have matches, test a query with the correct address
    if (wmonMatch) {
      console.log('\n🧪 Testing query with found WMON address...');
      const testQuery = gql`
        query TestWMONTransfers($tokenAddress: String!) {
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

      const testData = await request(endpoint, testQuery, { tokenAddress: wmonMatch });
      console.log(`  Found ${testData.TokenTransfer.length} WMON transfers:`);
      testData.TokenTransfer.forEach((transfer, i) => {
        const timestamp = new Date(transfer.blockTimestamp * 1000);
        console.log(`    ${i + 1}. ${transfer.value} WMON at ${timestamp.toISOString()}`);
      });
    }

  } catch (error) {
    console.error('❌ Debug failed:', error);
    if (error.response) {
      console.error('GraphQL Response:', error.response);
    }
  }
}

// Run the debug
debugTokenAddresses()
  .then(() => {
    console.log('\n✅ Token address debugging completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Debug execution failed:', error);
    process.exit(1);
  });