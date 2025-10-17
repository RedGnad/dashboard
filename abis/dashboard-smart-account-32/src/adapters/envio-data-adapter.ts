/**
 * Envio Data Adapter for AI Features
 * 
 * Connects to the Envio GraphQL endpoint to fetch real-time token/swap metrics
 * for AI decision-making features (momentum, volatility, etc.)
 */

import { request, gql } from 'graphql-request';

// Token addresses for Monad ecosystem (lowercase for database matching)
const MONAD_TOKENS = {
  USDC: '0xf817257fed379853cde0fa4f97ab987181b1e5ea',
  WMON: '0x760afe86e5de5fa0ee542fc7b7b713e1c5425701',
  CHOG: '0xe0590015a873bf326bd645c3e1266d4db41c4e6b',
  YAKI: '0xfe140e1dce99be9f4f15d657cd9b7bf622270c50',
  DAK: '0x0f0bdebf0f83cd1ee3974779bcb7315f9808c714',
  BEAN: '0x268e4e24e0051ec27b3d27a95977e71ce6875a05',
  WBTC: '0xcf5a6076cfa32686c0df13abada2b40dec133f1d',
  DAKIMAKURA: '0x0569049e527bb151605eec7bf48cfd55bd2bf4c8',
  NATIVE_MON: '0x0000000000000000000000000000000000000000', // Native MON uses zero address
};

// List of all tracked token symbols for AI queries
const TRACKED_TOKEN_SYMBOLS = [
  'USDC', 'WMON', 'CHOG', 'YAKI', 'DAK', 'BEAN', 'WBTC', 'DAKIMAKURA'
];

// For MON/WMON aggregation we track both WMON ERC20 and native MON transfers
const MON_ADDRESSES = [
  MONAD_TOKENS.WMON,     // WMON ERC20 transfers
  MONAD_TOKENS.NATIVE_MON // Native MON transfers
];

const USDC_ADDRESS = MONAD_TOKENS.USDC;

// Configuration interface for Envio data adapter
interface EnvioConfig {
  endpoint: string;
  cacheTime?: number;
  refreshIntervalMs: number;
}

interface TokenMetrics {
  tokenAddress: string;
  tokenSymbol: string;
  totalVolume: string;
  transferCount: number;
  hourlyVolume: string;
  dailyVolume: string;
  volatilityScore: number;
  momentumScore: number;
  lastTransferTime: number;
}

interface PairMetrics {
  pairKey: string;
  currentPrice: number;
  priceChange24h: number;
  volatility24h: number;
  volume24h: string;
  swapCount24h: number;
  momentumShort: number;
  momentumLong: number;
  lastUpdateTime: number;
}

class EnvioDataAdapter {
  private config: EnvioConfig;
  private cache: Map<string, any> = new Map();
  private lastFetch: number = 0;

  constructor(config: EnvioConfig) {
    this.config = config;
  }

  /**
   * Get metrics for a single token (for per-token AI decisions)
   */
  async getTokenMetric(tokenSymbol: string): Promise<TokenMetrics | null> {
    const metrics = await this.getTokenMetrics([tokenSymbol]);
    return metrics.length > 0 ? metrics[0] : null;
  }

  /**
   * Get token metrics for ALL tracked tokens for AI features
   */
  async getTokenMetrics(tokenSymbols?: string[]): Promise<TokenMetrics[]> {
    const symbols = tokenSymbols || TRACKED_TOKEN_SYMBOLS;
    const cacheKey = `token_metrics_${symbols.join('_')}`;
    
    if (this.shouldRefresh(cacheKey)) {
      const query = gql`
        query GetTokenMetrics($symbols: [String!]!) {
          tokenMetrics(
            where: { 
              tokenSymbol_in: $symbols
            }
            orderBy: lastTransferTime
            orderDirection: desc
          ) {
            id
            tokenAddress
            tokenSymbol
            totalVolume
            transferCount
            hourlyVolume
            dailyVolume
            volatilityScore
            momentumScore
            lastTransferTime
          }
        }
      `;

      try {
        const data = await request(this.config.endpoint, query, { symbols }) as { tokenMetrics: TokenMetrics[] };
        this.cache.set(cacheKey, data.tokenMetrics);
        this.lastFetch = Date.now();
        
        console.log(`[Envio] Fetched ${data.tokenMetrics.length} token metrics`);
        return data.tokenMetrics;
      } catch (error) {
        console.error('[Envio] Failed to fetch token metrics:', error);
        return this.cache.get(cacheKey) || [];
      }
    }

    return this.cache.get(cacheKey) || [];
  }

