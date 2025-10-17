import { useState } from 'react'
import { Play, Square, Zap, ArrowUpDown, RefreshCw, Copy } from 'lucide-react'
import { useDcaDelegation } from '../hooks/useDcaDelegation'
import { USDC, CHOG } from '../lib/tokens'

export default function DcaControl() {
  const [monDcaAmount, setMonDcaAmount] = useState('0.05')
  const [slippageBps, setSlippageBps] = useState('300') // 3%
  const [interval, setInterval] = useState('60') // seconds
  const [monAmount, setMonAmount] = useState('0.1')
  const [withdrawMonAmount, setWithdrawMonAmount] = useState('0.05')
  const [outToken, setOutToken] = useState<'USDC' | 'CHOG'>('USDC')

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
    runNativeSwapMonToToken,
  } = useDcaDelegation()

  const handleStartDca = async () => {
    try {
      const outAddr = outToken === 'USDC' ? (USDC as `0x${string}`) : (CHOG as `0x${string}`)
      await startNativeDca(monDcaAmount, parseInt(slippageBps), outAddr, parseInt(interval))
    } catch (error) {
      console.error('Failed to start DCA:', error)
    }
  }

  const handleTopUp = async () => {
    try {
      await topUpMon(monAmount)
    } catch (e) {
      console.error('Top up failed:', e)
    }
  }

  const handleWithdrawMon = async () => {
    try {
      await withdrawMon(withdrawMonAmount)
    } catch (e) {
      console.error('Withdraw failed:', e)
    }
  }

  // removed: standalone native DCA panel (replaced main DCA to use MON)

  const handleStopDca = async () => {
    try {
      stopDca()
    } catch (error) {
      console.error('Failed to stop DCA:', error)
    }
  }

  const handleRunNow = async () => {
    try {
      const outAddr = outToken === 'USDC' ? (USDC as `0x${string}`) : (CHOG as `0x${string}`)
      await runNativeNow(monDcaAmount, parseInt(slippageBps), outAddr)
    } catch (error) {
      console.error('Failed to run DCA:', error)
    }
  }

  const handleUnwrapAll = async () => {
    try {
      await unwrapAll()
    } catch (error) {
      console.error('Failed to unwrap WMON:', error)
    }
  }

  const handleRenewDelegation = async () => {
    try {
      await renewDelegation()
    } catch (error) {
      console.error('Failed to renew delegation:', error)
    }
  }

  if (!isInitialized) {
    return (
      <div className="max-w-md w-full">
        <div className="glass rounded-2xl p-8 text-center">
          <div className="animate-spin w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full mx-auto mb-4"></div>
          <h2 className="text-xl font-semibold mb-2 text-white">Initializing...</h2>
          <p className="text-gray-300 text-sm">
            Setting up smart accounts and delegation permissions
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl w-full space-y-6">
      <style>{`
        /* Hide number input arrows */
        input[type=number]::-webkit-outer-spin-button,
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; }
      `}</style>
      {/* Header */}
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold mb-4 bg-gradient-to-r from-purple-400 to-indigo-400 bg-clip-text text-transparent">
          DCA Delegation
        </h1>
        <p className="text-gray-300">
          Automated MON → Token swaps with delegation on Monad Testnet
        </p>
        {delegationExpired && (
          <div className="mt-4 bg-red-900/40 border border-red-600 text-red-200 rounded-xl px-4 py-3 inline-flex items-center gap-3">
            <span>Delegation expired. Please renew to continue.</span>
            <button
              onClick={handleRenewDelegation}
              disabled={isLoading}
              className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-semibold py-2 px-3 rounded-lg flex items-center gap-2"
            >
              <RefreshCw size={14} /> Renew delegation
            </button>
          </div>
        )}
        {!delegationExpired && typeof delegationExpiresAt === 'number' && (
          <div className="mt-3 text-sm text-gray-400">
            Expires at: <span className="font-mono text-gray-300">{new Date(delegationExpiresAt * 1000).toLocaleString()}</span>
          </div>
        )}
        {(delegatorSmartAccount || delegateSmartAccount) && (
          <div className="mt-3 space-y-1">
            {delegatorSmartAccount && (
              <div className="flex items-center justify-center gap-2 text-sm text-gray-400">
                <span>Delegator SA:</span>
                <span className="font-mono text-gray-300">
                  {delegatorSmartAccount.address.slice(0, 6)}...{delegatorSmartAccount.address.slice(-4)}
                </span>
                <button
                  className="p-1 hover:text-white"
                  onClick={() => navigator.clipboard.writeText(delegatorSmartAccount.address)}
                  title="Copy delegator address"
                >
                  <Copy size={14} />
                </button>
              </div>
            )}
            {delegateSmartAccount && (
              <div className="flex items-center justify-center gap-2 text-sm text-gray-400">
                <span>Delegate SA:</span>
                <span className="font-mono text-gray-300">
                  {delegateSmartAccount.address.slice(0, 6)}...{delegateSmartAccount.address.slice(-4)}
                </span>
                <button
                  className="p-1 hover:text-white"
                  onClick={() => navigator.clipboard.writeText(delegateSmartAccount.address)}
                  title="Copy delegate address"
                >
                  <Copy size={14} />
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* DCA Control Panel */}
        <div className="glass rounded-2xl p-6">
          <h2 className="text-xl font-semibold mb-6 text-white">DCA Control</h2>
          
          <div className="space-y-4">
            {/* MON Amount */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                MON Amount
              </label>
              <input
                type="number"
                inputMode="decimal"
                step="any"
                value={monDcaAmount}
                onChange={(e) => setMonDcaAmount(e.target.value)}
                className="w-full bg-zinc-900/50 border border-zinc-600 rounded-lg px-3 py-2 text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-base caret-white"
                placeholder="0.05"
              />
            </div>

            {/* Slippage */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Slippage (bps)
              </label>
              <input
                type="number"
                inputMode="decimal"
                step="any"
                value={slippageBps}
                onChange={(e) => setSlippageBps(e.target.value)}
                className="w-full bg-zinc-900/50 border border-zinc-600 rounded-lg px-3 py-2 text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-base caret-white"
                placeholder="300"
              />
              <p className="text-xs text-gray-400 mt-1">
                {(parseInt(slippageBps) / 100).toFixed(2)}% slippage
              </p>
            </div>

            {/* Out Token */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Token
              </label>
              <select
                value={outToken}
                onChange={(e) => setOutToken(e.target.value as 'USDC' | 'CHOG')}
                className="w-full bg-black/30 border border-gray-600 rounded-lg px-3 py-2 text-white focus:border-purple-500 focus:outline-none"
              >
                <option value="USDC">USDC</option>
                <option value="CHOG">CHOG</option>
              </select>
            </div>

            {/* Interval */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Interval (seconds)
              </label>
              <input
                type="number"
                inputMode="numeric"
                step="1"
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
                className="w-full bg-zinc-900/50 border border-zinc-600 rounded-lg px-3 py-2 text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-base caret-white"
                placeholder="60"
              />
            </div>

            {/* Action Buttons */}
            <div className="grid grid-cols-2 gap-3 pt-4">
              {!dcaStatus.isActive ? (
                <button
                  onClick={handleStartDca}
                  disabled={isLoading || delegationExpired}
                  className="flex items-center justify-center gap-2 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 disabled:opacity-50 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200 transform hover:scale-105"
                >
                  <Play size={16} />
                  {isLoading ? 'Starting...' : 'Start DCA'}
                </button>
              ) : (
                <button
                  onClick={handleStopDca}
                  disabled={isLoading}
                  className="flex items-center justify-center gap-2 bg-gradient-to-r from-red-600 to-pink-600 hover:from-red-700 hover:to-pink-700 disabled:opacity-50 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200 transform hover:scale-105"
                >
                  <Square size={16} />
                  {isLoading ? 'Stopping...' : 'Stop DCA'}
                </button>
              )}

              <button
                onClick={handleRunNow}
                disabled={isLoading || delegationExpired}
                className="flex items-center justify-center gap-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 disabled:opacity-50 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200 transform hover:scale-105"
              >
                <Zap size={16} />
                {isLoading ? 'Running...' : 'Run Now'}
              </button>
            </div>

            {/* Unwrap Button */}
            <button
              onClick={handleUnwrapAll}
              disabled={isLoading || parseFloat(balances.WMON) === 0 || delegationExpired}
              className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-orange-600 to-yellow-600 hover:from-orange-700 hover:to-yellow-700 disabled:opacity-50 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200 transform hover:scale-105"
            >
              <ArrowUpDown size={16} />
              {isLoading ? 'Unwrapping...' : 'Unwrap WMON → MON (all)'}
            </button>
          </div>
        </div>

        {/* Status & Monitoring */}
        <div className="space-y-6">
          {/* MON Actions */}
          <div className="glass rounded-2xl p-6">
            <h3 className="text-lg font-semibold mb-4 text-white">MON Actions</h3>
            <div className="space-y-6">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-300">TOP-UP MON</label>
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  value={monAmount}
                  onChange={(e) => setMonAmount(e.target.value)}
                  className="appearance-none w-full bg-zinc-900/50 border border-zinc-600 rounded-lg px-3 py-3 text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-base caret-white"
                  placeholder="0.1"
                />
                <button
                  onClick={handleTopUp}
                  disabled={isLoading}
                  className="w-full bg-gradient-to-r from-sky-600 to-blue-600 hover:from-sky-700 hover:to-blue-700 disabled:opacity-50 text-white font-semibold py-3 px-4 rounded-lg"
                >
                  TOP-UP MON
                </button>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-300">WITHDRAW MON</label>
                <input
                  type="number"
                  inputMode="decimal"
                  step="any"
                  value={withdrawMonAmount}
                  onChange={(e) => setWithdrawMonAmount(e.target.value)}
                  className="appearance-none w-full bg-zinc-900/50 border border-zinc-600 rounded-lg px-3 py-3 text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-base caret-white"
                  placeholder="0.05"
                />
                <button
                  onClick={handleWithdrawMon}
                  disabled={isLoading}
                  className="w-full bg-gradient-to-r from-pink-600 to-rose-600 hover:from-pink-700 hover:to-rose-700 disabled:opacity-50 text-white font-semibold py-3 px-4 rounded-lg"
                >
                  WITHDRAW MON
                </button>
              </div>
            </div>
          </div>
          {/* Balances */}
          <div className="glass rounded-2xl p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-white">Balances</h3>
              <button
                onClick={refreshBalances}
                disabled={isLoading}
                className="p-2 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
                title="Refresh balances"
              >
                <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />
              </button>
            </div>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-300">MON</span>
                <span className="text-white font-mono">{balances.MON}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-300">USDC</span>
                <span className="text-white font-mono">{balances.USDC}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-300">WMON</span>
                <span className="text-white font-mono">{balances.WMON}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-300">CHOG</span>
                <span className="text-white font-mono">{balances.CHOG}</span>
              </div>
            </div>
          </div>

          {/* Status */}
          <div className="glass rounded-2xl p-6">
            <h3 className="text-lg font-semibold mb-4 text-white">Status</h3>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-300">DCA Status</span>
                <span className={`font-semibold ${dcaStatus.isActive ? 'text-green-400' : 'text-gray-400'}`}>
                  {dcaStatus.isActive ? 'Active' : 'Stopped'}
                </span>
              </div>
              {dcaStatus.nextExecution && (
                <div className="flex justify-between">
                  <span className="text-gray-300">Next Execution</span>
                  <span className="text-white font-mono text-sm">
                    {dcaStatus.nextExecution.toLocaleTimeString()}
                  </span>
                </div>
              )}
              {dcaStatus.lastUserOpHash && (
                <div className="flex justify-between">
                  <span className="text-gray-300">Last UserOp</span>
                  <span className="text-blue-400 font-mono text-sm">
                    {dcaStatus.lastUserOpHash.slice(0, 8)}...
                  </span>
                </div>
              )}
              {dcaStatus.lastError && (
                <div className="flex justify-between">
                  <span className="text-gray-300">Last Error</span>
                  <span className="text-red-400 text-sm">
                    {dcaStatus.lastError}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
