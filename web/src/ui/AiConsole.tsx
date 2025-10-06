import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type AiDecisionEntry = {
  actionId: string;
  ts: number;
  aiActionType?: string;
  aiRiskScore?: number;
  aiConfidence?: number;
  aiRationaleHash?: string;
  strategyEngineVersion?: string;
  rollingHash?: string;
  prevEntryHash?: string;
};

interface HistoryResponse {
  ok: boolean;
  entries: AiDecisionEntry[];
  nextCursor: string | null;
  eof: boolean;
  total: number;
}

function formatTime(ms: number) {
  const d = new Date(ms);
  return d.toLocaleTimeString();
}

export const AiConsole: React.FC<{ apiBase?: string; auto?: boolean }> = ({
  apiBase,
  auto = true,
}) => {
  console.log("[AiConsole] mount apiBase=", apiBase);
  const base = useMemo(
    () =>
      (
        apiBase ||
        (import.meta as any)?.env?.VITE_API_BASE ||
        "http://127.0.0.1:8787"
      ).replace(/\/$/, ""),
    [apiBase]
  );
  const [entries, setEntries] = useState<AiDecisionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [eof, setEof] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const timerRef = useRef<number | null>(null);

  const fetchPage = useCallback(
    async (reset = false) => {
      if (loading) return;
      setLoading(true);
      try {
        const q = new URL(base + "/api/strategy/history");
        q.searchParams.set("limit", "50");
        if (!reset && cursor) q.searchParams.set("cursor", cursor);
        const res = await fetch(q.toString());
        const js: HistoryResponse = await res.json();
        if (!js.ok) throw new Error("history_failed");
        if (reset) {
          setEntries(js.entries);
        } else {
          // Append only new ones (avoid duplicates if server re-sends overlap)
          setEntries((prev) => {
            const existing = new Set(prev.map((e) => e.actionId));
            const merged = [...prev];
            for (const e of js.entries)
              if (!existing.has(e.actionId)) merged.push(e);
            return merged.sort((a, b) => a.ts - b.ts);
          });
        }
        setCursor(js.nextCursor);
        setEof(js.eof);
        setError(null);
      } catch (e: any) {
        setError(e?.message || "load_failed");
      } finally {
        setLoading(false);
      }
    },
    [base, cursor, loading]
  );

  // Auto-refresh latest page (not full reload) every 15s
  useEffect(() => {
    if (!auto) return;
    timerRef.current && clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => {
      setRefreshTick((t) => t + 1);
    }, 15000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [auto]);

  // On tick, re-fetch only latest page by resetting cursor to null? Instead we just try to append from current cursor (which is last end). If eof true, ask again using last cursor (cursor is null when eof?)
  useEffect(() => {
    if (!auto) return;
    // Strategy: if eof reached, just poll again (server will return empty slice and eof=true)
    fetchPage(false);
  }, [refreshTick]);

  // Initial load
  useEffect(() => {
    fetchPage(true);
  }, [base]);

  const stats = useMemo(() => {
    const total = entries.length;
    let swaps = 0,
      skips = 0;
    let avgRisk = 0,
      avgConfidence = 0;
    for (const e of entries) {
      if (e.aiActionType === "DCA_SWAP" || e.aiActionType === "TRADE_BUY")
        swaps++;
      else if (e.aiActionType === "SKIP" || e.aiActionType === "HOLD") skips++;
      if (typeof e.aiRiskScore === "number") avgRisk += e.aiRiskScore;
      if (typeof e.aiConfidence === "number") avgConfidence += e.aiConfidence;
    }
    avgRisk = total ? avgRisk / total : 0;
    avgConfidence = total ? avgConfidence / total : 0;
    return { total, swaps, skips, avgRisk, avgConfidence };
  }, [entries]);

  return (
    <div
      style={{
        border: "2px solid #2266dd",
        boxShadow: "0 0 0 2px #2266dd22",
        borderRadius: 10,
        padding: 14,
        background: "linear-gradient(135deg,#fff,#f5f9ff)",
        marginTop: 32,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <strong style={{ fontSize: 16 }}>AI Decisions (live)</strong>
        <div style={{ fontSize: 12, color: "#555" }}>
          Total: {stats.total} • Swaps/Buys: {stats.swaps} • Skips/Hold:{" "}
          {stats.skips} • AvgRisk: {stats.avgRisk.toFixed(1)} • AvgConf:{" "}
          {stats.avgConfidence.toFixed(2)}
        </div>
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
        <button
          onClick={() => {
            setCursor(null);
            fetchPage(true);
          }}
          disabled={loading}
        >
          Reload
        </button>
        <button onClick={() => fetchPage(false)} disabled={loading || eof}>
          Load more
        </button>
        {eof && <span style={{ fontSize: 11, color: "#666" }}>EOF</span>}
        {loading && <span style={{ fontSize: 11 }}>Loading…</span>}
        {error && (
          <span style={{ fontSize: 11, color: "#b00" }}>Err: {error}</span>
        )}
      </div>
      <div
        style={{
          marginTop: 12,
          maxHeight: 300,
          overflow: "auto",
          fontSize: 12,
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", background: "#f6f8fa" }}>
              <th
                style={{ padding: "4px 6px", borderBottom: "1px solid #ddd" }}
              >
                Time
              </th>
              <th
                style={{ padding: "4px 6px", borderBottom: "1px solid #ddd" }}
              >
                Action
              </th>
              <th
                style={{ padding: "4px 6px", borderBottom: "1px solid #ddd" }}
              >
                Risk
              </th>
              <th
                style={{ padding: "4px 6px", borderBottom: "1px solid #ddd" }}
              >
                Confidence
              </th>
              <th
                style={{ padding: "4px 6px", borderBottom: "1px solid #ddd" }}
              >
                Rationale Hash
              </th>
              <th
                style={{ padding: "4px 6px", borderBottom: "1px solid #ddd" }}
              >
                Rolling Hash
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.actionId} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "3px 6px", whiteSpace: "nowrap" }}>
                  {formatTime(e.ts)}
                </td>
                <td style={{ padding: "3px 6px" }}>{e.aiActionType || "—"}</td>
                <td style={{ padding: "3px 6px" }}>{e.aiRiskScore ?? "—"}</td>
                <td style={{ padding: "3px 6px" }}>
                  {typeof e.aiConfidence === "number"
                    ? e.aiConfidence.toFixed(2)
                    : "—"}
                </td>
                <td
                  style={{
                    padding: "3px 6px",
                    fontFamily: "monospace",
                    maxWidth: 130,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {e.aiRationaleHash?.slice(0, 18)}…
                </td>
                <td
                  style={{
                    padding: "3px 6px",
                    fontFamily: "monospace",
                    maxWidth: 130,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {e.rollingHash?.slice(0, 18)}…
                </td>
              </tr>
            ))}
            {!entries.length && !loading && (
              <tr>
                <td
                  colSpan={6}
                  style={{ padding: 8, textAlign: "center", color: "#666" }}
                >
                  Aucune décision encore
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: "#777" }}>
        Auto-refresh 15s • Données source: /api/strategy/history • Intégrité via
        rollingHash
      </div>
    </div>
  );
};

export default AiConsole;
