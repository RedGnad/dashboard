import { useMemo, useState } from 'react'

export type TokenSeries = {
  token: string
  points: { x: string; y: number }[]
}

type Props = {
  series: TokenSeries[]
  dates: string[]
  height?: number
}

const COLORS: Record<string, string> = {
  USDC: '#3b82f6',
  WMON: '#22c55e',
  CHOG: '#f472b6',
  BEAN: '#f59e0b',
  DAK: '#a855f7',
  YAKI: '#10b981',
  WBTC: '#ef4444',
  PINGU: '#0ea5e9',
  OCTO: '#6366f1',
  KB: '#eab308',
  WSOL: '#14b8a6',
}

function getColor(name: string, i: number) {
  if (COLORS[name]) return COLORS[name]
  const fallback = ['#60a5fa', '#34d399', '#f472b6', '#fbbf24', '#10b981', '#c084fc']
  return fallback[i % fallback.length]
}

export default function TokenMetricsChart({ series, dates, height = 220 }: Props) {
  const width = 640
  const h = height
  const padding = { top: 10, right: 12, bottom: 22, left: 48 }
  const innerW = width - padding.left - padding.right
  const innerH = h - padding.top - padding.bottom
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const [hoverY, setHoverY] = useState<number | null>(null)

  const n = Math.max(1, dates.length)
  const xPos = (idx: number) => padding.left + (n <= 1 ? innerW / 2 : (idx / (n - 1)) * innerW)

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

  const formatNumber = useMemo(() => {
    const intl = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 })
    return (v: number) => {
      if (!Number.isFinite(v)) return '0'
      if (Math.abs(v) >= 1000) return intl.format(v)
      if (Math.abs(v) >= 100) return v.toFixed(0)
      return v.toFixed(2).replace(/\.0+$/,'').replace(/(\.\d*?)0+$/,'$1')
    }
  }, [])

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
      <svg viewBox={`0 0 ${width} ${h}`} className="w-full h-auto select-none">
        <line x1={padding.left} y1={padding.top} x2={padding.left} y2={h - padding.bottom} stroke="#444" strokeWidth={1}/>
        <line x1={padding.left} y1={h - padding.bottom} x2={width - padding.right} y2={h - padding.bottom} stroke="#444" strokeWidth={1}/>
        {Array.from({ length: 5 }).map((_, i) => {
          const v = yMin + (i / 4) * (yMax - yMin)
          const y = yPos(v)
          return (
            <g key={i}>
              <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke="#333" strokeWidth={0.5}/>
              <text x={padding.left - 8} y={y} textAnchor="end" dominantBaseline="middle" fill="#9ca3af" fontSize={10}>
                {formatNumber(v)}
              </text>
            </g>
          )
        })}
        {dates.map((d, i) => (i % Math.ceil(dates.length / 6) === 0) ? (
          <text key={i} x={xPos(i)} y={h - padding.bottom + 14} textAnchor="middle" fill="#9ca3af" fontSize={9}>
            {d.slice(5)}
          </text>
        ) : null)}

        {series.map((s, i) => {
          const path = buildPath(s.points)
          const color = getColor(s.token, i)
          return (
            <g key={s.token}>
              <path d={path} fill="none" stroke={color} strokeWidth={2} />
            </g>
          )
        })}

        {hoverIdx != null && hoverIdx >= 0 && hoverIdx < dates.length && (
          <g>
            <line x1={xPos(hoverIdx)} y1={padding.top} x2={xPos(hoverIdx)} y2={h - padding.bottom} stroke="#666" strokeDasharray="3 3" />
            {series.map((s, i) => {
              const v = (() => {
                const d = dates[hoverIdx!]
                const pt = s.points.find(pt => pt.x === d)
                return pt ? pt.y : null
              })()
              if (v == null) return null
              const color = getColor(s.token, i)
              return <circle key={s.token+"_dot"} cx={xPos(hoverIdx)} cy={yPos(v)} r={2} fill={color} />
            })}
          </g>
        )}
        {hoverY != null && hoverY >= yMin && hoverY <= yMax && (
          <g>
            <line x1={padding.left} y1={yPos(hoverY)} x2={width - padding.right} y2={yPos(hoverY)} stroke="#666" strokeDasharray="3 3" />
            <text x={padding.left - 8} y={yPos(hoverY)} textAnchor="end" dominantBaseline="middle" fill="#e5e7eb" fontSize={10}>{formatNumber(hoverY)}</text>
          </g>
        )}

        <rect x={padding.left} y={padding.top} width={innerW} height={innerH} fill="transparent"
          onMouseMove={(e)=>{
            const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect()
            const x = e.clientX - rect.left
            const y = e.clientY - rect.top
            const tx = Math.max(0, Math.min(1, (x - 0) / rect.width))
            const xChart = padding.left + tx * innerW
            const tChart = Math.max(0, Math.min(1, (xChart - padding.left) / innerW))
            const idx = Math.round(tChart * Math.max(0, (n - 1)))
            setHoverIdx(idx)

            const ty = Math.max(0, Math.min(1, (y - 0) / rect.height))
            const yChart = padding.top + ty * innerH
            const rel = Math.max(0, Math.min(1, (yChart - padding.top) / innerH))
            const val = yMin + (1 - rel) * (yMax - yMin)
            setHoverY(val)
          }}
          onMouseLeave={()=>{ setHoverIdx(null); setHoverY(null) }}
        />
      </svg>

      <div className="flex flex-wrap gap-3 mt-2 text-xs">
        {series.map((s, i) => (
          <div key={s.token} className="flex items-center gap-2">
            <span className="inline-block w-3 h-3 rounded" style={{ background: getColor(s.token, i) }} />
            <span className="text-gray-300">{s.token}</span>
            {hoverIdx != null && hoverIdx >= 0 && hoverIdx < dates.length && (() => {
              const d = dates[hoverIdx]
              const pt = s.points.find(pt => pt.x === d)
              return pt ? <span className="text-white">{formatNumber(pt.y)}</span> : null
            })()}
          </div>
        ))}
      </div>
    </div>
  )
}