  /**
   * Get trading pair metrics for momentum calculation
   */
  async getPairMetrics(): Promise<PairMetrics[]> {
    const cacheKey = 'pair_metrics';
    
    if (this.shouldRefresh(cacheKey)) {
      const query = gql`
        query GetPairMetrics {
          pairMetrics(
            orderBy: lastUpdateTime
            orderDirection: desc
            first: 10
          ) {
            id
            pairKey
            currentPrice
            priceChange24h
            volatility24h
            volume24h
            swapCount24h
            momentumShort
            momentumLong
            lastUpdateTime
          }
        }
      `;

      try {
        const data = await request(this.config.endpoint, query) as { pairMetrics: PairMetrics[] };
        this.cache.set(cacheKey, data.pairMetrics);
        this.lastFetch = Date.now();
        
        console.log(`[Envio] Fetched ${data.pairMetrics.length} pair metrics`);
        return data.pairMetrics;
      } catch (error) {
        console.error('[Envio] Failed to fetch pair metrics:', error);
        return this.cache.get(cacheKey) || [];
      }
    }

    return this.cache.get(cacheKey) || [];
  }

  /**
   * Get recent token transfers for volume analysis
   * Now supports querying specific tokens or all tracked tokens
   */
  async getRecentTransfers(tokenSymbol?: string, hours: number = 1): Promise<any[]> {
    const timestampThreshold = Math.floor(Date.now() / 1000) - (hours * 3600);
    
    const whereClause = tokenSymbol 
      ? `blockTimestamp: {_gte: $timestampThreshold}, tokenSymbol: {_eq: $tokenSymbol}`
      : `blockTimestamp: {_gte: $timestampThreshold}`;
    
    const query = gql`
      query GetRecentTransfers($timestampThreshold: Int!${tokenSymbol ? ', $tokenSymbol: String!' : ''}) {
        tokenTransfers(
          where: { 
            blockTimestamp_gte: $timestampThreshold
            ${tokenSymbol ? 'tokenSymbol: $tokenSymbol' : ''}
          }
          orderBy: blockTimestamp
          orderDirection: desc
          first: 100
        ) {
          id
          tokenAddress
          from
          to
          value
          blockNumber
          blockTimestamp
          transactionHash
        }
      }
    `;

    try {
      const variables: any = { timestampThreshold };
      if (tokenSymbol) variables.tokenSymbol = tokenSymbol;
      
      const data = await request(this.config.endpoint, query, variables) as { tokenTransfers: any[] };
      return data.tokenTransfers || [];
    } catch (error) {
      console.error('[Envio] Failed to fetch recent transfers:', error);
      return [];
    }
  }

  /**
   * Get aggregated MON + WMON transfers (native + ERC20)
   * Combines native MON transfers and WMON ERC20 transfers as unified economic activity
   */
  async getAggregatedMonTransfers(hours: number = 1): Promise<any[]> {
    const timestampThreshold = Math.floor(Date.now() / 1000) - (hours * 3600);
    
    const query = gql`
      query GetAggregatedMonTransfers($timestampThreshold: Int!, $monAddresses: [String!]!) {
        TokenTransfer(
          where: { 
            blockTimestamp: {_gte: $timestampThreshold}
            tokenAddress: {_in: $monAddresses}
          }
          order_by: {blockTimestamp: desc}
          limit: 500
        ) {
          id
          tokenAddress
          from
          to
          value
          blockNumber
          blockTimestamp
          transactionHash
        }
      }
    `;

    try {
      const data = await request(this.config.endpoint, query, { 
        timestampThreshold,
        monAddresses: MON_ADDRESSES 
      }) as { TokenTransfer: any[] };
      
      console.log(`[Envio] Fetched ${data.TokenTransfer.length} aggregated MON/WMON transfers (${hours}h)`);
      return data.TokenTransfer;
    } catch (error) {
      console.error('[Envio] Failed to fetch aggregated MON transfers:', error);
      return [];
    }
  }

