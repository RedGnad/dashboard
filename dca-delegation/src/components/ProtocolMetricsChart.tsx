import type { ProtocolSeries } from '../hooks/useProtocolDailyMetrics'

type Props = {
  series: ProtocolSeries[]
  dates: string[]
  height?: number
}

const COLORS: Record<string, string> = {
  magma: '#ef4444',     // red-500
  ambient: '#22c55e',   // green-500
  curvance: '#a855f7',  // purple-500
  dex: '#f59e0b',       // amber-500
}

function getColor(name: string, i: number) {
  if (COLORS[name]) return COLORS[name]
  const fallback = ['#60a5fa', '#34d399', '#f472b6', '#fbbf24', '#10b981', '#c084fc']
  return fallback[i % fallback.length]
}

export default function ProtocolMetricsChart({ series, dates, height = 220 }: Props) {
  const width = 600
  const h = height
  const padding = { top: 10, right: 10, bottom: 20, left: 30 }
  const innerW = width - padding.left - padding.right
  const innerH = h - padding.top - padding.bottom

  // Build x indices
  const n = Math.max(1, dates.length)
  const xPos = (idx: number) => padding.left + (n <= 1 ? innerW / 2 : (idx / (n - 1)) * innerW)

  // Determine global y range
  let yMin = Number.POSITIVE_INFINITY
  let yMax = Number.NEGATIVE_INFINITY
  for (const s of series) {
    for (const p of s.points) {
      if (p.y < yMin) yMin = p.y
      if (p.y > yMax) yMax = p.y
    }
  }
  if (!isFinite(yMin) || !isFinite(yMax)) { yMin = 0; yMax = 1 }
  if (yMin === yMax) { yMin = 0; yMax = yMax || 1 }

  const yPos = (val: number) => padding.top + innerH - ((val - yMin) / (yMax - yMin)) * innerH

  // Date index map
  const dateIndex: Record<string, number> = {}
  dates.forEach((d, i) => { dateIndex[d] = i })

  function buildPath(points: Array<{ x: string; y: number }>) {
    const pts = points
      .filter(p => dateIndex[p.x] !== undefined)
      .sort((a, b) => dateIndex[a.x] - dateIndex[b.x])
    if (pts.length === 0) return ''
    let d = `M ${xPos(dateIndex[pts[0].x]).toFixed(2)} ${yPos(pts[0].y).toFixed(2)}`
    for (let i = 1; i < pts.length; i++) {
      const xi = xPos(dateIndex[pts[i].x]).toFixed(2)
      const yi = yPos(pts[i].y).toFixed(2)
      d += ` L ${xi} ${yi}`
    }
    return d
  }

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${width} ${h}`} className="w-full h-auto">
        {/* Axes */}
        <line x1={padding.left} y1={padding.top} x2={padding.left} y2={h - padding.bottom} stroke="#444" strokeWidth={1}/>
        <line x1={padding.left} y1={h - padding.bottom} x2={width - padding.right} y2={h - padding.bottom} stroke="#444" strokeWidth={1}/>
        {/* Y ticks */}
        {Array.from({ length: 4 }).map((_, i) => {
          const v = yMin + (i / 3) * (yMax - yMin)
          const y = yPos(v)
          return (
            <g key={i}>
              <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke="#333" strokeWidth={0.5}/>
              <text x={padding.left - 6} y={y} textAnchor="end" dominantBaseline="middle" fill="#9ca3af" fontSize={10}>
                {Number.isFinite(v) ? v.toFixed(2) : '0'}
              </text>
            </g>
          )
        })}
        {/* X labels (sparse) */}
        {dates.map((d, i) => (i % Math.ceil(dates.length / 6) === 0) ? (
          <text key={i} x={xPos(i)} y={h - padding.bottom + 14} textAnchor="middle" fill="#9ca3af" fontSize={9}>
            {d.slice(5)}
          </text>
        ) : null)}

        {/* Series */}
        {series.map((s, i) => {
          const path = buildPath(s.points)
          const color = getColor(s.protocolId, i)
          return (
            <g key={s.protocolId}>
              <path d={path} fill="none" stroke={color} strokeWidth={2} />
            </g>
          )
        })}
      </svg>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mt-2 text-xs">
        {series.map((s, i) => (
          <div key={s.protocolId} className="flex items-center gap-2">
            <span className="inline-block w-3 h-3 rounded" style={{ background: getColor(s.protocolId, i) }} />
            <span className="text-gray-300">{s.protocolId}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
