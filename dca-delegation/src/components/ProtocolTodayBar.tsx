import { useMemo } from 'react'
import type { ProtocolToday } from '../hooks/useTodayProtocolMetrics'

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

type Props = {
  data: ProtocolToday[]
  metric: 'usersDaily' | 'txDaily'
  height?: number
}

export default function ProtocolTodayBar({ data, metric, height = 220 }: Props) {
  const width = 600
  const padding = { top: 10, right: 10, bottom: 40, left: 50 }
  const innerW = width - padding.left - padding.right
  const h = height
  const innerH = h - padding.top - padding.bottom

  const items = useMemo(() => data.slice().sort((a, b) => a.protocolId.localeCompare(b.protocolId)), [data])
  const sums = items.map(it => Number(it[metric] || 0))
  const total = Math.max(0, sums.reduce((a, b) => a + b, 0))

  const yPos = (val: number) => padding.top + innerH - (total === 0 ? 0 : (val / total) * innerH)
  const barWidth = Math.min(80, innerW * 0.5)
  const x = padding.left + (innerW - barWidth) / 2

  // Build stacked segments
  let acc = 0
  const segments = items.map(it => {
    const v = Number(it[metric] || 0)
    const yTop = yPos(acc + v)
    const yBottom = yPos(acc)
    const heightSeg = Math.max(0, yBottom - yTop)
    const seg = { protocolId: it.protocolId, v, y: yTop, h: heightSeg, color: COLORS[it.protocolId] || '#94a3b8' }
    acc += v
    return seg
  })

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${width} ${h}`} className="w-full h-auto">
        {/* axes */}
        <line x1={padding.left} y1={padding.top} x2={padding.left} y2={h - padding.bottom} stroke="#444" strokeWidth={1} />
        <line x1={padding.left} y1={h - padding.bottom} x2={width - padding.right} y2={h - padding.bottom} stroke="#444" strokeWidth={1} />

        {/* y labels: show total and 0 */}
        <text x={padding.left - 6} y={padding.top} textAnchor="end" dominantBaseline="hanging" fill="#9ca3af" fontSize={10}>{total}</text>
        <text x={padding.left - 6} y={h - padding.bottom} textAnchor="end" dominantBaseline="alphabetic" fill="#9ca3af" fontSize={10}>0</text>

        {/* stacked column */}
        <rect x={x} y={padding.top} width={barWidth} height={innerH} fill="#1f2937" opacity={0.3} />
        {segments.map(seg => (
          seg.h > 0 ? <rect key={seg.protocolId} x={x} y={seg.y} width={barWidth} height={seg.h} fill={seg.color} /> : null
        ))}

        {/* x label */}
        <text x={x + barWidth / 2} y={h - padding.bottom + 18} textAnchor="middle" fill="#9ca3af" fontSize={11}>Today</text>
      </svg>

      {/* legend */}
      <div className="flex flex-wrap gap-3 mt-2 text-xs">
        {items.map((it) => (
          <div key={it.protocolId} className="flex items-center gap-2">
            <span className="inline-block w-3 h-3 rounded" style={{ background: COLORS[it.protocolId] || '#94a3b8' }} />
            <span className="text-gray-300">{it.protocolId}</span>
            <span className="text-gray-500">{Number(it[metric] || 0)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
