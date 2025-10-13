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
  featureHash?: string;
  featureSchemaVersion?: number | null;
  // Provenance extras (optional, present when backend provides inference provenance)
  inferenceProvider?: string | null;
  inferenceProofHash?: string | null;
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

export const AiConsole: React.FC<{
  apiBase?: string;
  auto?: boolean;
  delegator?: string;
}> = ({ apiBase, auto = true, delegator }) => {
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
        // We prefer fetching the most recent items directly (tail) to avoid scanning the full log.
        // Ask last 120 items to have a small buffer, then cap to 100 in UI.
        if (reset) {
          q.searchParams.set("tail", "120");
        } else {
          q.searchParams.set("limit", "80");
        }
        if (delegator && /^0x[0-9a-fA-F]{40}$/.test(delegator)) {
          q.searchParams.set("delegator", delegator);
        }
        if (!reset && cursor) q.searchParams.set("cursor", cursor);
        const res = await fetch(q.toString());
        const js: HistoryResponse = await res.json();
        if (!js.ok) throw new Error("history_failed");
        const merge = (prev: AiDecisionEntry[], next: AiDecisionEntry[]) => {
          const existing = new Set(prev.map((e) => e.actionId));
          const merged = [...prev];
          for (const e of next) if (!existing.has(e.actionId)) merged.push(e);
          // Sort newest first, then cap to 100
          merged.sort((a, b) => b.ts - a.ts);
          return merged.slice(0, 100);
        };
        if (reset) setEntries((_) => merge([], js.entries));
        else setEntries((prev) => merge(prev, js.entries));
        setCursor(js.nextCursor);
        setEof(js.eof);
        setError(null);
      } catch (e: any) {
        setError(e?.message || "load_failed");
      } finally {
        setLoading(false);
      }
    },
    [base, cursor, loading, delegator]
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
  }, [base, delegator]);

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
      <div
        style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}
      >
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
        {/* Optional: quick download of the current 100 entries as JSON */}
        <button
          onClick={() => {
            const blob = new Blob([JSON.stringify(entries, null, 2)], {
              type: "application/json",
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `ai-history-latest-${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
            }, 0);
          }}
          disabled={!entries.length}
        >
          Download (latest 100)
        </button>
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
                Provider
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
                Proof Hash
              </th>
              <th
                style={{ padding: "4px 6px", borderBottom: "1px solid #ddd" }}
              >
                Rolling Hash
              </th>
              <th
                style={{ padding: "4px 6px", borderBottom: "1px solid #ddd" }}
              >
                Feature Hash
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
                <td style={{ padding: "3px 6px" }}>
                  {e.inferenceProvider || "—"}
                </td>
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
                  {e.inferenceProofHash
                    ? `${e.inferenceProofHash.slice(0, 18)}…`
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
                  {e.rollingHash?.slice(0, 18)}…
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
                  {e.featureHash ? e.featureHash.slice(0, 18) + "…" : "—"}
                </td>
              </tr>
            ))}
            {!entries.length && !loading && (
              <tr>
                <td
                  colSpan={7}
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
        Auto-refresh 15s • Source: /api/strategy/history • Hashs: rationale &
        features pour traçabilité
      </div>
    </div>
  );
};

export default AiConsole;
