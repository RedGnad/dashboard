import React, { useEffect, useMemo, useRef, useState } from "react";

interface LatestDecisionResponse {
  ok: boolean;
  empty?: boolean;
  decision?: any;
  verification?: {
    pass: boolean;
    checks: Record<string, { pass: boolean; expected: any; actual: any }>;
  };
}

type StreamLine = {
  ts?: number;
  action?: string;
  rollingHash?: string;
  featureHash?: string;
  featureHashV2?: string;
  aiRationaleHash?: string;
  modelHash?: string;
  rawScore?: number;
  logitZ?: number;
  mappingVersion?: string;
  weightsUsedHash?: string;
  aiActionType?: string;
  riskScore?: number;
  confidence?: number;
};

const formatTime = (t?: number) => (t ? new Date(t).toLocaleTimeString() : "—");

const badge = (ok: boolean | undefined) => (
  <span
    style={{
      display: "inline-block",
      padding: "2px 6px",
      borderRadius: 6,
      fontSize: 11,
      background: ok ? "#0b5" : "#b30",
      color: "#fff",
    }}
  >
    {ok ? "PASS" : "FAIL"}
  </span>
);

export const AiDashboard: React.FC<{ apiBase?: string }> = ({ apiBase }) => {
  const base = useMemo(
    () =>
      (
        apiBase ||
        (import.meta as any)?.env?.VITE_API_BASE ||
        "http://127.0.0.1:8787"
      ).replace(/\/$/, ""),
    [apiBase]
  );
  const [latest, setLatest] = useState<LatestDecisionResponse | null>(null);
  const [streamLines, setStreamLines] = useState<StreamLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<number | null>(null);

  // Fetch latest decision periodically (10s)
  useEffect(() => {
    let cancelled = false;
    async function fetchLatest() {
      try {
        const res = await fetch(base + "/api/strategy/decision/latest");
        const js: LatestDecisionResponse = await res.json();
        if (!cancelled) setLatest(js);
      } catch (e: any) {
        if (!cancelled)
          setErrors((p) => [...p, e?.message || "latest_fetch_error"]);
      }
    }
    fetchLatest();
    pollRef.current && clearInterval(pollRef.current);
    pollRef.current = window.setInterval(fetchLatest, 10000);
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [base]);

  // SSE stream
  useEffect(() => {
    const es = new EventSource(base + "/api/audit/stream");
    esRef.current = es;
    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
      setErrors((p) => [...p, "sse_error"]);
    };
    es.addEventListener("init", (ev) => {
      // ignore size, simply note connection
    });
    es.addEventListener("line", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data);
        if (!data?.line) return;
        const ln = data.line as any;
        // Only keep last 50 lines (decision & execution oriented)
        setStreamLines((prev) => {
          const next = [...prev, ln];
          return next.slice(-50);
        });
      } catch {}
    });
    return () => {
      es.close();
      setConnected(false);
    };
  }, [base]);

  const lastHashes = useMemo(() => {
    const latestLine = [...streamLines]
      .reverse()
      .find((l) => l.action === "ai_decision");
    if (!latestLine) return null;
    return {
      rollingHash: latestLine.rollingHash,
      featureHash: latestLine.featureHash,
      featureHashV2: (latestLine as any).featureHashV2,
      aiRationaleHash: latestLine.aiRationaleHash,
    };
  }, [streamLines]);

  const verificationPass = latest?.verification?.pass;
  const decision = latest?.decision as any;

  return (
    <div
      style={{
        border: "2px solid #0a6",
        boxShadow: "0 0 0 2px #0a6b",
        borderRadius: 10,
        padding: 14,
        background: "linear-gradient(135deg,#fff,#f3fff9)",
        marginTop: 24,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <strong style={{ fontSize: 16 }}>AI Verification Dashboard</strong>
        <div style={{ fontSize: 12, color: "#055" }}>
          Stream: {connected ? "connected" : "—"} • Last decision:{" "}
          {decision ? formatTime(decision.ts) : "—"}
        </div>
      </div>
      <div
        style={{
          marginTop: 10,
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))",
        }}
      >
        <div
          style={{
            border: "1px solid #ddd",
            borderRadius: 8,
            padding: 10,
            background: "#fafefe",
          }}
        >
          <div
            style={{
              fontSize: 12,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: "#555",
            }}
          >
            Verification
          </div>
          <div style={{ marginTop: 4 }}>{badge(verificationPass)}</div>
          {latest?.verification && (
            <div
              style={{
                marginTop: 6,
                fontSize: 11,
                maxHeight: 120,
                overflow: "auto",
                fontFamily: "monospace",
              }}
            >
              {Object.entries(latest.verification.checks).map(([k, v]) => (
                <div key={k} style={{ color: v.pass ? "#093" : "#b00" }}>
                  {v.pass ? "✓" : "✗"} {k}
                </div>
              ))}
            </div>
          )}
        </div>
        <div
          style={{
            border: "1px solid #ddd",
            borderRadius: 8,
            padding: 10,
            background: "#fafefe",
          }}
        >
          <div
            style={{
              fontSize: 12,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: "#555",
            }}
          >
            Decision Meta
          </div>
          {decision ? (
            <div style={{ marginTop: 4, fontSize: 12 }}>
              <div>Action: {decision.actionType}</div>
              <div>Risk: {decision.riskScore}</div>
              <div>Confidence: {decision.confidence}</div>
              <div style={{ fontSize: 11, color: "#555" }}>
                ModelHash: {(decision as any).modelHash?.slice(0, 18)}…
              </div>
              <div style={{ fontSize: 11, color: "#555" }}>
                RawScore: {(decision as any).rawScore}
              </div>
              <div style={{ fontSize: 11, color: "#555" }}>
                LogitZ: {(decision as any).logitZ}
              </div>
              <div style={{ fontSize: 11, color: "#555" }}>
                Mapping: {(decision as any).mappingVersion}
              </div>
              <div style={{ fontSize: 11, color: "#555" }}>
                Weights: {(decision as any).weightsUsedHash?.slice(0, 14)}…
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 4, fontSize: 12 }}>No decision yet</div>
          )}
        </div>
        <div
          style={{
            border: "1px solid #ddd",
            borderRadius: 8,
            padding: 10,
            background: "#fafefe",
          }}
        >
          <div
            style={{
              fontSize: 12,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: "#555",
            }}
          >
            Latest Hashes
          </div>
          {lastHashes ? (
            <div
              style={{ marginTop: 4, fontSize: 11, fontFamily: "monospace" }}
            >
              <div>Rolling: {lastHashes.rollingHash?.slice(0, 24)}…</div>
              <div>Feat v1: {lastHashes.featureHash?.slice(0, 24)}…</div>
              {lastHashes.featureHashV2 && (
                <div>Feat v2: {lastHashes.featureHashV2.slice(0, 24)}…</div>
              )}
              <div>Rationale: {lastHashes.aiRationaleHash?.slice(0, 24)}…</div>
            </div>
          ) : (
            <div style={{ marginTop: 4, fontSize: 12 }}>—</div>
          )}
        </div>
        <div
          style={{
            border: "1px solid #ddd",
            borderRadius: 8,
            padding: 10,
            background: "#fafefe",
          }}
        >
          <div
            style={{
              fontSize: 12,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: "#555",
            }}
          >
            Recent Stream (last 50)
          </div>
          <div
            style={{
              marginTop: 4,
              fontSize: 11,
              maxHeight: 140,
              overflow: "auto",
              fontFamily: "monospace",
            }}
          >
            {streamLines
              .slice()
              .reverse()
              .map((l, i) => (
                <div
                  key={i}
                  style={{ padding: "2px 0", borderBottom: "1px solid #eee" }}
                >
                  <strong>{l.action}</strong> {l.aiActionType || ""}{" "}
                  {l.riskScore != null ? " r=" + l.riskScore : ""}{" "}
                  {l.confidence != null ? " c=" + l.confidence : ""}
                </div>
              ))}
            {!streamLines.length && <div>Waiting…</div>}
          </div>
        </div>
      </div>
      {!!errors.length && (
        <div style={{ marginTop: 10, fontSize: 11, color: "#b00" }}>
          Errors: {errors.slice(-3).join(", ")}
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 10, color: "#666" }}>
        Sources: /api/audit/stream (SSE) & /api/strategy/decision/latest • Auto
        10s polling for verification
      </div>
    </div>
  );
};

export default AiDashboard;
