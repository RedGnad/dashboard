import { useMemo, useState } from 'react'
import { parseUnits } from 'viem'
import { useDcaDelegation } from '../hooks/useDcaDelegation'
import { USDC, CHOG, getTargetTokens, getToken, getAllTradableTokens, TOKENS } from '../lib/tokens'
import { Play, Square, Zap, ArrowUpDown, RefreshCw, Copy, Settings, BarChart2, Cpu, SlidersHorizontal, Brain, Shield } from 'lucide-react'
import { useEnvioMetrics } from '../hooks/useEnvioMetrics'
import ProtocolMetricsChart from '../components/ProtocolMetricsChart'
import ProtocolBarChart from '../components/ProtocolBarChart'
import { useTodayProtocolMetrics } from '../hooks/useTodayProtocolMetrics'
import { useProtocolDailyMetrics, type ProtocolMetricKey } from '../hooks/useProtocolDailyMetrics'
import { useAutonomousAi } from '../hooks/useAutonomousAi'
import { useTokenMetrics } from '../hooks/useTokenMetrics'
import AiVerificationPanel from './AiVerificationPanel'

type TabKey = 'trade' | 'ai' | 'metrics' | 'verification' | 'settings'

export default function DcaControl() {
  const [active, setActive] = useState<TabKey>('trade')
  const [monDcaAmount, setMonDcaAmount] = useState('0.05')
  const [slippageBps, setSlippageBps] = useState('300')
  const [interval, setInterval] = useState('60')
  const [monAmount, setMonAmount] = useState('0.1')
  const [withdrawMonAmount, setWithdrawMonAmount] = useState('0.05')
  const [outToken, setOutToken] = useState<string>('USDC')
  const [metricKey, setMetricKey] = useState<ProtocolMetricKey>('txDaily')
  const [todayMetric, setTodayMetric] = useState<'usersDaily' | 'txDaily'>('txDaily')

  const {
    isInitialized,
    isLoading,
    dcaStatus,
    balances,
    delegatorSmartAccount,
    delegateSmartAccount,
    delegationExpired,
    delegationExpiresAt,
    startNativeDca,
    stopDca,
    runNativeNow,
    unwrapAll,
    refreshBalances,
    renewDelegation,
    topUpMon,
    withdrawMon,
    convertAllToMon,
    clearCache,
  } = useDcaDelegation()

  const outAddr = useMemo(() => {
    const token = getToken(outToken)
    return token ? (token.address as `0x${string}`) : (USDC as `0x${string}`)
  }, [outToken])
  const { metrics, loading: metricsLoading, error: metricsError } = useEnvioMetrics(delegatorSmartAccount?.address)
  const { series, dates, loading: dailyLoading, error: dailyError } = useProtocolDailyMetrics(metricKey, 30)
  const { todayData, latestData, loading: todayLoading, error: todayError } = useTodayProtocolMetrics()
  const PROTOCOLS = ['magma','ambient','curvance','kuru','pyth','atlantis','octoswap','pingu'] as const
  const todayBarData = PROTOCOLS.map(p => ({ protocolId: p, value: Number((todayData.find(d=>d.protocolId===p) as any)?.[todayMetric] || 0) }))
  const [totalMetric, setTotalMetric] = useState<'txCumulative' | 'avgTxPerUser' | 'avgFeeNative'>('txCumulative')
  const totalsProtocols = totalMetric==='avgFeeNative' 
    ? (PROTOCOLS.filter(p=>p!=='curvance' && p!=='octoswap') as typeof PROTOCOLS) 
    : PROTOCOLS
  const totalsBarData = totalsProtocols.map(p => ({ protocolId: p, value: Number((latestData.find(l=>l.protocolId===p) as any)?.[totalMetric] || 0) }))
  const { tokenMetrics, loading: tokenMetricsLoading } = useTokenMetrics()
  const { personality, enabled: aiEnabled, decisions, isProcessing, error: aiError, setPersonality, setEnabled, makeDecision, markExecuted, provider, setProvider } = useAutonomousAi()
  const hasOpenAiKey = Boolean((import.meta as any).env?.VITE_OPENAI_API_KEY)

  const todayTotals = useMemo(() => {
    let users = 0, tx = 0
    for (const r of todayData) {
      users += Number((r as any)?.usersDaily || 0)
      tx += Number((r as any)?.txDaily || 0)
    }
    return { users, tx }
  }, [todayData])

  const hasConvertible = useMemo(() => {
    try {
      const wmon = parseFloat((balances as any).WMON || '0') > 0
      if (wmon) return true
      for (const t of Object.values(TOKENS)) {
        if (t.isNative || t.symbol === 'WMON') continue
        const bs = (balances as any)[t.symbol] || '0'
        try {
          if (parseUnits(bs, t.decimals) > 0n) return true
        } catch {
          if (parseFloat(bs) > 0) return true
        }
      }
      return false
    } catch {
      return false
    }
  }, [balances])

  // AI callback for autonomous DCA
  const aiCallback = async (currentBalances: Record<string, string>) => {
    try {
      const decision = await makeDecision(currentBalances, metrics, tokenMetrics)
      if (decision && decision.action.type !== 'HOLD') {
        markExecuted(decision.id)
        
        // Handle different action types
        if (decision.action.type === 'BUY') {
          // Map token symbols to addresses
          const tokenMap: Record<string, string> = {
            'USDC': USDC,
            'CHOG': CHOG,
            'WMON': '0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701',
            'BEAN': '0x268e4e24e0051ec27b3d27a95977e71ce6875a05',
            'DAK': '0x0f0bdebf0f83cd1ee3974779bcb7315f9808c714',
            'YAKI': '0xfe140e1dCe99Be9F4F15d657CD9b7BF622270C50',
            'WBTC': '0xcf5a6076cfa32686c0Df13aBaDa2b40dec133F1d',
            'DAKIMAKURA': '0x0569049E527BB151605EEC7bf48Cfd55bD2Bf4c8'
          }
          
          const targetAddress = tokenMap[decision.action.targetToken] || USDC
          
          return {
            amount: decision.action.amount || '0.05',
            token: targetAddress as `0x${string}`,
            interval: decision.nextInterval,
            sourceToken: decision.action.sourceToken // Pass source info for future use
          }
        }
        // For SELL actions, we'll need to implement sell logic later
        // For now, default to buying USDC
        return {
          amount: '0.05',
          token: USDC as `0x${string}`,
          interval: decision.nextInterval,
          sourceToken: 'MON'
        }
      }
      return null // HOLD decision
    } catch (error) {
      console.error('AI callback failed:', error)
      return null
    }
  }

  if (!isInitialized) {
    return (
      <div className="max-w-md w-full">
        <div className="glass rounded-2xl p-8 text-center">
          <div className="animate-spin w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full mx-auto mb-4"></div>
          <h2 className="text-xl font-semibold mb-2 text-white">Initializing...</h2>
          <p className="text-gray-300 text-sm">Setting up smart accounts and delegation permissions</p>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full max-w-5xl">
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-2">
          <button onClick={() => setActive('trade')} className={`px-3 py-2 rounded-lg text-sm ${active==='trade'?'bg-white/10 text-white':'bg-white/5 text-gray-300 hover:text-white'}`}>Trade</button>
          <button onClick={() => setActive('ai')} className={`px-3 py-2 rounded-lg text-sm ${active==='ai'?'bg-white/10 text-white':'bg-white/5 text-gray-300 hover:text-white'}`}>AI</button>
          <button onClick={() => setActive('metrics')} className={`px-3 py-2 rounded-lg text-sm ${active==='metrics'?'bg-white/10 text-white':'bg-white/5 text-gray-300 hover:text-white'}`}>Metrics</button>
          <button onClick={() => setActive('verification')} className={`px-3 py-2 rounded-lg text-sm ${active==='verification'?'bg-white/10 text-white':'bg-white/5 text-gray-300 hover:text-white'}`}>Verification</button>
          <button onClick={() => setActive('settings')} className={`px-3 py-2 rounded-lg text-sm ${active==='settings'?'bg-white/10 text-white':'bg-white/5 text-gray-300 hover:text-white'}`}>Settings</button>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refreshBalances} disabled={isLoading} className="p-2 text-gray-300 hover:text-white disabled:opacity-50"><RefreshCw size={16} className={isLoading? 'animate-spin':''} /></button>
        </div>
      </div>

      {active === 'trade' && (
        <div className="grid md:grid-cols-2 gap-4">
          <div className="glass rounded-2xl p-5">
            <div className="text-xl font-semibold mb-4 text-white flex items-center gap-2"><SlidersHorizontal size={18}/>DCA</div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-300 mb-1">MON Amount</label>
                <input type="number" inputMode="decimal" step="any" value={monDcaAmount} onChange={(e)=>setMonDcaAmount(e.target.value)} className="w-full bg-zinc-900/50 border border-zinc-600 rounded-lg px-3 py-2 text-white"/>
              </div>
              <div>
                <label className="block text-xs text-gray-300 mb-1">Slippage (bps)</label>
                <input type="number" inputMode="numeric" step="1" value={slippageBps} onChange={(e)=>setSlippageBps(e.target.value)} className="w-full bg-zinc-900/50 border border-zinc-600 rounded-lg px-3 py-2 text-white"/>
              </div>
              <div>
                <label className="block text-xs text-gray-300 mb-1">Target Token</label>
                <select value={outToken} onChange={(e)=>setOutToken(e.target.value)} className="w-full bg-zinc-900/50 border border-zinc-600 rounded-lg px-3 py-2 text-white">
                  {getTargetTokens().filter(t => t.symbol !== 'WMON').map(token => (
                    <option key={token.symbol} value={token.symbol}>{token.symbol}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-300 mb-1">Interval (s)</label>
                <input type="number" inputMode="numeric" step="1" value={interval} onChange={(e)=>setInterval(e.target.value)} className="w-full bg-zinc-900/50 border border-zinc-600 rounded-lg px-3 py-2 text-white"/>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 mt-4">
              {!dcaStatus.isActive ? (
                <button 
                  onClick={()=>startNativeDca(monDcaAmount, parseInt(slippageBps), outAddr, parseInt(interval), aiEnabled, aiEnabled ? aiCallback : undefined)} 
                  disabled={isLoading || delegationExpired || (aiEnabled && (metricsLoading || tokenMetricsLoading))} 
                  className="flex items-center justify-center gap-2 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 disabled:opacity-50 text-white font-semibold py-3 px-4 rounded-xl"
                >
                  <Play size={16}/>{aiEnabled ? 'Start AI DCA' : 'Start DCA'}
                </button>
              ) : (
                <button onClick={()=>stopDca()} disabled={isLoading} className="flex items-center justify-center gap-2 bg-gradient-to-r from-red-600 to-pink-600 hover:from-red-700 hover:to-pink-700 disabled:opacity-50 text-white font-semibold py-3 px-4 rounded-xl"><Square size={16}/>Stop</button>
              )}
              <button onClick={()=>runNativeNow(monDcaAmount, parseInt(slippageBps), outAddr)} disabled={isLoading || delegationExpired} className="flex items-center justify-center gap-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 disabled:opacity-50 text-white font-semibold py-3 px-4 rounded-xl"><Zap size={16}/>Run Now</button>
            </div>
            <button onClick={()=>convertAllToMon(parseInt(slippageBps))} disabled={isLoading || delegationExpired || !hasConvertible} className="w-full mt-3 flex items-center justify-center gap-2 bg-gradient-to-r from-teal-600 to-emerald-600 hover:from-teal-700 hover:to-emerald-700 disabled:opacity-50 text-white font-semibold py-3 px-4 rounded-xl"><ArrowUpDown size={16}/>Convert ALL to MON</button>
          </div>

          <div className="space-y-4">
            <div className="glass rounded-2xl p-5">
              <div className="text-lg font-semibold mb-3 text-white flex items-center gap-2"><Cpu size={18}/>MON Actions</div>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-gray-300 mb-1">Top-up MON</label>
                  <div className="flex gap-2">
                    <input type="number" inputMode="decimal" step="any" value={monAmount} onChange={(e)=>setMonAmount(e.target.value)} className="w-full bg-zinc-900/50 border border-zinc-600 rounded-lg px-3 py-2 text-white"/>
                    <button onClick={()=>topUpMon(monAmount)} disabled={isLoading} className="px-4 rounded-lg bg-gradient-to-r from-sky-600 to-blue-600 text-white font-semibold">Send</button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-gray-300 mb-1">Withdraw MON</label>
                  <div className="flex gap-2">
                    <input type="number" inputMode="decimal" step="any" value={withdrawMonAmount} onChange={(e)=>setWithdrawMonAmount(e.target.value)} className="w-full bg-zinc-900/50 border border-zinc-600 rounded-lg px-3 py-2 text-white"/>
                    <button onClick={()=>withdrawMon(withdrawMonAmount)} disabled={isLoading} className="px-4 rounded-lg bg-gradient-to-r from-pink-600 to-rose-600 text-white font-semibold">Withdraw</button>
                  </div>
                </div>
              </div>
            </div>

            <div className="glass rounded-2xl p-5">
              <div className="text-lg font-semibold mb-3 text-white flex items-center gap-2"><BarChart2 size={18}/>Balances</div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="flex justify-between"><span className="text-gray-300">MON</span><span className="text-white font-mono">{balances.MON}</span></div>
                {getAllTradableTokens().filter(t => t.symbol !== 'WMON').map(t => (
                  <div key={t.symbol} className="flex justify-between">
                    <span className="text-gray-300">{t.symbol}</span>
                    <span className="text-white font-mono">{(balances as any)[t.symbol] ?? '0.0'}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="glass rounded-2xl p-5">
              <div className="text-lg font-semibold mb-3 text-white flex items-center gap-2"><Settings size={18}/>Status</div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-gray-300">DCA</span><span className={`font-semibold ${dcaStatus.isActive?'text-green-400':'text-gray-400'}`}>{dcaStatus.isActive?'Active':'Stopped'}</span></div>
                {dcaStatus.nextExecution && <div className="flex justify-between"><span className="text-gray-300">Next</span><span className="text-white font-mono">{dcaStatus.nextExecution.toLocaleTimeString()}</span></div>}
                {dcaStatus.lastUserOpHash && (
                  <div className="flex justify-between items-center">
                    <span className="text-gray-300">Last UO</span>
                    <a 
                      className="text-blue-400 font-mono hover:underline"
                      href={`https://testnet.monadexplorer.com/tx/${dcaStatus.lastUserOpHash}`}
                      target="_blank"
                      rel="noreferrer"
                      title="Open in explorer"
                    >
                      {dcaStatus.lastUserOpHash.slice(0,10)}...
                    </a>
                  </div>
                )}
                {dcaStatus.lastError && <div className="flex justify-between"><span className="text-gray-300">Last Error</span><span className="text-red-400">{dcaStatus.lastError}</span></div>}
              </div>
            </div>
          </div>
        </div>
      )}

      {active === 'ai' && (
        <div className="space-y-4">
          <div className="glass rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="text-xl font-semibold text-white flex items-center gap-2"><Brain size={18}/>Autonomous AI Agent</div>
              <label className="inline-flex items-center gap-2 text-sm text-gray-300">
                <input 
                  type="checkbox" 
                  checked={aiEnabled} 
                  onChange={(e)=>setEnabled(e.target.checked)} 
                  className="accent-purple-500"
                  disabled={provider !== 'openai'}
                  title={provider !== 'openai' ? (provider === 'opengradient' ? 'need faucet token' : 'coming soon') : 'active'}
                />
                Enable AI Control
              </label>
            </div>
            
            <div className="grid md:grid-cols-4 gap-3 mb-4">
              <button 
                onClick={() => setPersonality('conservative')} 
                className={`py-2 px-3 rounded-lg text-sm ${personality === 'conservative' ? 'bg-blue-600 text-white' : 'bg-white/10 text-gray-300 hover:text-white'}`}
              >
                Conservative
              </button>
              <button 
                onClick={() => setPersonality('balanced')} 
                className={`py-2 px-3 rounded-lg text-sm ${personality === 'balanced' ? 'bg-blue-600 text-white' : 'bg-white/10 text-gray-300 hover:text-white'}`}
              >
                Balanced
              </button>
              <button 
                onClick={() => setPersonality('aggressive')} 
                className={`py-2 px-3 rounded-lg text-sm ${personality === 'aggressive' ? 'bg-blue-600 text-white' : 'bg-white/10 text-gray-300 hover:text-white'}`}
              >
                Aggressive
              </button>
              <button 
                onClick={() => setPersonality('contrarian')} 
                className={`py-2 px-3 rounded-lg text-sm ${personality === 'contrarian' ? 'bg-blue-600 text-white' : 'bg-white/10 text-gray-300 hover:text-white'}`}
              >
                Contrarian
              </button>
            </div>

            <div className="glass rounded-xl p-4 mb-4">
              <div className="text-sm text-gray-300 mb-2">AI Status</div>
              <div className="flex items-center gap-4">
                <div className={`flex items-center gap-2 ${aiEnabled ? 'text-green-400' : 'text-gray-400'}`}>
                  <div className={`w-2 h-2 rounded-full ${aiEnabled ? 'bg-green-400' : 'bg-gray-400'}`}></div>
                  {aiEnabled ? 'AI Enabled' : 'AI Disabled'}
                </div>
                <div className="text-gray-300">Personality: <span className="text-white capitalize">{personality}</span></div>
                {isProcessing && (
                  <div className="flex items-center gap-2 text-yellow-400">
                    <div className="animate-spin w-3 h-3 border border-yellow-400 border-t-transparent rounded-full"></div>
                    Processing...
                  </div>
                )}
              </div>
            </div>

            <div className="glass rounded-xl p-4 mb-4">
              <div className="text-sm text-gray-300 mb-2">AI Provider</div>
              <div className="flex items-center gap-3 mb-3 text-sm">
                <button
                  onClick={() => setProvider('openai')}
                  className={`px-3 py-1 rounded-lg flex items-center gap-2 ${provider==='openai'?'bg-white/10 text-white':'bg-white/5 text-gray-300 hover:text-white'}`}
                  title="active"
                >
                  <span className={`w-2 h-2 rounded-full ${provider==='openai' ? (hasOpenAiKey ? 'bg-green-400' : 'bg-red-400') : 'bg-gray-400'}`}></span>
                  OpenAI
                </button>
                <button
                  onClick={() => setProvider('fortytwo')}
                  className={`px-3 py-1 rounded-lg flex items-center gap-2 ${provider==='fortytwo'?'bg-white/10 text-white':'bg-white/5 text-gray-300 hover:text-white'}`}
                  title="coming soon"
                >
                  <span className={`w-2 h-2 rounded-full ${provider==='fortytwo' ? 'bg-yellow-400' : 'bg-gray-400'}`}></span>
                  FortyTwo network (swarm inference)
                </button>
                <button
                  onClick={() => setProvider('opengradient')}
                  className={`px-3 py-1 rounded-lg flex items-center gap-2 ${provider==='opengradient'?'bg-white/10 text-white':'bg-white/5 text-gray-300 hover:text-white'}`}
                  title="need faucet token"
                >
                  <span className={`w-2 h-2 rounded-full ${provider==='opengradient' ? 'bg-yellow-400' : 'bg-gray-400'}`}></span>
                  OpenGradient (swarm inference)
                </button>
              </div>
              
              {provider==='opengradient' && (
                <div className="text-xs text-yellow-400">need faucet token</div>
              )}
              {provider==='fortytwo' && (
                <div className="text-xs text-yellow-400">coming soon</div>
              )}
            </div>

            {aiError && (
              <div className="p-3 bg-red-600/20 border border-red-600/30 rounded-lg text-red-400 text-sm mb-4">
                {aiError}
              </div>
            )}

            <div className="text-center py-4">
              <p className="text-gray-300 text-sm mb-2">
                {aiEnabled 
                  ? 'AI will automatically control DCA decisions when started' 
                  : 'Enable AI to let the agent make autonomous trading decisions'
                }
              </p>
              <p className="text-gray-400 text-xs">
                The AI analyzes market metrics, whale activity, and portfolio balance to make optimal decisions
              </p>
            </div>
          </div>
          
          {decisions.length > 0 && (
            <div className="glass rounded-2xl p-5">
              <div className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <BarChart2 size={18}/>Decision History
              </div>
              <div className="space-y-3 max-h-60 overflow-y-auto">
                {decisions.slice(0, 10).map((decision) => (
                  <div key={decision.id} className="glass rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm text-gray-300">
                        {new Date(decision.timestamp).toLocaleString()}
                      </div>
                      <div className={`px-2 py-1 rounded text-xs ${
                        decision.executed ? 'bg-green-600/20 text-green-400' : 'bg-yellow-600/20 text-yellow-400'
                      }`}>
                        {decision.executed ? 'Executed' : 'Pending'}
                      </div>
                    </div>
                    <div className="text-white text-sm">
                      <span className="capitalize">{decision.personality}</span>: {decision.action.type}
                      {decision.action.type === 'BUY' && ` ${decision.action.amount} ${decision.action.sourceToken} → ${decision.action.targetToken}`}
                      {decision.action.type === 'SELL_TO_MON' && ` ${decision.action.amount} ${decision.action.fromToken} → MON`}
                      {decision.action.type === 'SELL_TO_USDC' && ` ${decision.action.amount} ${decision.action.fromToken} → USDC`}
                      {decision.action.type === 'HOLD' && ` for ${decision.action.duration}s`}
                    </div>
                    <div className="text-gray-400 text-xs mt-1">{decision.action.reasoning}</div>
                    <div className="text-gray-500 text-xs mt-1">
                      Confidence: {Math.round(decision.confidence * 100)}% | Next: {decision.nextInterval}s
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {active === 'metrics' && (
        <div className="space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div className="glass rounded-2xl p-5">
              <div className="text-sm text-gray-300">Users Today (all protocols)</div>
              <div className="text-2xl text-white font-bold">{todayTotals.users}</div>
            </div>
            <div className="glass rounded-2xl p-5">
              <div className="text-sm text-gray-300">Tx Today (all protocols)</div>
              <div className="text-2xl text-white font-bold">{todayTotals.tx}</div>
            </div>
          </div>

          <div className="glass rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="text-lg font-semibold text-white">Protocol Metrics</div>
              <div className="flex items-center gap-2 text-sm">
                <button onClick={()=>setMetricKey('txDaily')} className={`px-2 py-1 rounded ${metricKey==='txDaily'?'bg-white/10 text-white':'bg-white/5 text-gray-300'}`}>Tx/day</button>
                <button onClick={()=>setMetricKey('usersDaily')} className={`px-2 py-1 rounded ${metricKey==='usersDaily'?'bg-white/10 text-white':'bg-white/5 text-gray-300'}`}>Users/day</button>
                <button onClick={()=>setMetricKey('txCumulative')} className={`px-2 py-1 rounded ${metricKey==='txCumulative'?'bg-white/10 text-white':'bg-white/5 text-gray-300'}`}>Tx cumulative</button>
                <button onClick={()=>setMetricKey('avgTxPerUser')} className={`px-2 py-1 rounded ${metricKey==='avgTxPerUser'?'bg-white/10 text-white':'bg-white/5 text-gray-300'}`}>Avg tx/user</button>
                <button onClick={()=>setMetricKey('avgFeeNative')} className={`px-2 py-1 rounded ${metricKey==='avgFeeNative'?'bg-white/10 text-white':'bg-white/5 text-gray-300'}`}>Avg fee (MON)</button>
              </div>
            </div>

            {dailyError && <div className="text-sm text-red-400 mb-2">{dailyError}</div>}
            {dailyLoading ? (
              <div className="text-sm text-gray-300">Loading…</div>
            ) : (
              <ProtocolMetricsChart 
                series={(
                  metricKey==='avgFeeNative' 
                    ? series.filter(s=>s.protocolId!=='curvance' && s.protocolId!=='octoswap' && s.protocolId!=='dex') 
                    : series.filter(s=>s.protocolId!=='dex')
                )} 
                dates={dates} 
              />
            )}
          </div>

          <div className="glass rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="text-lg font-semibold text-white">Today by Protocol</div>
              <div className="flex items-center gap-2 text-sm">
                <button onClick={()=>setTodayMetric('txDaily')} className={`px-2 py-1 rounded ${todayMetric==='txDaily'?'bg-white/10 text-white':'bg-white/5 text-gray-300'}`}>Tx/day</button>
                <button onClick={()=>setTodayMetric('usersDaily')} className={`px-2 py-1 rounded ${todayMetric==='usersDaily'?'bg-white/10 text-white':'bg-white/5 text-gray-300'}`}>Users/day</button>
              </div>
            </div>

            {todayError && <div className="text-sm text-red-400 mb-2">{todayError}</div>}
            {todayLoading ? (
              <div className="text-sm text-gray-300">Loading…</div>
            ) : (
              <ProtocolBarChart data={todayBarData} />
            )}
          </div>

          <div className="glass rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="text-lg font-semibold text-white">Totals by Protocol</div>
              <div className="flex items-center gap-2 text-sm">
                <button onClick={()=>setTotalMetric('txCumulative')} className={`px-2 py-1 rounded ${totalMetric==='txCumulative'?'bg-white/10 text-white':'bg-white/5 text-gray-300'}`}>Tx cumulative</button>
                <button onClick={()=>setTotalMetric('avgTxPerUser')} className={`px-2 py-1 rounded ${totalMetric==='avgTxPerUser'?'bg-white/10 text-white':'bg-white/5 text-gray-300'}`}>Avg tx/user</button>
                <button onClick={()=>setTotalMetric('avgFeeNative')} className={`px-2 py-1 rounded ${totalMetric==='avgFeeNative'?'bg-white/10 text-white':'bg-white/5 text-gray-300'}`}>Avg fee (MON)</button>
              </div>
            </div>

            <ProtocolBarChart data={totalsBarData} />
          </div>

          <div className="glass rounded-2xl p-5">
            <div className="text-lg font-semibold text-white mb-2">Realtime Protocol Totals</div>
            <div className="grid grid-cols-5 gap-2 text-xs text-gray-300 mb-1">
              <div className="font-semibold">Protocol</div>
              <div className="font-semibold">Tx cumulative</div>
              <div className="font-semibold">Avg tx/user</div>
              <div className="font-semibold">Avg fee (MON)</div>
              <div className="font-semibold">Today users/tx</div>
            </div>
            {PROTOCOLS.map(pid => {
              const latest = latestData.find(l=>l.protocolId===pid)
              const todayRow: any = todayData.find(t=>t.protocolId===pid)
              return (
                <div key={pid} className="grid grid-cols-5 gap-2 text-xs text-gray-300 py-1">
                  <div className="text-white">{pid}</div>
                  <div>{latest ? latest.txCumulative : 0}</div>
                  <div>{latest ? latest.avgTxPerUser.toFixed(2) : '0.00'}</div>
                  <div>{latest && latest.avgFeeNative != null ? latest.avgFeeNative.toFixed(6) : '-'}</div>
                  <div>{todayRow ? `${todayRow.usersDaily}/${todayRow.txDaily}` : '0/0'}</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {active === 'settings' && (
        <div className="glass rounded-2xl p-5 space-y-4">
          <div className="text-xl font-semibold text-white flex items-center gap-2"><Settings size={18}/>Settings</div>
          <div className="grid md:grid-cols-2 gap-3">
            <button onClick={renewDelegation} disabled={isLoading} className="py-3 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 text-white font-semibold">Renew Delegation</button>
            <button onClick={clearCache} className="py-3 rounded-xl bg-white/10 text-white font-semibold">Clear Cache</button>
          </div>
          <div className="text-sm text-gray-300">
            {delegationExpired && <div className="text-red-400">Delegation expired</div>}
            {!delegationExpired && typeof delegationExpiresAt==='number' && <div>Expires at: <span className="font-mono text-gray-200">{new Date(delegationExpiresAt*1000).toLocaleString()}</span></div>}
          </div>
          <div className="grid md:grid-cols-2 gap-3 text-sm text-gray-300">
            {delegatorSmartAccount && (
              <div className="flex items-center gap-2">
                <span>Delegator SA:</span>
                <span className="font-mono text-gray-200">{delegatorSmartAccount.address.slice(0,6)}...{delegatorSmartAccount.address.slice(-4)}</span>
                <button className="p-1 hover:text-white" onClick={()=>navigator.clipboard.writeText(delegatorSmartAccount.address)} title="Copy"><Copy size={14}/></button>
              </div>
            )}
            {delegateSmartAccount && (
              <div className="flex items-center gap-2">
                <span>Delegate SA:</span>
                <span className="font-mono text-gray-200">{delegateSmartAccount.address.slice(0,6)}...{delegateSmartAccount.address.slice(-4)}</span>
                <button className="p-1 hover:text-white" onClick={()=>navigator.clipboard.writeText(delegateSmartAccount.address)} title="Copy"><Copy size={14}/></button>
              </div>
            )}
          </div>
        </div>
      )}

      {active === 'verification' && (
        <AiVerificationPanel 
          balances={balances}
          portfolioValueMon={parseFloat(balances.MON) + parseFloat(balances.WMON) + parseFloat(balances.USDC) * 0.1 + parseFloat(balances.CHOG) * 0.001}
          delegationExpired={delegationExpired}
        />
      )}
    </div>
  )
}

