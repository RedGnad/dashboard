import { request, gql } from 'graphql-request';

async function checkEnvioData() {
  const endpoint = 'https://indexer.dev.hyperindex.xyz/e8e559a/v1/graphql';
  
  console.log('🔍 Vérification des données Envio disponibles...\n');
  
  try {
    // Test 1: Check basic connectivity and last transfers
    const query1 = gql`
      query GetLastTransfers {
        TokenTransfer(
          order_by: {blockTimestamp: desc}
          limit: 5
        ) {
          id
          tokenAddress
          from
          to
          value
          blockTimestamp
          blockNumber
        }
      }
    `;
    
    console.log('📊 Test 1: Derniers transfers (any time)...');
    const data1 = await request(endpoint, query1);
    console.log(`✅ Trouvé ${data1.TokenTransfer.length} transfers`);
    
    if (data1.TokenTransfer.length > 0) {
      const latest = data1.TokenTransfer[0];
      const latestDate = new Date(latest.blockTimestamp * 1000);
      console.log(`📅 Dernier transfer: ${latestDate.toISOString()}`);
      console.log(`🪙 Token: ${latest.tokenAddress}`);
      console.log(`💰 Amount: ${(Number(latest.value) / 1e18).toFixed(4)} tokens`);
      console.log(`🏠 From: ${latest.from.slice(0,10)}...`);
      console.log(`🏠 To: ${latest.to.slice(0,10)}...`);
      
      // Test 2: Check by token address
      console.log('\n📊 Test 2: Transfers WMON uniquement...');
      const query2 = gql`
        query GetWMONTransfers {
          TokenTransfer(
            where: {
              tokenAddress: {_eq: "0x760afe86e5de5fa0ee542fc7b7b713e1c5425701"}
            }
            order_by: {blockTimestamp: desc}
            limit: 10
          ) {
            id
            value
            blockTimestamp
            from
            to
          }
        }
      `;
      
      const data2 = await request(endpoint, query2);
      console.log(`✅ Trouvé ${data2.TokenTransfer.length} transfers WMON`);
      
      if (data2.TokenTransfer.length > 0) {
        console.log('🎯 Derniers transfers WMON:');
        data2.TokenTransfer.forEach((t, i) => {
          const date = new Date(t.blockTimestamp * 1000);
          const amount = (Number(t.value) / 1e18).toFixed(2);
          console.log(`   ${i+1}. ${amount} WMON - ${date.toISOString()}`);
        });
        
        // Test 3: Check recent (last 7 days)
        const weekAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 3600);
        console.log(`\n📊 Test 3: Transfers derniers 7 jours (depuis ${new Date(weekAgo * 1000).toISOString()})...`);
        
        const query3 = gql`
          query GetRecentWMON($timestamp: Int!) {
            TokenTransfer(
              where: {
                tokenAddress: {_eq: "0x760afe86e5de5fa0ee542fc7b7b713e1c5425701"}
                blockTimestamp: {_gte: $timestamp}
              }
              order_by: {blockTimestamp: desc}
            ) {
              id
              value
              blockTimestamp
            }
          }
        `;
        
        const data3 = await request(endpoint, query3, { timestamp: weekAgo });
        console.log(`✅ Trouvé ${data3.TokenTransfer.length} transfers WMON derniers 7 jours`);
        
        if (data3.TokenTransfer.length > 0) {
          const totalVolume = data3.TokenTransfer.reduce((sum, t) => sum + Number(t.value), 0);
          console.log(`💰 Volume total 7j: ${(totalVolume / 1e18).toFixed(2)} WMON`);
          
          // Check for whale transfers
          const whaleThreshold = BigInt('10000000000000000000000'); // 10K WMON
          const whales = data3.TokenTransfer.filter(t => BigInt(t.value) >= whaleThreshold);
          console.log(`🐋 Whale transfers (>10K): ${whales.length}`);
        }
      }
    }
    
  } catch (error) {
    console.error('❌ Erreur:', error.message);
  }
}

checkEnvioData();