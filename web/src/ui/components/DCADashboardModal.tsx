import React from 'react';

interface DCADashboardModalProps {
  // DCA Controls
  amount: string;
  setAmount: (v: string) => void;
  schedulerSource: 'USDC' | 'MON';
  setSchedulerSource: (v: 'USDC' | 'MON') => void;
  schedulerTargetSymbol: string;
  setSchedulerTargetSymbol: (v: string) => void;
  slippageBps: string;
  setSlippageBps: (v: string) => void;
  tokensMeta: Record<string, any>;
  
  // Job state
  job: any;
  emissionCountdown: number | null;
  hasDelegation: boolean;
  topupStatus?: string;
  
  // Actions
  createAndPostDelegation: () => void;
  startDca: () => void;
  stopDca: () => void;
  sendMonNative: () => void;
  convertAllToMon: () => void;
  
  // Top-up
  topupAmount: string;
  setTopupAmount: (v: string) => void;
  directTopupUsdc: () => void;
  directTopupMon: () => void;
  
  // State
  busy: boolean;
  address?: string;
  delegatorAddress?: string;
  msg?: string;
}

export default function DCADashboardModal(props: DCADashboardModalProps) {
  const {
    amount, setAmount,
    schedulerSource, setSchedulerSource,
    schedulerTargetSymbol, setSchedulerTargetSymbol,
    slippageBps, setSlippageBps,
    tokensMeta,
    job, emissionCountdown, hasDelegation, topupStatus,
    createAndPostDelegation, startDca, stopDca, sendMonNative, convertAllToMon,
    topupAmount, setTopupAmount, directTopupUsdc, directTopupMon,
    busy, address, delegatorAddress, msg
  } = props;

  return (
    <div className="space-y-6">
      {/* Create Delegation */}
      <div className="bg-white/5 backdrop-blur-sm rounded-xl p-4 border border-white/10">
        <h3 className="text-lg font-semibold text-white mb-4">Setup Delegation</h3>
        <button
          onClick={createAndPostDelegation}
          disabled={busy}
          className="w-full px-4 py-3 bg-purple-600/40 hover:bg-purple-600/60 disabled:bg-gray-600/20 text-white rounded-lg transition-colors font-medium"
        >
          {busy ? 'Working…' : 'Create Core Delegation'}
        </button>
      </div>

      {/* DCA Scheduler */}
      <div className="bg-white/5 backdrop-blur-sm rounded-xl p-4 border border-white/10">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-white">DCA Scheduler</h3>
          <div className="text-xs text-white/60">Interval: 60s • Duration: 24h</div>
        </div>
        <div className="grid grid-cols-2 gap-3 mb-4">
          <label className="text-sm text-white/80">
            Amount per DCA ({schedulerSource}):
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
            />
          </label>
          <label className="text-sm text-white/80">
            Slippage (bps):
            <input
              value={slippageBps}
              onChange={(e) => setSlippageBps(e.target.value)}
              className="mt-1 w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
            />
          </label>
          <label className="text-sm text-white/80">
            Source:
            <select
              value={schedulerSource}
              onChange={(e) => setSchedulerSource(e.target.value as 'USDC' | 'MON')}
              className="mt-1 w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-purple-500/50"
            >
              <option value="USDC">USDC</option>
              <option value="MON">MON</option>
            </select>
          </label>
          <label className="text-sm text-white/80">
            Target token:
            <select
              value={schedulerTargetSymbol}
              onChange={(e) => setSchedulerTargetSymbol(e.target.value)}
              className="mt-1 w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-purple-500/50"
            >
              {Object.keys(tokensMeta || {}).map((sym) => (
                <option key={sym} value={sym}>{sym}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="text-sm text-white/80 space-y-1 mb-4 p-3 bg-white/5 rounded-lg">
          <div>Status: <span className={job?.active ? 'text-green-400' : 'text-gray-400'}>{job?.active ? 'Active' : 'Stopped'}</span></div>
          {job?.runsDone != null && <div>Runs: {job.runsDone}</div>}
          {job?.lastError && <div className="text-red-400">Error: {job.lastError}</div>}
          <div>Last run: {job?.lastRunAt ? new Date(job.lastRunAt).toLocaleTimeString() : '—'}</div>
          <div>Next in: {job?.active && emissionCountdown != null ? `${emissionCountdown}s` : '—'}</div>
          {topupStatus && <div className="text-green-400 text-xs">{topupStatus}</div>}
          <div className="text-xs">Expires: {job?.expiresAt ? new Date(job.expiresAt).toLocaleString() : '—'}</div>
        </div>

        {!hasDelegation && (
          <div className="text-sm text-purple-300 mb-4 p-2 bg-purple-900/20 rounded border border-purple-500/20">
            Create and sign delegation first to authorize DCA.
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            onClick={startDca}
            disabled={busy || !delegatorAddress || !hasDelegation}
            className="px-4 py-2 bg-green-600/50 hover:bg-green-600/70 disabled:bg-gray-600/20 text-white rounded-lg transition-colors text-sm font-medium flex items-center gap-2"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            Start DCA
          </button>
          <button
            onClick={stopDca}
            disabled={busy || !delegatorAddress || !hasDelegation}
            className="px-4 py-2 bg-red-600/50 hover:bg-red-600/70 disabled:bg-gray-600/20 text-white rounded-lg transition-colors text-sm font-medium flex items-center gap-2"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>
            Stop DCA
          </button>
          <button
            onClick={sendMonNative}
            disabled={busy || !delegatorAddress}
            title="Send all native MON balance to EOA (creates value delegation automatically if needed)"
            className="px-4 py-2 bg-blue-600/50 hover:bg-blue-600/70 disabled:bg-gray-600/20 text-white rounded-lg transition-colors text-sm font-medium flex items-center gap-2"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor"><path d="M12 3l4 4h-3v7h-2V7H8zM5 19h14v2H5z"/></svg>
            Withdraw MON
          </button>
          <button
            onClick={convertAllToMon}
            disabled={busy || !delegatorAddress || !hasDelegation}
            className="px-4 py-2 bg-purple-600/50 hover:bg-purple-600/70 disabled:bg-gray-600/20 text-white rounded-lg transition-colors text-sm font-medium flex items-center gap-2"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor"><path d="M12 6v3l4-4-4-4v3C7.6 4 4 7.6 4 12c0 1.1.2 2.1.6 3l1.6-1.2C6.1 13.2 6 12.6 6 12c0-3.3 2.7-6 6-6zm7.4 3l-1.6 1.2c.5.6.6 1.2.6 1.8 0 3.3-2.7 6-6 6v-3l-4 4 4 4v-3c4.4 0 8-3.6 8-8 0-1.1-.2-2.1-.6-3z"/></svg>
            Convert all to MON
          </button>
        </div>
      </div>

      {/* Top-up */}
      <div className="bg-white/5 backdrop-blur-sm rounded-xl p-4 border border-white/10">
        <h3 className="text-lg font-semibold text-white mb-4">Top-up Smart Account</h3>
        <div className="flex gap-2 items-end">
          <label className="flex-1 text-sm text-white/80">
            Amount (USDC or MON):
            <input
              type="number"
              value={topupAmount}
              onChange={(e) => setTopupAmount(e.target.value)}
              min="0"
              step="0.1"
              className="mt-1 w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
            />
          </label>
          <button
            onClick={directTopupUsdc}
            disabled={busy || !delegatorAddress || !address || !topupAmount || parseFloat(topupAmount) <= 0}
            className="px-4 py-2 bg-emerald-600/50 hover:bg-emerald-600/70 disabled:bg-gray-600/20 text-white rounded-lg transition-colors text-sm font-medium flex items-center gap-2"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 5v2.1c1.7.4 3 2 3 3.9h-2c0-1.1-.9-2-2-2-1.2 0-2 .9-2 2 0 1.1.8 1.6 2.2 2.1 2.1.7 3.8 1.5 3.8 3.9 0 1.9-1.3 3.4-3 3.8V21h-2v-2.1c-1.8-.4-3.1-2-3.1-3.9H10c0 1.1.9 2 2 2 1.3 0 2.1-.8 2.1-1.9 0-1.3-.9-1.7-2.7-2.3-2.1-.7-3.3-1.8-3.3-3.7 0-1.8 1.3-3.2 3-3.6V5h2z"/></svg>
            Top-up (USDC)
          </button>
          <button
            onClick={directTopupMon}
            disabled={busy || !delegatorAddress || !address || !topupAmount || parseFloat(topupAmount) <= 0}
            title="Send native MON from EOA to Smart Account"
            className="px-4 py-2 bg-blue-600/50 hover:bg-blue-600/70 disabled:bg-gray-600/20 text-white rounded-lg transition-colors text-sm font-medium flex items-center gap-2"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor"><path d="M12 2l4 8H8l4-8zm0 20l-4-8h8l-4 8z"/></svg>
            Top-up (MON)
          </button>
        </div>
      </div>

      {msg && (
        <div className="p-3 bg-white/5 rounded-lg border border-white/10">
          <pre className="text-xs text-white/80 whitespace-pre-wrap font-mono">{msg}</pre>
        </div>
      )}
    </div>
  );
}
