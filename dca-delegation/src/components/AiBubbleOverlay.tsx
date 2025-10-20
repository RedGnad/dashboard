import { useEffect, useMemo, useState } from 'react'
import { useAutonomousAi } from '../hooks/useAutonomousAi'
import { useDcaDelegation } from '../hooks/useDcaDelegation'
import { isDelegationExpired } from '../lib/delegation'

export default function AiBubbleOverlay() {
  const { decisions } = useAutonomousAi()
  const { isInitialized, signedDelegation } = useDcaDelegation()
  const [mounted, setMounted] = useState(false)
  const [phase, setPhase] = useState<'hidden'|'enter'|'visible'|'exit'>('hidden')
  const latest = useMemo(() => {
    if (!decisions?.length) return null
    // Pick most recent decision
    return decisions[0]
  }, [decisions])

  useEffect(() => {
    if (!latest || !isInitialized || !signedDelegation || isDelegationExpired(signedDelegation)) return
    setMounted(true)
    setPhase('enter')
    const t1 = setTimeout(() => setPhase('visible'), 20)
    const t2 = setTimeout(() => setPhase('exit'), 5600)
    const t3 = setTimeout(() => { setMounted(false); setPhase('hidden') }, 6000)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [latest?.id, isInitialized, signedDelegation])

  if (!latest || !mounted || !isInitialized || !signedDelegation || isDelegationExpired(signedDelegation)) return null

  const reasoning = (latest as any)?.action?.reasoning || ''
  const summary = (() => {
    const a: any = latest.action
    switch (a?.type) {
      case 'BUY': return `BUY ${a.amount ?? ''} ${a.sourceToken ?? ''} → ${a.targetToken ?? ''}`
      case 'SELL_TO_MON': return `SELL ${a.amount ?? ''} ${a.fromToken ?? ''} → MON`
      case 'SELL_TO_USDC': return `SELL ${a.amount ?? ''} ${a.fromToken ?? ''} → USDC`
      case 'HOLD': return `HOLD for ${(a?.duration ?? latest.nextInterval) || 0}s`
      default: return String(a?.type || '')
    }
  })()

  const style: React.CSSProperties = (
    phase === 'enter' ? { opacity: 0, transform: 'translateY(16px)', transition: 'opacity 240ms ease, transform 240ms ease' } :
    phase === 'visible' ? { opacity: 1, transform: 'translateY(0)', transition: 'opacity 240ms ease, transform 240ms ease' } :
    { opacity: 0, transform: 'translateY(-12px)', transition: 'opacity 220ms ease, transform 220ms ease' }
  )

  return (
    <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 w-[560px] h-[560px]">
      <div className="absolute top-2 right-2 max-w-[260px]" style={style}>
        <div className="relative pointer-events-none rounded-xl px-3 py-2 text-xs leading-snug text-white/90 bg-black/50 backdrop-blur-md border border-white/10 shadow-[0_0_20px_rgba(124,58,237,0.25)]">
          <div className="font-semibold text-[11px] text-purple-300 mb-1">AI</div>
          <div className="text-[12px] text-white mb-1">{summary}</div>
          {reasoning && <div className="text-[11px] text-gray-300 line-clamp-4">{reasoning}</div>}
          <span className="absolute -top-2 -right-2 px-2 py-0.5 rounded-full text-[10px] bg-purple-400/20 text-purple-200 border border-purple-400/30">
            Last Decision
          </span>
        </div>
      </div>
    </div>
  )
}
