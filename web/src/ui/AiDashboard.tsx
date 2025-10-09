import React, { useEffect, useMemo, useRef, useState } from "react";
import ProofPackPanel from "./ProofPackPanel";
import ProofPackDebugPanel from "./ProofPackDebugPanel";
// HyperIndex panel component (Phase 1 integration)
const HyperIndexPanel: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [head, setHead] = useState<any>(null);
  const [meta, setMeta] = useState<any>(null);
  const [rehashOk, setRehashOk] = useState<boolean | null>(null);
  const [rehashError, setRehashError] = useState<string>("");
  const [loading, setLoading] = useState(false);

  async function load() {
    try {
      setLoading(true);
      const feat = await fetch(`${apiBase}/api/hyperindex/features/head`)
        .then((r) => r.json())
        .catch(() => ({}));
      const metaR = await fetch(`${apiBase}/api/hyperindex/_meta`)
        .then((r) => r.json())
        .catch(() => ({}));
      if (feat?.ok) setHead(feat.features || null);
      if (metaR?.ok) setMeta(metaR);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function verifyRehash() {
    if (!head) {
      setRehashOk(null);
      return;
    }
    try {
      setRehashError("");
      const metricKeys = Object.keys(head.metrics || {}).sort();
      function build(linesStyle: "legacy" | "current") {
        const lines: string[] = [];
        if (linesStyle === "current") {
          // Match backend serializeFeatures() current version (schemaVersion / chainId / asOfTs)
          lines.push(`schemaVersion=${head.schemaVersion}`);
          if (head.chainId != null) lines.push(`chainId=${head.chainId}`);
          lines.push(`asOfTs=${head.asOfTs}`);
        } else {
          // Legacy snapshot attempt (older UI assumption)
          lines.push(`v=${head.schemaVersion}`);
          lines.push(`ts=${head.asOfTs}`);
        }
        for (const w of head.windowSpecs || [])
          lines.push(`window:${w.label}:${w.fromTs}:${w.toTs}`);
        for (const k of metricKeys)
          lines.push(
            `m:${k}=${
              head.metrics[k] === null || head.metrics[k] === undefined
                ? "null"
                : String(head.metrics[k])
            }`
          );
        return lines.join("\n");
      }
      const variants: { style: string; hash: string }[] = [];
      let kf: any;
      try {
        kf = (await import("js-sha3")).keccak256;
      } catch {}
      if (!kf) {
        setRehashError("js-sha3 non disponible");
        setRehashOk(false);
        return;
      }
      for (const style of ["current", "legacy"]) {
        const ser = build(style as any);
        variants.push({ style, hash: "0x" + kf(ser) });
      }
      const target = String(head.featureHash).toLowerCase();
      const match = variants.find((v) => v.hash.toLowerCase() === target);
      setRehashOk(!!match);
      if (!match) {
        setRehashError("Aucune variante ne correspond");
      } else if (match.style === "legacy") {
        setRehashError(
          "Correspond à la variante legacy (backend courant = schemaVersion/chainId/asOfTs)"
        );
      }
      // lightweight keccak via dynamic import (js-sha3)
    } catch (e: any) {
      setRehashError(e?.message || "rehash_failed");
      setRehashOk(false);
    }
  }

  return (
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
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
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
          Local Feature Snapshot (dev)
        </div>
        <button onClick={load} disabled={loading} style={{ fontSize: 11 }}>
          {loading ? "…" : "Refresh"}
        </button>
      </div>
      {!head && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#666" }}>
          Aucune feature (ingestion vide).
        </div>
      )}
      {head && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 11 }}>
            featureHash: <code>{String(head.featureHash).slice(0, 22)}…</code>
          </div>
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}
          >
            {Object.keys(head.metrics || {})
              .slice(0, 10)
              .map((k) => (
                <div
                  key={k}
                  style={{
                    fontSize: 10,
                    background: "#1d1d1d",
                    color: "#fff",
                    padding: "3px 5px",
                    borderRadius: 4,
                  }}
                >
                  {k}:{String(head.metrics[k])}
                </div>
              ))}
          </div>
          <button onClick={verifyRehash} style={{ marginTop: 8, fontSize: 11 }}>
            Re-hash local
          </button>
          {rehashOk !== null && (
            <div
              style={{
                fontSize: 11,
                marginTop: 4,
                color: rehashOk ? "#0a5" : "#c22",
              }}
            >
              Rehash {rehashOk ? "OK (match)" : "Mismatch"}{" "}
              {rehashError && " - " + rehashError}
            </div>
          )}
        </div>
      )}
      {meta && meta.eventsProcessed !== undefined && (
        <div style={{ marginTop: 8, fontSize: 11, color: "#444" }}>
          Events: {meta.eventsProcessed} • Types:{" "}
          {meta.types && Object.keys(meta.types).length}
        </div>
      )}
    </div>
  );
};

