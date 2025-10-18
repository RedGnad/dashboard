import { useEffect, useMemo, useState } from 'react'

interface Props {
  open: boolean
  symbol: string
  decimals: number
  balance: string
  isLoading?: boolean
  onClose: () => void
  onConfirm: (amount: string) => Promise<void> | void
}

export default function WithdrawModal({ open, symbol, decimals, balance, isLoading, onClose, onConfirm }: Props) {
  const [amount, setAmount] = useState<string>('')
  const [percent, setPercent] = useState<number>(0)

  useEffect(() => {
    if (!open) {
      setAmount('')
      setPercent(0)
    }
  }, [open])

  const balNum = useMemo(() => {
    const n = parseFloat(balance || '0')
    return Number.isFinite(n) ? n : 0
  }, [balance])

  useEffect(() => {
    // keep amount and percent in sync when percent changes
    if (balNum > 0) {
      const v = (balNum * (percent / 100))
      // limit to token decimals (display only)
      const fixed = v.toFixed(Math.min(decimals, 8))
      setAmount(fixed)
    } else {
      setAmount('0')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [percent])

  const onAmountChange = (v: string) => {
    setAmount(v)
    const n = parseFloat(v || '0')
    if (balNum > 0) {
      const p = Math.max(0, Math.min(100, Math.round((n / balNum) * 100)))
      setPercent(p)
    } else {
      setPercent(0)
    }
  }

  const setPct = (p: number) => {
    setPercent(p)
  }

  const disabled = useMemo(() => {
    const n = parseFloat(amount || '0')
    if (!Number.isFinite(n)) return true
    if (n <= 0) return true
    if (n > balNum + 1e-12) return true
    return !!isLoading
  }, [amount, balNum, isLoading])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative glass rounded-2xl w-full max-w-md p-5">
        <div className="text-lg font-semibold text-white mb-3">Withdraw {symbol}</div>
        <div className="text-sm text-gray-300 mb-2">Balance: <span className="text-white font-mono">{balance}</span></div>

        <div className="mb-3">
          <label className="block text-xs text-gray-300 mb-1">Amount</label>
          <input 
            type="number" 
            inputMode="decimal" 
            step="any" 
            value={amount} 
            onChange={(e)=>onAmountChange(e.target.value)} 
            className="w-full bg-zinc-900/50 border border-zinc-600 rounded-lg px-3 py-2 text-white"
            placeholder="0.0"
          />
        </div>

        <div className="mb-3">
          <input 
            type="range" 
            min={0} 
            max={100} 
            step={1} 
            value={percent} 
            onChange={(e)=>setPct(parseInt(e.target.value))}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-gray-400 mt-1">
            <span>0%</span>
            <span>{percent}%</span>
            <span>100%</span>
          </div>
        </div>

        <div className="flex gap-2 mb-4">
          <button onClick={()=>setPct(25)} className="px-2 py-1 text-xs rounded bg-white/10 text-gray-200 hover:text-white">25%</button>
          <button onClick={()=>setPct(50)} className="px-2 py-1 text-xs rounded bg-white/10 text-gray-200 hover:text-white">50%</button>
          <button onClick={()=>setPct(75)} className="px-2 py-1 text-xs rounded bg-white/10 text-gray-200 hover:text-white">75%</button>
          <button onClick={()=>setPct(100)} className="px-2 py-1 text-xs rounded bg-white/10 text-gray-200 hover:text-white">ALL</button>
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-white/10 text-gray-200 hover:text-white">Cancel</button>
          <button 
            onClick={()=>onConfirm(amount)} 
            disabled={disabled}
            className="px-4 py-2 rounded-lg bg-gradient-to-r from-pink-600 to-rose-600 text-white font-semibold disabled:opacity-50"
          >
            {isLoading ? 'Processing…' : 'Withdraw'}
          </button>
        </div>
      </div>
    </div>
  )
}