    /**
   * Transform Envio metrics into AI feature format
   * SIMPLIFIED: Removed MON native transfer tracking as not supported by Envio
   * Focus on WMON ERC20 data which works reliably
   */
  async generateAIFeatures(): Promise<any> {
    // Skip MON transfer calls that fail - use default values instead
    const recentTransfers: any[] = [];
    const allTransfers: any[] = [];

    // Calculate transfer-based metrics for AI decisions (with empty data)
    const momentum = this.calculateTransferMomentum(recentTransfers, allTransfers);
    const whaleActivity = this.detectWhaleActivity(recentTransfers);
    const networkHealth = this.calculateNetworkHealth(recentTransfers);
    const volumeMetrics = this.calculateVolumeMetrics(allTransfers);

    return {
      features: {
        // Momentum based on transfer frequency
        momentum_short_15m: momentum.short,
        momentum_long_1h: momentum.long,
        
        // Whale activity detection
        whale_activity_score: whaleActivity.score,
        whale_transfer_count: whaleActivity.count,
        
        // Network health indicators
        network_activity_score: networkHealth.score,
        transfer_frequency: networkHealth.frequency,
        
        // Volume-based features
        volume_1h: volumeMetrics.volume1h,
        volume_24h: volumeMetrics.volume24h,
        volume_momentum: volumeMetrics.momentum,
        
        // Risk indicators
        risk_score: this.calculateRiskScore(whaleActivity, networkHealth),
        
        // Market timing indicators
        timing_score: this.calculateTimingScore(momentum, volumeMetrics),
      },
      metadata: {
        source: 'envio-mon-wmon-aggregated',
        timestamp: Date.now(),
        data_points: {
          transfers_1h: recentTransfers.length,
          transfers_24h: allTransfers.length,
        },
        aggregation: {
          native_mon: allTransfers.filter(t => t.tokenAddress === MONAD_TOKENS.NATIVE_MON).length,
          wmon_erc20: allTransfers.filter(t => t.tokenAddress === MONAD_TOKENS.WMON).length,
        },
        note: 'Aggregates native MON + WMON ERC20 transfers as unified economic activity'
      }
    };
  }

