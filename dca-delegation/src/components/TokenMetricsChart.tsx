import { useMemo, useState } from "react";

export type TokenSeries = {
  token: string;
  points: { x: string; y: number }[];
};

type Props = {
  series: TokenSeries[];
  dates: string[];
  height?: number;
  zeroAxis?: boolean;
  overlays?: TokenSeries[];
  volBars?: { x: string; y: number }[];
  showVolume?: boolean;
  selectedToken?: string;
  showOnlySelected?: boolean;
  onSelect?: (token: string) => void;
  logScale?: boolean;
  normalizeMode?: "none" | "rebased" | "median" | "pct";
  unit?: "USD" | "%";
  isMomentum?: boolean;
};

const COLORS: Record<string, string> = {
  USDC: "#3b82f6",
  WMON: "#22c55e",
  CHOG: "#f472b6",
  BEAN: "#f59e0b",
  DAK: "#a855f7",
  YAKI: "#10b981",
  WBTC: "#ef4444",
  PINGU: "#0ea5e9",
  OCTO: "#6366f1",
  KB: "#eab308",
  WSOL: "#14b8a6",
};

function getColor(name: string, i: number) {
  if (COLORS[name]) return COLORS[name];
  const fallback = [
    "#60a5fa",
    "#34d399",
    "#f472b6",
    "#fbbf24",
    "#10b981",
    "#c084fc",
  ];
  return fallback[i % fallback.length];
}

