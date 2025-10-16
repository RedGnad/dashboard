import { useState } from 'react'
import { Play, Square, Zap, ArrowUpDown, RefreshCw, Copy } from 'lucide-react'
import { useDcaDelegation } from '../hooks/useDcaDelegation'

export default function DcaControl() {
  const [usdcAmount, setUsdcAmount] = useState('100')
  const [slippageBps, setSlippageBps] = useState('300') // 3%
  const [interval, setInterval] = useState('60') // seconds

  const {
    isInitialized,
    isLoading,
    dcaStatus,
    balances,
    delegatorSmartAccount,
    delegateSmartAccount,
    startDca,
    stopDca,
    runNow,
    unwrapAll,
    refreshBalances,
  } = useDcaDelegation()

  const handleStartDca = async () => {
    try {
      await startDca(usdcAmount, parseInt(slippageBps), parseInt(interval))
    } catch (error) {
      console.error('Failed to start DCA:', error)
    }
  }

  const handleStopDca = async () => {
    try {
      stopDca()
    } catch (error) {
      console.error('Failed to stop DCA:', error)
    }
  }

  const handleRunNow = async () => {
    try {
      await runNow(usdcAmount, parseInt(slippageBps))
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
      {/* Header */}
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold mb-4 bg-gradient-to-r from-purple-400 to-indigo-400 bg-clip-text text-transparent">
          DCA Delegation
        </h1>
        <p className="text-gray-300">
          Automated USDC → WMON swaps with delegation on Monad Testnet
        </p>
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
            {/* USDC Amount */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                USDC Amount
              </label>
              <input
                type="number"
                value={usdcAmount}
                onChange={(e) => setUsdcAmount(e.target.value)}
                className="w-full bg-black/30 border border-gray-600 rounded-lg px-3 py-2 text-white placeholder-gray-400 focus:border-purple-500 focus:outline-none"
                placeholder="100"
              />
            </div>

            {/* Slippage */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Slippage (bps)
              </label>
              <input
                type="number"
                value={slippageBps}
                onChange={(e) => setSlippageBps(e.target.value)}
                className="w-full bg-black/30 border border-gray-600 rounded-lg px-3 py-2 text-white placeholder-gray-400 focus:border-purple-500 focus:outline-none"
                placeholder="300"
              />
              <p className="text-xs text-gray-400 mt-1">
                {(parseInt(slippageBps) / 100).toFixed(2)}% slippage
              </p>
            </div>

            {/* Interval */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Interval (seconds)
              </label>
              <input
                type="number"
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
                className="w-full bg-black/30 border border-gray-600 rounded-lg px-3 py-2 text-white placeholder-gray-400 focus:border-purple-500 focus:outline-none"
                placeholder="60"
              />
            </div>

            {/* Action Buttons */}
            <div className="grid grid-cols-2 gap-3 pt-4">
              {!dcaStatus.isActive ? (
                <button
                  onClick={handleStartDca}
                  disabled={isLoading}
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
                disabled={isLoading}
                className="flex items-center justify-center gap-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 disabled:opacity-50 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200 transform hover:scale-105"
              >
                <Zap size={16} />
                {isLoading ? 'Running...' : 'Run Now'}
              </button>
            </div>

            {/* Unwrap Button */}
            <button
              onClick={handleUnwrapAll}
              disabled={isLoading || parseFloat(balances.WMON) === 0}
              className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-orange-600 to-yellow-600 hover:from-orange-700 hover:to-yellow-700 disabled:opacity-50 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200 transform hover:scale-105"
            >
              <ArrowUpDown size={16} />
              {isLoading ? 'Unwrapping...' : 'Unwrap WMON → MON (all)'}
            </button>
          </div>
        </div>

        {/* Status & Monitoring */}
        <div className="space-y-6">
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
