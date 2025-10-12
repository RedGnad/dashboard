import React, { useEffect, useMemo, useRef, useState } from "react";
import ProofPackPanel from "./ProofPackPanel";
import ProofPackDebugPanel from "./ProofPackDebugPanel";
// Lightweight sparkline for DCA run amounts
const Sparkline: React.FC<{
  points: number[];
  width?: number;
  height?: number;
  color?: string;
  sharedMin?: number;
  sharedMax?: number;
}> = ({
  points,
  width = 160,
  height = 40,
  color = "#1e88e5",
  sharedMin,
  sharedMax,
}) => {
  if (!points || points.length === 0) return <div style={{ width, height }} />;
  const localMin = Math.min(...points);
  const localMax = Math.max(...points);
  const min = sharedMin != null ? sharedMin : localMin;
  const max = sharedMax != null ? sharedMax : localMax;
  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const norm = (v: number) => (max === min ? 0.5 : (v - min) / (max - min));
  const d = points
    .map((p, i) => {
      const x = pad + (i / Math.max(1, points.length - 1)) * w;
      const y = pad + (1 - norm(p)) * h;
      return `${i === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
};

export const AutopilotMiniCard: React.FC<{
  apiBase: string;
  delegator?: string;
}> = ({ apiBase, delegator }) => {
  const [events, setEvents] = React.useState<
    Array<{
      ts: number;
      amountInUSDC?: string;
      amountIntendedUSDC?: string;
      baselineManualUSDC?: string;
      userOperationHash?: string;
      skipped?: boolean;
    }>
  >([]);
  const [summary, setSummary] = React.useState<any>(null);
  const [series, setSeries] = React.useState<{
    actual: number[];
    manual: number[];
  } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [usdcBackend, setUsdcBackend] = React.useState<number | null>(null);
  const [envioBalances, setEnvioBalances] = React.useState<boolean | null>(
    null
  );
  const [envioPrices, setEnvioPrices] = React.useState<boolean | null>(null);
  const nf2 = React.useMemo(
    () =>
      new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    []
  );
  async function load() {
    if (!delegator) return;
    try {
      setLoading(true);
      const url1 = new URL(apiBase + "/api/strategy/run-history");
      url1.searchParams.set("delegator", delegator);
      url1.searchParams.set("limit", "50");
      const url2 = new URL(apiBase + "/api/diag");
      url2.searchParams.set("delegator", delegator);
      const [r1, r2, rPrev] = await Promise.all([
        fetch(url1.toString())
          .then((x) => x.json())
          .catch(() => null),
        fetch(url2.toString())
          .then((x) => x.json())
          .catch(() => null),
        fetch(
          `${apiBase}/api/strategy/preview?delegator=${encodeURIComponent(
            delegator
          )}`
        )
          .then((x) => x.json())
          .catch(() => null),
      ]);
      if (r1?.ok) {
        setEvents(r1.events || []);
        setSummary(r1.summary || null);
        setSeries(r1.series || null);
      }
      if (r2 && r2.delegatorBalances && r2.delegatorBalances.usdc) {
        try {
          setUsdcBackend(Number(r2.delegatorBalances.usdc) / 1_000_000);
        } catch {
          setUsdcBackend(null);
        }
      }
      if (r2) {
        if (typeof r2.usedEnvioBalances === "boolean")
          setEnvioBalances(!!r2.usedEnvioBalances);
        if (typeof r2.usedEnvioPrices === "boolean")
          setEnvioPrices(!!r2.usedEnvioPrices);
      }
      if (rPrev) {
        if (typeof rPrev.usedEnvioBalances === "boolean")
          setEnvioBalances(!!rPrev.usedEnvioBalances);
        if (typeof rPrev.usedEnvioPrices === "boolean")
          setEnvioPrices(!!rPrev.usedEnvioPrices);
      }
    } finally {
      setLoading(false);
    }
  }
  React.useEffect(() => {
    load();
    let t: number | null = window.setInterval(load, 15000) as any;
    return () => {
      if (t) window.clearInterval(t);
    };
  }, [apiBase, delegator]);
  const usdcPoints = React.useMemo(() => {
    if (series) return series.actual;
    return events.map((e) => {
      try {
        return e.skipped
          ? 0
          : e.amountInUSDC
          ? Number(e.amountInUSDC) / 1_000_000
          : 0;
      } catch {
        return 0;
      }
    });
  }, [events, series]);
  const manualPoints = React.useMemo(() => {
    if (series) return series.manual;
    return events.map((e) => {
      try {
        if (e.baselineManualUSDC)
          return Number(e.baselineManualUSDC) / 1_000_000;
        if (e.amountIntendedUSDC)
          return Number(e.amountIntendedUSDC) / 1_000_000;
        return 0;
      } catch {
        return 0;
      }
    });
  }, [events, series]);
  // Shared scale across both sparklines to avoid vertical offset when values are equal
  const [sharedMin, sharedMax] = React.useMemo(() => {
    const all = [...(manualPoints || []), ...(usdcPoints || [])].filter((x) =>
      Number.isFinite(x)
    );
    if (all.length === 0) return [0, 1];
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (lo === hi) {
      lo = Math.max(0, lo - 1);
      hi = hi + 1;
    }
    return [lo, hi];
  }, [manualPoints, usdcPoints]);
  const last = events.at(-1);
  return (
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: 8,
        padding: 10,
        background: "#fff",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <strong style={{ fontSize: 12 }}>Autopilot</strong>
          {/* IA data source LEDs moved to header for visibility */}
          <div
            title={`Données IA via Envio (balances/prix)`}
            style={{ display: "flex", alignItems: "center", gap: 4 }}
          >
            <span style={{ fontSize: 10, color: "#666" }}>IA</span>
            <span
              title={`balances: ${
                envioBalances === null ? "n/a" : envioBalances ? "on" : "off"
              }`}
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                background:
                  envioBalances == null
                    ? "#bbb"
                    : envioBalances
                    ? "#2e7d32"
                    : "#b71c1c",
                display: "inline-block",
              }}
            />
            <span
              title={`prix: ${
                envioPrices === null ? "n/a" : envioPrices ? "on" : "off"
              }`}
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                background:
                  envioPrices == null
                    ? "#bbb"
                    : envioPrices
                    ? "#2e7d32"
                    : "#b71c1c",
                display: "inline-block",
              }}
            />
          </div>
        </div>
        {summary && (
          <span style={{ fontSize: 11, color: "#555" }}>
            runs: {events.length} • Σin:{" "}
            {nf2.format(Number(summary.totalInUSDC || "0") / 1_000_000)} USDC
          </span>
        )}
      </div>
      <div
        style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}
      >
        <div style={{ position: "relative" }}>
          {/* When no data, render a visible placeholder instead of an empty block */}
          {manualPoints.length === 0 && usdcPoints.length === 0 ? (
            <div
              style={{
                width: 160,
                height: 40,
                display: "grid",
                placeItems: "center",
                color: "#999",
                fontSize: 10,
                border: "1px dashed #ddd",
                borderRadius: 4,
              }}
            >
              Aucune donnée
            </div>
          ) : (
            <>
              <Sparkline
                points={manualPoints}
                color="#c62828"
                sharedMin={sharedMin}
                sharedMax={sharedMax}
              />
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  pointerEvents: "none",
                }}
              >
                <Sparkline
                  points={usdcPoints}
                  color="#1e88e5"
                  sharedMin={sharedMin}
                  sharedMax={sharedMax}
                />
              </div>
            </>
          )}
        </div>
        <div style={{ fontSize: 11, color: "#444" }}>
          <div>
            Last run: {last ? new Date(last.ts).toLocaleTimeString() : "—"}
          </div>
          <div>
            Last amt:{" "}
            {last && last.amountInUSDC
              ? nf2.format(Number(last.amountInUSDC) / 1_000_000)
              : "—"}{" "}
            USDC
          </div>
          <div style={{ color: "#c62828" }}>
            Manual base (red): last{" "}
            {manualPoints.length
              ? nf2.format(manualPoints[manualPoints.length - 1])
              : "—"}{" "}
            USDC
          </div>
          {last && (
            <div style={{ marginTop: 4, fontSize: 10, color: "#555" }}>
              <div>
                AI:{" "}
                {(last as any) &&
                (last as any).ai &&
                (last as any).ai.actionType
                  ? (last as any).ai.actionType
                  : "—"}
                {(last as any)?.ai?.rawScore != null
                  ? ` (score ${
                      (last as any).ai.rawScore.toFixed
                        ? (last as any).ai.rawScore.toFixed(3)
                        : (last as any).ai.rawScore
                    })`
                  : ""}
              </div>
              <div>
                Size base/effective:{" "}
                {(last as any)?.sizing?.basePct != null
                  ? (last as any).sizing.basePct
                  : "—"}{" "}
                /{" "}
                {(last as any)?.sizing?.effectivePct != null
                  ? (last as any).sizing.effectivePct
                  : "—"}
              </div>
            </div>
          )}
          <div>
            USDC backend: {usdcBackend != null ? nf2.format(usdcBackend) : "—"}
          </div>
          <div>{loading ? "…" : ""}</div>
        </div>
      </div>
    </div>
  );
};
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
          lines.push(`schemaVersion=${head.schemaVersion}`);
          if (head.chainId != null) lines.push(`chainId=${head.chainId}`);
          lines.push(`asOfTs=${head.asOfTs}`);
        } else {
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
export const ProtocolMetricsPanel: React.FC<{ apiBase: string }> = ({
  apiBase,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [source, setSource] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
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
  const [stale, setStale] = useState<boolean>(false);
  const [lastGoodRows, setLastGoodRows] = useState<typeof rows | null>(null);
  const [lastGoodAt, setLastGoodAt] = useState<number | null>(null);
  // Persist best-known dataset locally to avoid empty UI at startup
  useEffect(() => {
    try {
      const raw = localStorage.getItem("protoMetrics:lastGood");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.rows)) {
          setRows(parsed.rows);
          setLastGoodRows(parsed.rows);
          if (typeof parsed.at === "number") setLastGoodAt(parsed.at);
          setSource("cache-local");
          setStatus("cache");
          if (typeof parsed.at === "number") setLastUpdated(parsed.at);
          setStale(true);
        }
      }
    } catch {}
  }, []);

  const nf0 = useMemo(() => new Intl.NumberFormat("en-US"), []);
  const nf2 = useMemo(
    () =>
      new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    []
  );

  async function load() {
    try {
      setLoading(true);
      setError("");
      const r = await fetch(
        `${apiBase}/api/metrics/protocols/daily?patch=1`
      ).then((x) => x.json());
      if (!r?.ok) throw new Error(r?.error || "metrics_failed");
      const data = Array.isArray(r.data) ? r.data : [];
      const src = String(r.source || "");
      const st = String(r.status || "");
      const isGood = [
        "envio",
        "envio+patch",
        "rpc",
        "cache",
        "cache-local",
      ].includes(src);
      setSource(src);
      setStatus(st);
      const patchedIds: string[] = Array.isArray(r?.patchedIds)
        ? r.patchedIds
        : [];
      if (isGood) {
        setRows(data);
        setLastGoodRows(data);
        setLastGoodAt(Date.now());
        setStale(st === "cache" || st === "fallback");
        try {
          localStorage.setItem(
            "protoMetrics:lastGood",
            JSON.stringify({
              rows: data,
              at: Date.now(),
              source: src,
              status: st,
            })
          );
        } catch {}
      } else {
        // Keep last good data on transient failures to avoid flashing zero rows
        if (lastGoodRows) {
          setRows(lastGoodRows);
          setStale(true);
        } else {
          setRows(data);
          setStale(true);
        }
      }
      setLastUpdated(Date.now());
    } catch (e: any) {
      setError(e?.message || String(e));
      // Preserve previous rows to avoid flicker; just mark as stale and update timestamp
      if (lastGoodRows) {
        setRows(lastGoodRows);
        setStale(true);
      }
      setLastUpdated(Date.now());
    } finally {
      setLoading(false);
    }
  }

  async function scanRpc() {
    try {
      setLoading(true);
      setError("");
      const url = new URL(`${apiBase}/api/metrics/protocols/daily`);
      url.searchParams.set("scan", "1");
      url.searchParams.set("hours", "0.25");
      url.searchParams.set("maxBlocks", "200");
      url.searchParams.set("timeoutMs", "4000");
      const r = await fetch(url.toString()).then((x) => x.json());
      if (!r?.ok) throw new Error(r?.error || "metrics_failed");
      const data = Array.isArray(r.data) ? r.data : [];
      const src = String(r.source || "");
      const st = String(r.status || "");
      const isGood = [
        "envio",
        "envio+patch",
        "rpc",
        "cache",
        "cache-local",
      ].includes(src);
      setSource(src);
      setStatus(st);
      if (isGood) {
        setRows(data);
        setLastGoodRows(data);
        setLastGoodAt(Date.now());
        setStale(st === "cache" || st === "fallback");
      } else {
        if (lastGoodRows) {
          setRows(lastGoodRows);
          setStale(true);
        } else {
          setRows(data);
          setStale(true);
        }
      }
      setLastUpdated(Date.now());
    } catch (e: any) {
      setError(e?.message || String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [apiBase]);
  // Auto-refresh: fast cache every 1s, full refresh every 5s
  useEffect(() => {
    let active = true;
    let tFast: number | null = null;
    let tFull: number | null = null;
    async function pollFast() {
      if (!active) return;
      try {
        const r = await fetch(
          `${apiBase}/api/metrics/protocols/daily?fast=1`
        ).then((x) => x.json());
        const src = String(r?.source || "");
        const st = String(r?.status || "");
        const data = Array.isArray(r?.data) ? r.data : [];
        const isGood = [
          "envio",
          "envio+patch",
          "rpc",
          "cache",
          "cache-local",
          "none",
        ].includes(src);
        if (isGood && data.length > 0) {
          setRows(data);
          setSource(src);
          setStatus(st);
          setLastUpdated(Date.now());
          setStale(
            st === "cache" ||
              st === "fallback" ||
              src === "cache-local" ||
              src === "none"
          );
        }
      } catch {}
      if (active) tFast = window.setTimeout(pollFast, 1000) as any;
    }
    async function pollFull() {
      if (!active) return;
      await load();
      if (active) tFull = window.setTimeout(pollFull, 5000) as any;
    }
    tFast = window.setTimeout(pollFast, 100) as any;
    tFull = window.setTimeout(pollFull, 1000) as any;
    return () => {
      active = false;
      if (tFast) window.clearTimeout(tFast);
      if (tFull) window.clearTimeout(tFull);
    };
  }, [apiBase]);

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
          Protocol Metrics (Envio)
        </div>
        {/* Controls temporarily hidden to avoid UI flicker during auto-refresh */}
      </div>
      <div
        style={{
          marginTop: 4,
          fontSize: 10,
          color: "#777",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <div>
          {/* Autopilot mini-card placeholder; integrate in the dashboard header later if needed */}
          <div style={{ marginTop: 10 }}>
            {/* apiBase is expected to be provided by parent as full base URL */}
          </div>
          <span
            title={
              status === "direct"
                ? "Envio direct (live)"
                : status === "patched"
                ? "Envio partiel (patch RPC)"
                : status === "fallback"
                ? "Fallback RPC"
                : source === "cache-local"
                ? "Cache local"
                : "Cache serveur"
            }
            style={{
              display: "inline-block",
              width: 10,
              height: 10,
              borderRadius: 6,
              marginRight: 6,
              verticalAlign: "middle",
              background: status === "direct" ? "#0a5" : "#c22",
              boxShadow:
                status === "direct"
                  ? "0 0 6px rgba(0,160,80,0.6)"
                  : "0 0 6px rgba(200,34,34,0.5)",
            }}
          />
          <span style={{ marginRight: 8 }}>
            status: <code>{status || "—"}</code>
          </span>
          <span>
            source: <code>{source || "—"}</code>
          </span>
          {stale ? <span style={{ color: "#b30" }}> • stale</span> : null}
        </div>
        <div>
          auto-refresh: 1s • last:{" "}
          {lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : "—"}
        </div>
      </div>
      {error && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#b30" }}>
          Erreur: {error}
        </div>
      )}
      {!error && rows.length === 0 && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#666" }}>
          Aucune donnée (indexer non démarré ou pas d’activité).
        </div>
      )}
      {rows.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 980 }}>
              {/* header */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "160px 90px 110px 120px 120px 130px 130px",
                  gap: 8,
                  fontSize: 11,
                  padding: "6px 8px",
                  border: "1px solid #eee",
                  borderRadius: 6,
                  background: "#fafafa",
                  fontWeight: 600,
                  color: "#444",
                  whiteSpace: "nowrap",
                }}
              >
                <div>Protocol</div>
                <div
                  title="users/day"
                  style={{
                    textAlign: "right",
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, monospace",
                  }}
                >
                  👤 Users
                </div>
                <div
                  title="tx/day"
                  style={{
                    textAlign: "right",
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, monospace",
                  }}
                >
                  🔁 Tx
                </div>
                <div
                  title="cumulative tx"
                  style={{
                    textAlign: "right",
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, monospace",
                  }}
                >
                  Σ Tx
                </div>
                <div
                  style={{
                    textAlign: "right",
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, monospace",
                  }}
                >
                  Avg Tx/User
                </div>
                <div
                  style={{
                    textAlign: "right",
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, monospace",
                  }}
                >
                  Avg Fee (native)
                </div>
                <div
                  style={{
                    textAlign: "right",
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, monospace",
                  }}
                >
                  In / Out (d)
                </div>
              </div>
              {/* rows */}
              <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
                {rows.map((r) => (
                  <div
                    key={r.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "160px 90px 110px 120px 120px 130px 130px",
                      gap: 8,
                      fontSize: 11,
                      padding: "6px 8px",
                      border: "1px solid #eee",
                      borderRadius: 6,
                      background: "#fff",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {r.id}
                    </div>
                    <div
                      style={{
                        textAlign: "right",
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, monospace",
                      }}
                    >
                      {nf0.format(Number(r.usersDaily || 0))}
                    </div>
                    <div
                      style={{
                        textAlign: "right",
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, monospace",
                      }}
                    >
                      {nf0.format(Number(r.txDaily || 0))}
                    </div>
                    <div
                      style={{
                        textAlign: "right",
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, monospace",
                      }}
                    >
                      {r.txCumulative == null
                        ? "—"
                        : nf0.format(Number(r.txCumulative))}
                    </div>
                    <div
                      style={{
                        textAlign: "right",
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, monospace",
                      }}
                    >
                      {nf2.format(Number((r as any).avgTxPerUser ?? 0))}
                    </div>
                    <div
                      style={{
                        textAlign: "right",
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, monospace",
                      }}
                    >
                      {r.avgFeeNative == null
                        ? "—"
                        : Number.isFinite(Number(r.avgFeeNative))
                        ? Number(r.avgFeeNative).toFixed(6)
                        : String(r.avgFeeNative)}
                    </div>
                    <div
                      style={{
                        textAlign: "right",
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, monospace",
                      }}
                    >
                      {r.depositDaily == null
                        ? "—"
                        : nf0.format(Number(r.depositDaily))}
                      {" / "}
                      {r.withdrawDaily == null
                        ? "—"
                        : nf0.format(Number(r.withdrawDaily))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
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

// Minimal API response typing for latest decision endpoint
type LatestDecisionResponse = {
  decision?: {
    ts?: number;
    rollingHash?: string;
    featureHash?: string;
    featureHashV2?: string;
    aiRationaleHash?: string;
    actionType?: string;
    aiActionType?: string;
    riskScore?: number;
    aiRiskScore?: number;
    confidence?: number;
    aiConfidence?: number;
    modelHash?: string;
    rawScore?: number;
    logitZ?: number;
    mappingVersion?: string;
    weightsUsedHash?: string;
  } | null;
  verification?: {
    pass: boolean;
    checks: Record<string, { pass: boolean }>;
  } | null;
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
      const p = new URLSearchParams(window.location.search).get("hyper");
      if (p === null) return true; // default on
      return p !== "0";
    } catch {
      return true;
    }
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
              {Object.entries(latest.verification.checks).map(([k, v]) => {
                const vv = v as { pass: boolean };
                return (
                  <div key={k} style={{ color: vv.pass ? "#093" : "#b00" }}>
                    {vv.pass ? "✓" : "✗"} {k}
                  </div>
                );
              })}
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
