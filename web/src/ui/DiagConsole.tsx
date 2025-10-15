import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type DiagEntry = {
  ts: number;
  level?: "info" | "warn" | "error";
  scope?: string;
  message?: string;
  details?: any;
  error?: any;
};

function formatTime(ms: number) {
  const d = new Date(ms);
  return d.toLocaleTimeString();
}

const Mono: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{children}</span>
);

export const DiagConsole: React.FC<{ apiBase?: string; auto?: boolean }> = ({ apiBase, auto = true }) => {
  const base = useMemo(
    () => (apiBase || (import.meta as any)?.env?.VITE_API_BASE || "http://127.0.0.1:8787").replace(/\/$/, ""),
    [apiBase]
  );
  const [entries, setEntries] = useState<DiagEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(200);
  const [filter, setFilter] = useState<string>("");
  const timerRef = useRef<number | null>(null);

  const fetchTail = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    try {
      const url = new URL("/api/diag/tail", base);
      url.searchParams.set("limit", String(limit));
      if (filter) url.searchParams.set("contains", filter);
      const res = await fetch(url.toString(), { cache: "no-store" });
      const js = await res.json();
      if (!js.ok) throw new Error(js.error || "diag_tail_failed");
      const list: DiagEntry[] = Array.isArray(js.entries) ? js.entries : [];
      list.sort((a, b) => b.ts - a.ts);
      setEntries(list);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "load_failed");
    } finally {
      setLoading(false);
    }
  }, [base, limit, filter, loading]);

  useEffect(() => {
    if (!auto) return;
    timerRef.current && clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => fetchTail(), 10000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [auto, fetchTail]);

  useEffect(() => {
    fetchTail();
  }, [base, limit, filter]);

  return (
    <div style={{ border: "2px solid #dd6622", boxShadow: "0 0 0 2px #dd662222", borderRadius: 10, padding: 14, background: "linear-gradient(135deg,#fff,#fff7f3)", marginTop: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 16 }}>Diagnostics (backend viem/AA)</strong>
        <div style={{ fontSize: 12, color: "#555" }}>
          Count: {entries.length} • Auto 10s
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12 }}>Limit:</label>
        <input
          type="number"
          min={10}
          max={1000}
          value={limit}
          onChange={(e) => setLimit(Math.max(10, Math.min(1000, Number(e.target.value) || 200)))}
          style={{ width: 90 }}
        />
        <label style={{ fontSize: 12 }}>Filter:</label>
        <input
          type="text"
          placeholder="contains… (ex: 429 | balanceOf)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ minWidth: 240 }}
        />
        <button onClick={() => fetchTail()} disabled={loading}>
          Refresh
        </button>
        {loading && <span style={{ fontSize: 12 }}>Loading…</span>}
        {error && <span style={{ fontSize: 12, color: "#b00" }}>Err: {error}</span>}
      </div>
      <div style={{ marginTop: 10, maxHeight: 300, overflow: "auto", fontSize: 12 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", background: "#fff1e8" }}>
              <th style={{ padding: "4px 6px", borderBottom: "1px solid #eee" }}>Time</th>
              <th style={{ padding: "4px 6px", borderBottom: "1px solid #eee" }}>Level</th>
              <th style={{ padding: "4px 6px", borderBottom: "1px solid #eee" }}>Scope</th>
              <th style={{ padding: "4px 6px", borderBottom: "1px solid #eee" }}>Message</th>
              <th style={{ padding: "4px 6px", borderBottom: "1px solid #eee" }}>Error</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i} style={{ borderBottom: "1px solid #f0f0f0" }}>
                <td style={{ padding: "3px 6px", whiteSpace: "nowrap" }}>{formatTime(e.ts)}</td>
                <td style={{ padding: "3px 6px" }}>{e.level || ""}</td>
                <td style={{ padding: "3px 6px" }}><Mono>{e.scope || ""}</Mono></td>
                <td style={{ padding: "3px 6px" }}>{e.message || ""}</td>
                <td style={{ padding: "3px 6px" }}>
                  <div style={{ color: "#b00" }}>
                    <Mono>{e?.error?.message || ""}</Mono>
                  </div>
                  {e?.error?.details && (
                    <div style={{ color: "#b00", opacity: 0.9 }}>
                      <Mono>{String(e.error.details).slice(0, 200)}</Mono>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {!entries.length && !loading && (
              <tr>
                <td colSpan={5} style={{ padding: 8, textAlign: "center", color: "#666" }}>
                  Aucun diagnostic pour l'instant
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: "#777" }}>
        Sources: viem.readContract/getBalance/getGasPrice et aa.sendUserOperation (backend)
      </div>
    </div>
  );
};

export default DiagConsole;