export default function TokenMetricsChart({
  series,
  dates,
  height = 220,
  zeroAxis = false,
  overlays = [],
  volBars = [],
  showVolume = true,
  selectedToken,
  showOnlySelected = false,
  onSelect,
  logScale = false,
  normalizeMode = "none",
  unit = "USD",
  isMomentum = false,
}: Props) {
  const width = 780;
  const h = height;
  const padding = { top: 10, right: 16, bottom: 28, left: 64 };
  const innerW = width - padding.left - padding.right;
  const innerH = h - padding.top - padding.bottom;
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverY, setHoverY] = useState<number | null>(null);
  const rollingWindow = Number(
    (import.meta as any).env?.VITE_CHART_ROLLING_WINDOW ?? 60
  );

  const n = Math.max(1, dates.length);
  const xPos = (idx: number) =>
    padding.left + (n <= 1 ? innerW / 2 : (idx / (n - 1)) * innerW);

  // Precompute date index before any usage
  const dateIndex: Record<string, number> = {};
  dates.forEach((d, i) => {
    dateIndex[d] = i;
  });

  // Transformations: per-token normalization and optional log scale
  const epsilon = 1e-9;
  function logT(v: number) {
    return Math.log10(Math.max(epsilon, v));
  }
  function signedLogT(v: number) {
    // Log scale for momentum: preserve sign but apply log to absolute value
    if (Math.abs(v) < epsilon) return 0;
    const logAbs = Math.log10(Math.abs(v) + 1); // +1 to avoid log(0)
    return v >= 0 ? logAbs : -logAbs;
  }
  function median(arr: number[]) {
    if (!arr.length) return 0;
    const a = arr.slice().sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  // Normalisation modes:
  // - none: valeurs brutes
  // - rebased: divise par le premier point non-nul (comparaison relative)
  // - median: divise par la médiane de la série
  // - pct: ((val/ref) - 1) * 100 where ref is a rolling median of last N points
  const transformed = series.map((s) => {
    const ordered = s.points
      .filter((p) => dateIndex[p.x] !== undefined && Number.isFinite(p.y))
      .sort((a, b) => dateIndex[a.x] - dateIndex[b.x]);
    const first = ordered.find((p) => p.y > 0)?.y ?? 0;
    const ys = ordered
      .map((p) => p.y)
      .filter((v) => Number.isFinite(v) && v > 0);
    const refMedian = ys.length ? median(ys) || 1 : 1;
    const ref =
      normalizeMode === "rebased"
        ? first || refMedian
        : normalizeMode === "median"
        ? refMedian
        : 1;
    // For pct mode, compute a rolling median baseline per timestamp
    let rollingPctByDate: Record<string, number> = {};
    if (normalizeMode === "pct") {
      for (let j = 0; j < ordered.length; j++) {
        const start = Math.max(
          0,
          j - (rollingWindow > 0 ? rollingWindow - 1 : 0)
        );
        const win = ordered
          .slice(start, j + 1)
          .map((p) => p.y)
          .filter((v) => Number.isFinite(v) && v > 0);
        const base = win.length ? median(win) : first || refMedian;
        const y = base > 0 ? (ordered[j].y / base - 1) * 100 : 0;
        rollingPctByDate[ordered[j].x] = y;
      }
    }

    let pts = s.points.map((p) => {
      let y = p.y;
      if (normalizeMode === "rebased" || normalizeMode === "median") {
        y = ref > 0 ? p.y / ref : p.y;
      } else if (normalizeMode === "pct") {
        y = rollingPctByDate[p.x] ?? 0;
      }
      return { x: p.x, y };
    });
    if (logScale) {
      if (isMomentum) {
        // For momentum, use signed log scale to preserve negative values
        pts = pts.map((p) => ({ x: p.x, y: signedLogT(p.y) }));
      } else {
        // For price, use regular log scale (positive values only)
        pts = pts.map((p) => ({ x: p.x, y: p.y > 0 ? logT(p.y) : 0 }));
      }
    }
    return { token: s.token, points: pts };
  });

  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (const s of transformed) {
    for (const p of s.points) {
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }
  }
  if (!isFinite(yMin) || !isFinite(yMax)) {
    yMin = 0;
    yMax = 1;
  }
  if (yMin === yMax) {
    yMin = yMin * 0.9;
    yMax = yMax * 1.1 + (yMax === 0 ? 1 : 0);
  }
  // add 5% padding to y-range for readability
  const pad = (yMax - yMin) * 0.05;
  yMin -= pad;
  yMax += pad;

  const yPos = (val: number) =>
    padding.top + innerH - ((val - yMin) / (yMax - yMin)) * innerH;

  const formatNumber = useMemo(() => {
    const intl = new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: 2,
    });
    return (v: number) => {
      if (!Number.isFinite(v)) return unit === "%" ? "0%" : "$0";
      let core: string;
      if (unit === "%") {
        // pourcentages avec 1 décimale si |v|<100, sinon compact
        if (Math.abs(v) >= 1000) core = intl.format(v);
        else if (Math.abs(v) >= 100) core = v.toFixed(0);
        else core = v.toFixed(1);
        return `${core}%`;
      }
      // USD: plus de précision pour petits prix
      if (Math.abs(v) >= 1000) core = intl.format(v);
      else if (Math.abs(v) >= 100) core = v.toFixed(0);
      else if (Math.abs(v) >= 1) core = v.toFixed(2);
      else if (Math.abs(v) >= 0.01) core = v.toFixed(4);
      else core = v.toFixed(6);
      core = core.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
      return `$${core}`;
    };
  }, [unit]);

  // dateIndex defined above

  function buildPath(points: Array<{ x: string; y: number }>) {
    const pts = points
      .filter((p) => dateIndex[p.x] !== undefined)
      .sort((a, b) => dateIndex[a.x] - dateIndex[b.x]);
    if (pts.length === 0) return "";
    let d = `M ${xPos(dateIndex[pts[0].x]).toFixed(2)} ${yPos(pts[0].y).toFixed(
      2
    )}`;
    for (let i = 1; i < pts.length; i++) {
      const xi = xPos(dateIndex[pts[i].x]).toFixed(2);
      const yi = yPos(pts[i].y).toFixed(2);
      d += ` L ${xi} ${yi}`;
    }
    return d;
  }

  // Volume bars (normalized to 18% of chart height, subtler look)
  const volValues = volBars
    .filter((p) => dateIndex[p.x] !== undefined)
    .sort((a, b) => dateIndex[a.x] - dateIndex[b.x])
    .map((p) => p.y);
  const volMax = volValues.length ? Math.max(...volValues) : 0;
  const barBand = innerH * 0.18;
  const barW =
    n > 1 ? Math.max(1, innerW / (n * 2.2)) : Math.max(1, innerW * 0.85);

  return (
    <div className="w-full">
      <div className="w-full">
        <svg
          viewBox={`0 0 ${width} ${h}`}
          className="w-full h-auto select-none overflow-x-auto"
        >
          <defs>
            <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="2.4" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <line
            x1={padding.left}
            y1={padding.top}
            x2={padding.left}
            y2={h - padding.bottom}
            stroke="#444"
            strokeWidth={1}
          />
          <line
            x1={padding.left}
            y1={h - padding.bottom}
            x2={width - padding.right}
            y2={h - padding.bottom}
            stroke="#444"
            strokeWidth={1}
          />
          {Array.from({ length: 6 }).map((_, i) => {
            const v = yMin + (i / 4) * (yMax - yMin);
            const y = yPos(v);
            return (
              <g key={i}>
                <line
                  x1={padding.left}
                  y1={y}
                  x2={width - padding.right}
                  y2={y}
                  stroke="#333"
                  strokeWidth={0.5}
                />
                <text
                  x={padding.left - 8}
                  y={y}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fill="#9ca3af"
                  fontSize={12}
                >
                  {formatNumber(v)}
                </text>
              </g>
            );
          })}
          {dates.map((d, i) =>
            i % Math.ceil(dates.length / 8) === 0 ? (
              <text
                key={i}
                x={xPos(i)}
                y={h - padding.bottom + 16}
                textAnchor="middle"
                fill="#9ca3af"
                fontSize={11}
              >
                {d}
              </text>
            ) : null
          )}

          {(zeroAxis || normalizeMode === "pct") && 0 >= yMin && 0 <= yMax && (
            <line
              x1={padding.left}
              y1={yPos(0)}
              x2={width - padding.right}
              y2={yPos(0)}
              stroke="#6b7280"
              strokeWidth={1.5}
            />
          )}
          {transformed.map((s, i) => {
            const path = buildPath(s.points);
            const color = getColor(s.token, i);
            const visible =
              !showOnlySelected ||
              (selectedToken ? s.token === selectedToken : true);
            if (!visible) return null;
            return (
              <g key={s.token}>
                <path
                  d={path}
                  fill="none"
                  stroke={color}
                  strokeWidth={6}
                  opacity={0.36}
                  filter="url(#glow)"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ mixBlendMode: "screen" as any }}
                >
                  <animate
                    attributeName="opacity"
                    values="0.34;0.4;0.34"
                    dur="6s"
                    repeatCount="indefinite"
                  />
                </path>
                <path
                  d={path}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            );
          })}

          {showVolume && volBars.length > 0 && volMax > 0 && (
            <g>
              {volBars
                .filter((p) => dateIndex[p.x] !== undefined)
                .map((p, i) => {
                  const idx = dateIndex[p.x];
                  const cx = xPos(idx);
                  const hVal = (p.y / volMax) * barBand;
                  const x = cx - barW / 2;
                  const y = padding.top + innerH - hVal;
                  return (
                    <g key={`vb_${i}`}>
                      <rect
                        x={x}
                        y={y}
                        width={barW}
                        height={hVal}
                        fill="#cbd5e1"
                        opacity={0.12}
                        filter="url(#glow)"
                      />
                      <rect
                        x={x}
                        y={y}
                        width={barW}
                        height={hVal}
                        fill="#334155"
                        opacity={0.35}
                      />
                    </g>
                  );
                })}
            </g>
          )}

          {overlays.map((s) => {
            const path = buildPath(s.points);
            const color = "#9ca3af"; // lighter overlay
            return (
              <g key={s.token + "_overlay"}>
                <path
                  d={path}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeDasharray="6 4"
                />
              </g>
            );
          })}

          {hoverIdx != null && hoverIdx >= 0 && hoverIdx < dates.length && (
            <g>
              <line
                x1={xPos(hoverIdx)}
                y1={padding.top}
                x2={xPos(hoverIdx)}
                y2={h - padding.bottom}
                stroke="#666"
                strokeDasharray="3 3"
              />
              {transformed.map((s, i) => {
                const v = (() => {
                  const d = dates[hoverIdx!];
                  const pt = s.points.find((pt) => pt.x === d);
                  return pt ? pt.y : null;
                })();
                if (v == null) return null;
                const color = getColor(s.token, i);
                return (
                  <circle
                    key={s.token + "_dot"}
                    cx={xPos(hoverIdx)}
                    cy={yPos(v)}
                    r={2}
                    fill={color}
                  />
                );
              })}
            </g>
          )}
          {hoverY != null && hoverY >= yMin && hoverY <= yMax && (
            <g>
              <line
                x1={padding.left}
                y1={yPos(hoverY)}
                x2={width - padding.right}
                y2={yPos(hoverY)}
                stroke="#666"
                strokeDasharray="3 3"
              />
              <text
                x={padding.left - 8}
                y={yPos(hoverY)}
                textAnchor="end"
                dominantBaseline="middle"
                fill="#e5e7eb"
                fontSize={10}
              >
                {formatNumber(hoverY)}
              </text>
            </g>
          )}

          <rect
            x={padding.left}
            y={padding.top}
            width={innerW}
            height={innerH}
            fill="transparent"
            onMouseMove={(e) => {
              const rect = (
                e.currentTarget as SVGRectElement
              ).getBoundingClientRect();
              const x = e.clientX - rect.left;
              const y = e.clientY - rect.top;
              const tx = Math.max(0, Math.min(1, (x - 0) / rect.width));
              const xChart = padding.left + tx * innerW;
              const tChart = Math.max(
                0,
                Math.min(1, (xChart - padding.left) / innerW)
              );
              const idx = Math.round(tChart * Math.max(0, n - 1));
              setHoverIdx(idx);

              const ty = Math.max(0, Math.min(1, (y - 0) / rect.height));
              const yChart = padding.top + ty * innerH;
              const rel = Math.max(
                0,
                Math.min(1, (yChart - padding.top) / innerH)
              );
              const val = yMin + (1 - rel) * (yMax - yMin);
              setHoverY(val);
            }}
            onMouseLeave={() => {
              setHoverIdx(null);
              setHoverY(null);
            }}
          />
        </svg>
      </div>

      <div className="flex flex-wrap gap-3 mt-2 text-xs">
        {transformed.map((s, i) => {
          const color = getColor(s.token, i);
          return (
            <button
              key={s.token}
              type="button"
              className="flex items-center gap-2 hover:opacity-100"
              onClick={() => onSelect?.(s.token)}
              style={{
                opacity: selectedToken && s.token !== selectedToken ? 0.5 : 1,
                cursor: onSelect ? "pointer" : "default",
              }}
            >
              <span
                className="inline-block w-3 h-3 rounded"
                style={{
                  background: color,
                  boxShadow: `0 0 8px ${color}, 0 0 2px ${color}`,
                }}
                aria-label={s.token}
              />
              <span className="text-gray-300">{s.token}</span>
              {hoverIdx != null &&
                hoverIdx >= 0 &&
                hoverIdx < dates.length &&
                (() => {
                  const d = dates[hoverIdx];
                  const pt = s.points.find((pt) => pt.x === d);
                  return pt ? (
                    <span className="text-white">{formatNumber(pt.y)}</span>
                  ) : null;
                })()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