// Protocol Metrics panel (Envio-powered)
const ProtocolMetricsPanel: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [source, setSource] = useState<string>("");
  const [rows, setRows] = useState<
    Array<{
      id: string;
      dateISO: string;
      usersDaily: number;
      txDaily: number;
      txCumulative: number | null;
      avgTxPerUser: number;
      avgFeeNative: number | null;
      depositDaily?: number | null;
      withdrawDaily?: number | null;
    }>
  >([]);

  async function load() {
    try {
      setLoading(true);
      setError("");
      const r = await fetch(`${apiBase}/api/metrics/protocols/daily`).then((x) => x.json());
      if (!r?.ok) throw new Error(r?.error || "metrics_failed");
      setRows(Array.isArray(r.data) ? r.data : []);
      setSource(r.source || "");
    } catch (e: any) {
      setError(e?.message || String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  async function scanRpc() {
    try {
      setLoading(true);
      setError("");
      const url = new URL(`${apiBase}/api/metrics/protocols/daily`);
      url.searchParams.set('scan', '1');
      url.searchParams.set('hours', '0.25');
      url.searchParams.set('maxBlocks', '200');
      url.searchParams.set('timeoutMs', '4000');
      const r = await fetch(url.toString()).then(x=>x.json());
      if (!r?.ok) throw new Error(r?.error || 'metrics_failed');
      setRows(Array.isArray(r.data) ? r.data : []);
      setSource(r.source || '');
    } catch (e:any) {
      setError(e?.message || String(e));
      setRows([]);
    } finally { setLoading(false) }
  }

  useEffect(() => {
    load();
  }, [apiBase]);

  return (
    <div
      style={{ border: "1px solid #ddd", borderRadius: 8, padding: 10, background: "#fafefe" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, color: "#555" }}>
          Protocol Metrics (Envio)
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={load} disabled={loading} style={{ fontSize: 11 }}>
            {loading ? "…" : "Refresh"}
          </button>
          <button onClick={scanRpc} disabled={loading} style={{ fontSize: 11 }}>
            {loading ? "…" : "Scan (RPC)"}
          </button>
        </div>
      </div>
      {source && (
        <div style={{ marginTop: 4, fontSize: 10, color: '#777' }}>
          source: <code>{source}</code>
        </div>
      )}
      {error && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#b30" }}>Erreur: {error}</div>
      )}
      {!error && rows.length === 0 && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#666" }}>
          Aucune donnée (indexer non démarré ou pas d’activité).
        </div>
      )}
      {rows.length > 0 && (
        <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
          {rows.map((r) => (
            <div
              key={r.id}
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(8, minmax(0, 1fr))",
                gap: 8,
                fontSize: 12,
                padding: "6px 8px",
                border: "1px solid #eee",
                borderRadius: 6,
                background: "#fff",
              }}
            >
              <div><strong>{r.id}</strong></div>
              <div title="users/day">👤 {r.usersDaily}</div>
              <div title="tx/day">🔁 {r.txDaily}</div>
              <div title="tx cumulative">Σ {r.txCumulative ?? "—"}</div>
              <div title="avg tx / user">μ {r.avgTxPerUser?.toFixed?.(2) ?? r.avgTxPerUser}</div>
              <div title="avg fee (native)">⛽ {r.avgFeeNative == null ? "—" : r.avgFeeNative.toFixed(6)}</div>
              <div title="deposits/day">⬆️ {r.depositDaily == null ? "—" : r.depositDaily}</div>
              <div title="withdraws/day">⬇️ {r.withdrawDaily == null ? "—" : r.withdrawDaily}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

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
  const hyperEnabled = useMemo(() => {
    try {
      const p = new URLSearchParams(window.location.search).get('hyper');
      if (p === null) return true; // default on
      return p !== '0';
    } catch { return true }
  }, []);
  const [latest, setLatest] = useState<LatestDecisionResponse | null>(null);
  const [streamLines, setStreamLines] = useState<StreamLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [replayStatus, setReplayStatus] = useState<null | {
    mode: string;
    pass: boolean;
    at: number;
    rollingHash?: string;
  }>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const [anchorStatus, setAnchorStatus] = useState<null | {
    ts: number;
    rollingHash: string;
  }>(null);
  const [exportBlobUrl, setExportBlobUrl] = useState<string | null>(null);
  const [guardrailHead, setGuardrailHead] = useState<any>(null);
  const [guardrailLoadAt, setGuardrailLoadAt] = useState<number>(0);
  const [liveHashStatus, setLiveHashStatus] = useState<{
    match: boolean;
    latest?: string;
    stream?: string;
  } | null>(null);
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
        // Load guardrails head (stagger every fetch)
        try {
          const gh = await fetch(base + "/api/strategy/guardrails/head")
            .then((r) => r.json())
            .catch(() => null);
          if (!cancelled && gh?.ok) {
            setGuardrailHead(gh);
            setGuardrailLoadAt(Date.now());
          }
        } catch {}
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
    es.onmessage = (ev) => {
      try {
        const js = JSON.parse(ev.data);
        const ln = js.line || js;
        if (!ln || typeof ln !== "object" || !ln.action) return;
        setStreamLines((prev) => {
          const next = [...prev, ln];
          return next.slice(-50);
        });
      } catch {}
    };
    return () => {
      es.close();
      setConnected(false);
    };
  }, [base]);

  const lastHashes = useMemo(() => {
    const apiDec: any = latest?.decision;
    const candidate = apiDec?.rollingHash
      ? apiDec
      : [...streamLines].reverse().find((l) => l.action === "ai_decision");
    if (!candidate) return null;
    return {
      rollingHash: candidate.rollingHash,
      featureHash: candidate.featureHash,
      featureHashV2: (candidate as any).featureHashV2,
      aiRationaleHash: candidate.aiRationaleHash,
    };
  }, [streamLines, latest]);

  // Derive naive live/local comparison: last rolling hash from API vs last from stream
  useEffect(() => {
    try {
      const apiRh = (latest as any)?.decision?.rollingHash;
      const streamRh = [...streamLines]
        .reverse()
        .find((l) => l.rollingHash)?.rollingHash;
      if (!apiRh || !streamRh) {
        setLiveHashStatus(null);
      } else {
        setLiveHashStatus({
          match: apiRh === streamRh,
          latest: apiRh,
          stream: streamRh,
        });
      }
    } catch {
      setLiveHashStatus(null);
    }
  }, [latest, streamLines]);

  const verificationPass = latest?.verification?.pass;
  const decision = latest?.decision as any;

  async function triggerReplay(mode: string) {
    if (replayLoading) return;
    setReplayLoading(true);
    try {
      const q = new URL(base + "/api/strategy/decision/replay");
      q.searchParams.set("mode", mode);
      const res = await fetch(q.toString());
      const js = await res.json();
      if (!js.ok) throw new Error(js.error || "replay_failed");
      setReplayStatus({
        mode,
        pass: !!js.pass,
        at: Date.now(),
        rollingHash: js.rollingHash,
      });
    } catch (e: any) {
      setErrors((p) => [...p, e?.message || "replay_error"]);
    } finally {
      setReplayLoading(false);
    }
  }

  async function triggerAnchor() {
    try {
      const res = await fetch(base + "/api/audit/anchor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: "dashboard" }),
      });
      const js = await res.json();
      if (!js.ok) throw new Error(js.error || "anchor_failed");
      setAnchorStatus({
        ts: js.anchored.ts,
        rollingHash: js.anchored.rollingHash,
      });
    } catch (e: any) {
      setErrors((p) => [...p, e?.message || "anchor_error"]);
    }
  }

  async function exportSnapshot() {
    try {
      const res = await fetch(base + "/api/strategy/decision/export/latest");
      if (!res.ok) throw new Error("export_http_" + res.status);
      const text = await res.text();
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      setExportBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });
    } catch (e: any) {
      setErrors((p) => [...p, e?.message || "export_error"]);
    }
  }

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
        {/* Envio protocol metrics panel */}
        <ProtocolMetricsPanel apiBase={base} />

  {/* HyperIndex snapshot panel (optional) */}
  {hyperEnabled && <HyperIndexPanel apiBase={base} />}
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
            Replay (Determinism)
          </div>
          <div
            style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}
          >
            <button
              disabled={replayLoading}
              onClick={() => triggerReplay("strict")}
            >
              {replayLoading ? "…" : "Strict"}
            </button>
            <button
              disabled={replayLoading}
              onClick={() => triggerReplay("strict-snapshot")}
            >
              {replayLoading ? "…" : "Strict Snapshot"}
            </button>
            <button
              disabled={replayLoading}
              onClick={() => triggerReplay("basic")}
            >
              {replayLoading ? "…" : "Basic"}
            </button>
          </div>
          {replayStatus && (
            <div style={{ marginTop: 8, fontSize: 11 }}>
              <strong>{replayStatus.mode}</strong>: {badge(replayStatus.pass)}
              <div style={{ color: "#555" }}>
                à {new Date(replayStatus.at).toLocaleTimeString()} (rh:{" "}
                {replayStatus.rollingHash?.slice(0, 10)}…)
              </div>
            </div>
          )}
          {!replayStatus && (
            <div style={{ marginTop: 8, fontSize: 11, color: "#666" }}>
              Lancez un replay strict pour prouver la reproductibilité.
            </div>
          )}
          <div
            style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}
          >
            <button onClick={triggerAnchor}>Anchor now</button>
            <button onClick={exportSnapshot}>Export snapshot</button>
            {exportBlobUrl && (
              <a
                href={exportBlobUrl}
                download="decision-snapshot.json"
                style={{ fontSize: 11, textDecoration: "underline" }}
              >
                Download
              </a>
            )}
          </div>
          {anchorStatus && (
            <div style={{ marginTop: 6, fontSize: 10, color: "#044" }}>
              Anchored {new Date(anchorStatus.ts).toLocaleTimeString()} (rh{" "}
              {anchorStatus.rollingHash.slice(0, 12)}…)
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
              <div>
                Action: {decision.actionType || decision.aiActionType || "—"}
              </div>
              <div>
                Risk: {decision.riskScore ?? decision.aiRiskScore ?? "—"}
              </div>
              <div>
                Confidence:{" "}
                {decision.confidence ?? decision.aiConfidence ?? "—"}
              </div>
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
              <div style={{ marginTop: 4 }}>
                Live vs Stream:{" "}
                {liveHashStatus ? (
                  <span
                    style={{
                      color: liveHashStatus.match ? "#0a5" : "#c22",
                      fontWeight: 600,
                    }}
                  >
                    {liveHashStatus.match ? "MATCH" : "DIVERGE"}
                  </span>
                ) : (
                  "—"
                )}
              </div>
              {liveHashStatus && !liveHashStatus.match && (
                <div style={{ fontSize: 10, color: "#b00" }}>
                  api:{liveHashStatus.latest?.slice(0, 10)}… ≠ sse:
                  {liveHashStatus.stream?.slice(0, 10)}…
                </div>
              )}
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
            Guardrails
          </div>
          {guardrailHead ? (
            <div style={{ marginTop: 4, fontSize: 11 }}>
              <div>
                Status:{" "}
                {guardrailHead.evaluation?.blocked ? (
                  <span style={{ color: "#b00" }}>BLOCKED</span>
                ) : (
                  <span style={{ color: "#090" }}>clear</span>
                )}
              </div>
              {guardrailHead.evaluation?.reason && (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                    alignItems: "baseline",
                  }}
                >
                  <span>
                    Reason: <code>{guardrailHead.evaluation.reason}</code>
                  </span>
                  {guardrailHead.evaluation.reason ===
                    "feature_hash_mismatch" &&
                    !guardrailHead.evaluation.warnings?.includes(
                      "abnormal_hyperindex_activity"
                    ) && (
                      <span
                        style={{
                          background: "#ffe9c7",
                          color: "#a65a00",
                          fontSize: 10,
                          padding: "2px 6px",
                          borderRadius: 4,
                          fontWeight: 600,
                        }}
                        title="Mismatch attendu après changement de code features; se résout à la prochaine décision stable"
                      >
                        expected dev change
                      </span>
                    )}
                </div>
              )}
              {guardrailHead.diff && (
                <div style={{ marginTop: 6 }}>
                  <div
                    style={{
                      fontSize: 10,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                      color: "#444",
                    }}
                  >
                    Feature Hash Diff
                  </div>
                  <div
                    style={{
                      fontFamily: "monospace",
                      fontSize: 10,
                      marginTop: 2,
                    }}
                  >
                    last:{" "}
                    {(guardrailHead.diff.lastDecisionFeatureHash || "—").slice(
                      0,
                      18
                    )}
                    …<br />
                    cur:{" "}
                    {(guardrailHead.diff.currentFeatureHash || "—").slice(
                      0,
                      18
                    )}
                    …
                  </div>
                  {guardrailHead.diff.lastDecisionFeatureHash &&
                    guardrailHead.diff.currentFeatureHash &&
                    guardrailHead.diff.lastDecisionFeatureHash !==
                      guardrailHead.diff.currentFeatureHash && (
                      <div
                        style={{ fontSize: 10, color: "#b00", marginTop: 2 }}
                      >
                        Mismatch (attend nouvelle décision pour aligner)
                      </div>
                    )}
                </div>
              )}
              {guardrailHead.evaluation?.warnings?.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  Warnings:
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {guardrailHead.evaluation.warnings
                      .slice(0, 6)
                      .map((w: string) => (
                        <li key={w}>{w}</li>
                      ))}
                  </ul>
                </div>
              )}
              <div style={{ marginTop: 4, color: "#555" }}>
                FeatureAge:{" "}
                {guardrailHead.evaluation?.info?.featureAgeMs != null
                  ? Math.round(
                      guardrailHead.evaluation.info.featureAgeMs / 1000
                    ) + "s"
                  : "—"}
              </div>
              <div style={{ marginTop: 2, color: "#555" }}>
                Vol Drift:{" "}
                {guardrailHead.evaluation?.info?.volatilityDrift != null
                  ? guardrailHead.evaluation.info.volatilityDrift.toFixed(3)
                  : "—"}
              </div>
              <div style={{ marginTop: 4, fontSize: 10 }}>
                Updated {new Date(guardrailLoadAt).toLocaleTimeString()}
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 4, fontSize: 11 }}>Loading…</div>
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
                  <strong>{l.action}</strong>{" "}
                  {l.aiActionType || (l as any).actionType || ""}{" "}
                  {l.riskScore != null
                    ? " r=" + l.riskScore
                    : (l as any).aiRiskScore != null
                    ? " r=" + (l as any).aiRiskScore
                    : ""}{" "}
                  {l.confidence != null
                    ? " c=" + l.confidence
                    : (l as any).aiConfidence != null
                    ? " c=" + (l as any).aiConfidence
                    : ""}
                </div>
              ))}
            {!streamLines.length && <div>Waiting…</div>}
          </div>
        </div>
        <HyperIndexPanel apiBase={base} />
        <ProofPackPanel apiBase={base} />
        <ProofPackDebugPanel apiBase={base} />
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
