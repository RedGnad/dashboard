import React from 'react';

type Balances = {
  USDC?: string | number;
  MON?: string | number;
  WMON?: string | number;
};

interface BalanceBarProps {
  title: string;
  icon?: 'wallet' | 'shield' | string;
  address?: string;
  balances?: Balances;
  progressPercentage?: number;
  gradient?: 'red' | 'blue' | 'green' | 'purple';
  onRefresh?: () => void | Promise<void>;
  isRefreshing?: boolean;
}

function shortAddr(a?: string) {
  if (!a) return '—';
  return a.slice(0, 6) + '…' + a.slice(-4);
}

export default function BalanceBar({
  title,
  icon = 'wallet',
  address,
  balances = {},
  progressPercentage = 0,
  gradient = 'blue',
  onRefresh,
  isRefreshing,
}: BalanceBarProps) {
  const [copied, setCopied] = React.useState(false);
  const g = {
    red: 'from-rose-500 to-red-600',
    blue: 'from-sky-500 to-indigo-600',
    green: 'from-emerald-500 to-green-600',
    purple: 'from-fuchsia-500 to-purple-600',
  }[gradient] || 'from-sky-500 to-indigo-600';

  const pct = Math.max(0, Math.min(100, Number.isFinite(progressPercentage) ? progressPercentage : 0));

  return (
    <div className="min-w-[320px] w-[380px] select-none">
      <div className="backdrop-blur-md bg-white/10 border border-white/20 rounded-2xl shadow-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center border border-white/20 text-white/90">
              {icon === 'shield' ? (
                <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
                  <path d="M12 2l7 3v6c0 5-3.8 9.7-7 11-3.2-1.3-7-6-7-11V5l7-3z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
                  <path d="M21 7H3V5h18v2zm0 4H3v8h18v-8zM5 13h6v4H5v-4z" />
                </svg>
              )}
            </div>
            <div>
              <div className="text-white font-semibold leading-tight">{title}</div>
              <button
                type="button"
                onClick={async () => {
                  if (!address) return;
                  try {
                    await navigator.clipboard.writeText(address);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  } catch {}
                }}
                title={address ? 'Click to copy' : ''}
                className="text-white/60 hover:text-white/80 transition-colors text-xs font-mono underline-offset-2 hover:underline"
              >
                {copied ? 'Copied' : shortAddr(address)}
              </button>
            </div>
          </div>
          {onRefresh && (
            <button
              onClick={onRefresh}
              title="Refresh balances"
              className="px-2 py-1 rounded-lg text-xs border border-white/20 text-white/80 hover:text-white hover:border-white/40 transition"
            >
              {isRefreshing ? '…' : 'Refresh'}
            </button>
          )}
        </div>

        <div className="h-2 rounded-full bg-white/10 overflow-hidden">
          <div
            className={`h-full bg-gradient-to-r ${g}`}
            style={{ width: `${pct}%` }}
          />
        </div>

        <div className="grid grid-cols-3 gap-2 text-xs text-white/80 mt-3">
          <div className="bg-white/5 border border-white/10 rounded-lg p-2">
            <div className="opacity-70">USDC</div>
            <div className="font-mono text-white">{balances.USDC ?? '—'}</div>
          </div>
          <div className="bg-white/5 border border-white/10 rounded-lg p-2">
            <div className="opacity-70">MON</div>
            <div className="font-mono text-white">{balances.MON ?? '—'}</div>
          </div>
          <div className="bg-white/5 border border-white/10 rounded-lg p-2">
            <div className="opacity-70">WMON</div>
            <div className="font-mono text-white">{balances.WMON ?? '—'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
