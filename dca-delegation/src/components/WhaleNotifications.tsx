import { useMemo } from 'react'
import { useWhaleAlerts } from '../hooks/useWhaleAlerts'
import { TOKENS } from '../lib/tokens'

function addrToSymbol(addr: string) {
  const a = addr.toLowerCase()
  for (const t of Object.values(TOKENS)) {
    if (t.address.toLowerCase() === a) return t.symbol
  }
  if (a === '0x0000000000000000000000000000000000000000') return 'MON'
  return a.slice(0,6)+'...'+a.slice(-4)
}

function formatAmount(addr: string, raw: string) {
  try {
    const a = addr.toLowerCase()
    let decimals = 18
    for (const t of Object.values(TOKENS)) {
      if (t.address.toLowerCase() === a) { decimals = t.decimals; break }
    }
    const n = Number(raw) / Math.pow(10, decimals)
    if (!isFinite(n)) return raw
    if (n >= 1) {
      return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)
    }
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(n)
  } catch {
    return raw
  }
}

export default function WhaleNotifications() {
  const { unseen, dismiss } = useWhaleAlerts()
  const visible = unseen.length > 0

  const items = useMemo(() => unseen.slice(0, 4), [unseen])

  if (!visible) return null

  return (
    <div className="fixed top-4 right-4 z-50 w-80 space-y-2">
      {items.map((a) => (
        <div key={a.tx} className="glass rounded-xl p-3 border border-amber-500/30 bg-amber-500/10 shadow">
          <div className="flex items-center justify-between mb-1">
            <div className="text-sm text-white font-semibold">Whale movement</div>
            <button onClick={() => dismiss(a.tx)} className="text-xs text-gray-300 hover:text-white">Dismiss</button>
          </div>
          <div className="text-sm text-gray-200">
            <div className="flex justify-between"><span>Token</span><span className="font-mono text-white">{addrToSymbol(a.token)}</span></div>
            <div className="flex justify-between"><span>Amount</span><span className="font-mono text-white">{formatAmount(a.token, a.value)}</span></div>
            <div className="flex justify-between"><span>From</span><span className="font-mono">{a.from.slice(0,6)}...{a.from.slice(-4)}</span></div>
            <div className="flex justify-between"><span>To</span><span className="font-mono">{a.to.slice(0,6)}...{a.to.slice(-4)}</span></div>
          </div>
          <a href={`https://testnet.monadexplorer.com/tx/${a.tx}`} target="_blank" rel="noreferrer" className="text-xs text-blue-400 hover:text-blue-300">View tx</a>
        </div>
      ))}
      {unseen.length > items.length && (
        <div className="glass rounded-xl p-2 text-xs text-gray-300 text-center">+{unseen.length - items.length} more</div>
      )}
    </div>
  )
}