  /**
   * Calculate momentum based on transfer frequency and volume
   */
  private calculateTransferMomentum(recent: any[], historical: any[]) {
    const recentCount = recent.length;
    const historicalAvg = historical.length / 24; // Average per hour
    
    const shortMomentum = recentCount > 0 ? 
      ((recentCount - historicalAvg) / Math.max(historicalAvg, 1)) * 100 : 0;
    
    // Long momentum based on volume trend
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

  /**
   * Detect whale activity from large transfers
   * Uses isWhaleMovement flag from Envio indexer
   */
  private detectWhaleActivity(transfers: any[]) {
    // Count transfers marked as whale movements by indexer
    const whaleTransfers = transfers.filter(t => t.isWhaleMovement === true);
    
    const totalVolume = transfers.reduce((sum, t) => sum + Number(t.value), 0);
    const whaleVolume = whaleTransfers.reduce((sum, t) => sum + Number(t.value), 0);
    const whalePercentage = totalVolume > 0 ? (whaleVolume / totalVolume) * 100 : 0;
    
    // Also count DEX swaps for market activity
    const dexSwaps = transfers.filter(t => t.isDexSwap === true);
    
    return {
      count: whaleTransfers.length,
      score: Math.min(100, whalePercentage),
      dexActivity: dexSwaps.length,
      details: {
        whaleTransfers: whaleTransfers.length,
        totalTransfers: transfers.length,
        whaleVolumePercent: whalePercentage.toFixed(2)
      }
    };
  }

  /**
   * Calculate network health from transfer patterns
   */
  private calculateNetworkHealth(transfers: any[]) {
    const uniqueAddresses = new Set();
    transfers.forEach(t => {
      uniqueAddresses.add(t.from);
      uniqueAddresses.add(t.to);
    });
    
    const frequency = transfers.length; // transfers per hour
    const diversity = uniqueAddresses.size;
    const avgTransferSize = transfers.length > 0 ? 
      transfers.reduce((sum, t) => sum + Number(t.value), 0) / transfers.length : 0;
    
    // Health score based on frequency and diversity
    const healthScore = Math.min(100, (frequency * 10) + (diversity * 5));
    
    return {
      score: healthScore,
      frequency,
      diversity,
      avgTransferSize
    };
  }

  /**
   * Calculate volume-based metrics
   */
  private calculateVolumeMetrics(transfers24h: any[]) {
    const now = Date.now() / 1000;
    const oneHourAgo = now - 3600;
    
    const transfers1h = transfers24h.filter(t => t.blockTimestamp >= oneHourAgo);
    
    const volume1h = transfers1h.reduce((sum, t) => sum + Number(t.value), 0);
    const volume24h = transfers24h.reduce((sum, t) => sum + Number(t.value), 0);
    
    const hourlyAvg = volume24h / 24;
    const volumeMomentum = hourlyAvg > 0 ? ((volume1h - hourlyAvg) / hourlyAvg) * 100 : 0;
    
    return {
      volume1h,
      volume24h,
      momentum: Math.max(-100, Math.min(100, volumeMomentum))
    };
  }

  /**
   * Calculate overall risk score
   */
  private calculateRiskScore(whaleActivity: any, networkHealth: any): number {
    // High whale activity = higher risk
    // Low network health = higher risk
    const whaleRisk = whaleActivity.score; // 0-100
    const networkRisk = 100 - networkHealth.score; // Invert health to risk
    
    return Math.min(100, (whaleRisk * 0.6) + (networkRisk * 0.4));
  }

  /**
   * Calculate timing score for DCA decisions
   */
  private calculateTimingScore(momentum: any, volume: any): number {
    // Good timing = moderate momentum + healthy volume
    const momentumScore = 50 + (momentum.short * 0.3) + (momentum.long * 0.2);
    const volumeScore = Math.min(100, Math.abs(volume.momentum) * 2);
    
    return Math.max(0, Math.min(100, (momentumScore + volumeScore) / 2));
  }

  private calculateVolumeDeviation(tokenMetrics: TokenMetrics[]): number {
    if (tokenMetrics.length === 0) return 0;
    
    const volumes = tokenMetrics.map(m => Number(m.dailyVolume));
    const avgVolume = volumes.reduce((sum, v) => sum + v, 0) / volumes.length;
    const maxVolume = Math.max(...volumes);
    
    return avgVolume > 0 ? (maxVolume / avgVolume - 1) * 100 : 0;
  }

  private calculateTransferActivity(tokenMetrics: TokenMetrics[]): number {
    const totalTransfers = tokenMetrics.reduce((sum, m) => sum + m.transferCount, 0);
    const totalHours = 24; // Last 24h
    
    return totalTransfers / totalHours; // Transfers per hour
  }

  private shouldRefresh(cacheKey: string): boolean {
    return Date.now() - this.lastFetch > this.config.refreshIntervalMs;
  }
}

// Export singleton instance
export const envioAdapter = new EnvioDataAdapter({
  endpoint: process.env.ENVIO_GRAPHQL_ENDPOINT || 'http://localhost:8080/v1/graphql',
  refreshIntervalMs: 30000, // 30 seconds
});

export { EnvioDataAdapter, TokenMetrics, PairMetrics };