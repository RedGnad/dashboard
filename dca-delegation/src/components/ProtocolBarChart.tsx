import { useMemo } from 'react'

const COLORS: Record<string, string> = {
  magma: '#ef4444',      // red-500
  ambient: '#fde047',    // light-yellow
  curvance: '#a855f7',   // purple-500
  kuru: '#86efac',       // light-green-300
  pyth: '#eab308',       // yellow-500
  atlantis: '#14b8a6',   // teal-500
  octoswap: '#f59e0b',   // amber-500
  pingu: '#0ea5e9',      // sky-500
}

export type ProtocolBarItem = { protocolId: string; value: number }

type Props = {
  data: ProtocolBarItem[]
  height?: number
}

export default function ProtocolBarChart({ data, height = 220 }: Props) {
  const width = 600
  const padding = { top: 10, right: 10, bottom: 40, left: 50 }
  const innerW = width - padding.left - padding.right
  const h = height
  const innerH = h - padding.top - padding.bottom

  const items = useMemo(() => data.slice().sort((a, b) => a.protocolId.localeCompare(b.protocolId)), [data])
  const computedMax = Math.max(0, ...items.map(it => Number(it.value || 0)))
  const maxVal = computedMax > 0 ? computedMax : 1
  const barCount = items.length
  const barGap = 10
  const barWidth = barCount > 0 ? Math.max(6, (innerW - (barCount - 1) * barGap) / barCount) : 0

  const yPos = (val: number) => padding.top + innerH - (val / maxVal) * innerH

  return (
    <svg viewBox={`0 0 ${width} ${h}`} className="w-full h-auto">
      {/* axes */}
      <line x1={padding.left} y1={padding.top} x2={padding.left} y2={h - padding.bottom} stroke="#444" strokeWidth={1} />
      <line x1={padding.left} y1={h - padding.bottom} x2={width - padding.right} y2={h - padding.bottom} stroke="#444" strokeWidth={1} />
      {/* y ticks */}
      {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
        const raw = maxVal * t
        const v = maxVal < 1 ? Number(raw.toFixed(6)) : Math.round(raw)
        const y = yPos(v)
        return (
          <g key={i}>
            <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke="#333" strokeWidth={0.5} />
            <text x={padding.left - 6} y={y} textAnchor="end" dominantBaseline="middle" fill="#9ca3af" fontSize={10}>{v}</text>
          </g>
        )
      })}

      {/* bars */}
      {items.map((it, idx) => {
        const x = padding.left + idx * (barWidth + barGap)
        const val = Number(it.value || 0)
        const y = yPos(val)
        const color = COLORS[it.protocolId] || '#94a3b8'
        return (
          <g key={it.protocolId}>
            <rect x={x} y={y} width={barWidth} height={padding.top + innerH - y} fill={color} opacity={0.9} />
            <text x={x + barWidth / 2} y={h - padding.bottom + 18} textAnchor="middle" fill="#9ca3af" fontSize={10}>{it.protocolId}</text>
          </g>
        )
      })}
    </svg>
  )
}
