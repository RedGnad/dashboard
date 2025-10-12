import React, { useEffect, useMemo, useState } from "react";

export default function AiActions({
  apiBase,
  defaultDelegator,
}: {
  apiBase: string;
  defaultDelegator?: string;
}) {
  const base = useMemo(() => (apiBase || "").replace(/\/$/, ""), [apiBase]);
  const [delegator, setDelegator] = useState(
    defaultDelegator && defaultDelegator.startsWith("0x")
      ? defaultDelegator
      : "0x1111111111111111111111111111111111111111"
  );
  const [profile, setProfile] = useState<
    "default" | "conservative" | "aggressive"
  >("default");
  const [provider, setProvider] = useState<
    "openai" | "opengradient" | "local" | "og-stub"
  >("openai");
  const [unwrap, setUnwrap] = useState(false);
  const [dynamicByAI, setDynamicByAI] = useState(true);
  const [respectAiAction, setRespectAiAction] = useState(true);
  const [amountPolicy, setAmountPolicy] = useState<"fixed" | "pctBalance">(
    "fixed"
  );
  // Multi-asset controls for AI autopilot
  const [source, setSource] = useState<"USDC" | "MON">("USDC");
  const [targetSymbol, setTargetSymbol] = useState<string>("WMON");
  const [slippageBps, setSlippageBps] = useState<string>("100");
  // Optional: tokens CSV for preview to steer multi-asset targeting in preview
  const [tokensCsv, setTokensCsv] = useState<string>("");
  const [amountFixed, setAmountFixed] = useState("1");
  const [sizePct, setSizePct] = useState("0.10");
  const [minUSDC, setMinUSDC] = useState("0");
  const [maxUSDC, setMaxUSDC] = useState("");
  const [out, setOut] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [tokensMeta, setTokensMeta] = useState<
    Record<string, { symbol: string; address: string; decimals: number; isStable?: boolean }>
  >({});
  const [auto, setAuto] = useState<{
    active: boolean;
    interval: string;
    lastRunAt?: number;
    runsDone?: number;
    error?: string | null;
  }>({ active: false, interval: "60" });

  // Sync with parent-provided defaultDelegator once it's known (derived SA ready)
  useEffect(() => {
    if (defaultDelegator && defaultDelegator.startsWith("0x")) {
      // Update if current value is placeholder or invalid
      const isPlaceholder =
        /^0x1{40}$/i.test(delegator) ||
        !delegator ||
        !delegator.startsWith("0x");
      if (
        isPlaceholder ||
        delegator.toLowerCase() !== defaultDelegator.toLowerCase()
      ) {
        setDelegator(defaultDelegator);
      }
    }
  }, [defaultDelegator]);

  async function callJson(url: string, init?: RequestInit) {
    setBusy(true);
    setOut(null);
    try {
      const r = await fetch(url, init);
      const txt = await r.text();
      let js: any = null;
      try {
        js = txt ? JSON.parse(txt) : null;
      } catch {
        js = { ok: false, error: "invalid_json", raw: txt };
      }
      setOut(js);
    } catch (e: any) {
      setOut({ ok: false, error: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  }

  // Scheduler helpers
  async function refreshScheduler() {
    try {
      const r = await fetch(base + "/api/scheduler/status");
      const js = await r.json();
      if (!js.ok) throw new Error(js.error || "status_failed");
      const job = Array.isArray(js.jobs)
        ? js.jobs.find(
            (j: any) =>
              (j?.delegatorSA || "").toLowerCase() === delegator.toLowerCase()
          )
        : null;
      if (job) {
        setAuto((a) => ({
          ...a,
          active: !!job.active,
          interval: String(job.intervalSec || a.interval || "60"),
          lastRunAt: job.lastRunAt,
          runsDone: job.runsDone,
          error: null,
        }));
      } else {
        setAuto((a) => ({ ...a, active: false, error: null }));
      }
    } catch (e: any) {
      setAuto((a) => ({ ...a, error: e?.message || String(e) }));
    }
  }
  useEffect(() => {
    if (!delegator || !delegator.startsWith("0x")) return;
    refreshScheduler();
    const t = setInterval(refreshScheduler, 15000);
    return () => clearInterval(t);
  }, [base, delegator]);

  // Fetch tokens registry once for target selection
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(base + "/api/tokens").then((x) => x.json());
        if (r && r.ok && r.tokens) {
          setTokensMeta(r.tokens || {});
          if (!r.tokens[targetSymbol]) {
            if (r.tokens.WMON) setTargetSymbol("WMON");
            else {
              const first = Object.keys(r.tokens)[0];
              if (first) setTargetSymbol(first);
            }
          }
        }
      } catch {}
    })();
  }, [base]);

  async function startAutopilot() {
    setBusy(true);
    try {
      const r = await fetch(base + "/api/scheduler/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          delegator,
          intervalSec: Math.max(5, Number(auto.interval || 60)),
          immediate: true,
          unwrapToMon: unwrap,
          dynamicByAI,
          respectAiAction,
          provider,
          allowSellExecution: true,
          source,
          targetSymbol,
          slippageBps: Number.isFinite(Number(slippageBps))
            ? Number(slippageBps)
            : undefined,
          amountPolicy,
          // Fixed amount in selected source; pctBalance uses sizePct/min/max USDC
          ...(amountPolicy === "fixed"
            ? source === "MON"
              ? { amountMON: Number(amountFixed || "1") }
              : { amountUSDC: Number(amountFixed || "1") }
            : {}),
          sizePct:
            amountPolicy === "pctBalance" ? Number(sizePct || "0") : undefined,
          minUSDC:
            amountPolicy === "pctBalance" && minUSDC !== ""
              ? Number(minUSDC)
              : undefined,
          maxUSDC:
            amountPolicy === "pctBalance" && maxUSDC !== ""
              ? Number(maxUSDC)
              : undefined,
        }),
      });
      const js = await r.json();
      setOut(js);
      await refreshScheduler();
    } catch (e: any) {
      setOut({ ok: false, error: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  }
  async function stopAutopilot() {
    setBusy(true);
    try {
      const r = await fetch(base + "/api/scheduler/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delegator }),
      });
      const js = await r.json();
      setOut(js);
      await refreshScheduler();
    } catch (e: any) {
      setOut({ ok: false, error: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  }

  // Download latest proof pack as gzip (binary) and trigger a file save
  async function downloadProofPack() {
    setBusy(true);
    setOut(null);
    try {
      const r = await fetch(base + "/api/strategy/proof-pack/latest");
      const ct = r.headers.get("content-type") || "";
      if (!r.ok || !ct.includes("application/gzip")) {
        const txt = await r.text();
        let js: any = null;
        try {
          js = txt ? JSON.parse(txt) : null;
        } catch {
          js = { ok: false, error: "invalid_json", raw: txt };
        }
        setOut(js);
        return;
      }
      const cd = r.headers.get("content-disposition") || "";
      const match = cd.match(/filename="?([^";]+)"?/i);
      const filename = match ? match[1] : `proof-pack-${Date.now()}.json.gz`;
      const packKeccak = r.headers.get("x-pack-keccak256") || undefined;
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 0);
      setOut({
        ok: true,
        downloaded: filename,
        size: blob.size,
        packKeccak256: packKeccak,
      });
    } catch (e: any) {
      setOut({ ok: false, error: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  }

  // Execute last AI decision for this delegator (optionally force bypass guardrails)
  async function executeLast(force = false) {
    setBusy(true);
    setOut(null);
    try {
      const r = await fetch(base + "/api/strategy/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delegator, force }),
      });
      const txt = await r.text();
      let js: any = null;
      try {
        js = txt ? JSON.parse(txt) : null;
      } catch {
        js = { ok: false, error: "invalid_json", raw: txt };
      }
      setOut(js);
    } catch (e: any) {
      setOut({ ok: false, error: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: 8,
        padding: 12,
        background: "#fdfefe",
        marginTop: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <strong style={{ fontSize: 14 }}>AI Actions</strong>
        <span style={{ fontSize: 11, color: "#777" }}>
          Contrôle l’IA côté backend. Déléguant = Smart Account du user (dérivé
          plus haut dans l’app). Le délégué SA (opérateur) est géré par le
          système; OG pilote le délégué.
        </span>
      </div>
      <div
        style={{
          display: "flex",
          gap: 10,
          marginTop: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <label style={{ fontSize: 12 }}>
          Delegator:
          <input
            value={delegator}
            onChange={(e) => setDelegator(e.target.value)}
            style={{ marginLeft: 6, width: 360 }}
          />
        </label>
        <label style={{ fontSize: 12 }}>
          Profile:
          <select
            value={profile}
            onChange={(e) => setProfile(e.target.value as any)}
            style={{ marginLeft: 6 }}
          >
            <option value="default">default</option>
            <option value="conservative">conservative</option>
            <option value="aggressive">aggressive</option>
          </select>
        </label>
        <label style={{ fontSize: 12 }}>
          Provider:
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as any)}
            style={{ marginLeft: 6 }}
          >
            <option value="openai">openai</option>
            <option value="opengradient">opengradient</option>
            <option value="og-stub">og-stub</option>
            <option value="local">local</option>
          </select>
        </label>
        <label style={{ fontSize: 12 }}>
          Source:
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as any)}
            style={{ marginLeft: 6 }}
          >
            <option value="USDC">USDC</option>
            <option value="MON">MON</option>
          </select>
        </label>
        <label style={{ fontSize: 12 }}>
          Target token:
          <select
            value={targetSymbol}
            onChange={(e) => setTargetSymbol(e.target.value)}
            style={{ marginLeft: 6, minWidth: 100 }}
          >
            {Object.keys(tokensMeta)
              .sort()
              .map((sym) => (
                <option key={sym} value={sym}>
                  {sym}
                </option>
              ))}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>
          Slippage (bps):
          <input
            value={slippageBps}
            onChange={(e) => setSlippageBps(e.target.value)}
            style={{ marginLeft: 6, width: 70 }}
          />
        </label>
        <label style={{ fontSize: 12 }}>
          Unwrap to MON:
          <input
            type="checkbox"
            checked={unwrap}
            onChange={(e) => setUnwrap(e.target.checked)}
            style={{ marginLeft: 6 }}
          />
        </label>
      </div>
      {/* Sizing policy */}
      <div
        style={{
          display: "flex",
          gap: 10,
          marginTop: 6,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <label style={{ fontSize: 12 }}>
          Amount policy:
          <select
            value={amountPolicy}
            onChange={(e) => setAmountPolicy(e.target.value as any)}
            style={{ marginLeft: 6 }}
          >
            <option value="fixed">fixed</option>
            <option value="pctBalance">pctBalance</option>
          </select>
        </label>
        {amountPolicy === "fixed" ? (
          <label style={{ fontSize: 12 }}>
            Amount ({source}):
            <input
              value={amountFixed}
              onChange={(e) => setAmountFixed(e.target.value)}
              style={{ marginLeft: 6, width: 90 }}
            />
          </label>
        ) : (
          <>
            <label style={{ fontSize: 12 }}>
              sizePct (0-1):
              <input
                value={sizePct}
                onChange={(e) => setSizePct(e.target.value)}
                style={{ marginLeft: 6, width: 80 }}
              />
            </label>
            <label style={{ fontSize: 12 }}>
              minUSDC:
              <input
                value={minUSDC}
                onChange={(e) => setMinUSDC(e.target.value)}
                style={{ marginLeft: 6, width: 80 }}
              />
            </label>
            <label style={{ fontSize: 12 }}>
              maxUSDC:
              <input
                value={maxUSDC}
                onChange={(e) => setMaxUSDC(e.target.value)}
                placeholder=""
                style={{ marginLeft: 6, width: 80 }}
              />
            </label>
          </>
        )}
        <label style={{ fontSize: 12 }}>
          Dynamic by AI:
          <input
            type="checkbox"
            checked={dynamicByAI}
            onChange={(e) => setDynamicByAI(e.target.checked)}
            style={{ marginLeft: 6 }}
          />
        </label>
        <label style={{ fontSize: 12 }}>
          Respect AI action:
          <input
            type="checkbox"
            checked={respectAiAction}
            onChange={(e) => setRespectAiAction(e.target.checked)}
            style={{ marginLeft: 6 }}
          />
        </label>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button
          disabled={busy}
          onClick={() => callJson(base + "/api/inference/provider")}
        >
          Provider
        </button>
        <label style={{ fontSize: 12, display: "inline-flex", alignItems: "center" }}>
          Tokens (preview):
          <input
            value={tokensCsv}
            onChange={(e) => setTokensCsv(e.target.value)}
            placeholder="WMON,BEAN,CHOG"
            title="Aide la prévisualisation IA à considérer ces tokens (séparés par des virgules). L'exécution DCA IA utilisera la cible choisie au-dessus."
            style={{ marginLeft: 6, width: 240 }}
          />
        </label>
        <button
          disabled={busy}
          onClick={() =>
            callJson(
              base +
                `/api/strategy/preview?delegator=${encodeURIComponent(
                  delegator
                )}&profile=${encodeURIComponent(
                  profile
                )}&provider=${encodeURIComponent(provider)}${
                  tokensCsv.trim()
                    ? `&tokens=${encodeURIComponent(tokensCsv.trim())}`
                    : ""
                }`
            )
          }
        >
          Preview
        </button>
        <button
          disabled={busy}
          onClick={() =>
            callJson(
              base +
                `/api/strategy/preview?delegator=${encodeURIComponent(
                  delegator
                )}&profile=${encodeURIComponent(
                  profile
                )}&force=buy&provider=${encodeURIComponent(provider)}${
                  tokensCsv.trim()
                    ? `&tokens=${encodeURIComponent(tokensCsv.trim())}`
                    : ""
                }`
            )
          }
        >
          Preview (force buy)
        </button>
        <button
          disabled={busy}
          onClick={() =>
            callJson(
              base +
                `/api/strategy/preview?delegator=${encodeURIComponent(
                  delegator
                )}&profile=${encodeURIComponent(
                  profile
                )}&force=sell&provider=${encodeURIComponent(provider)}${
                  tokensCsv.trim()
                    ? `&tokens=${encodeURIComponent(tokensCsv.trim())}`
                    : ""
                }`
            )
          }
        >
          Preview (force sell)
        </button>
        <button
          disabled={busy}
          onClick={() => callJson(base + "/api/strategy/decision/latest")}
        >
          Latest
        </button>
        <button disabled={busy} onClick={downloadProofPack}>
          Proof Pack (download)
        </button>
        <button disabled={busy} onClick={() => executeLast(false)}>
          Execute last decision
        </button>
        <button disabled={busy} onClick={() => executeLast(true)}>
          Execute last decision (force)
        </button>
        <button
          disabled={busy}
          onClick={() =>
            callJson(base + "/api/strategy/decision/force", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                delegator,
                profile,
                provider,
              }),
            })
          }
        >
          Force decision
        </button>
        <button
          disabled={busy}
          onClick={() =>
            callJson(base + "/api/strategy/decision/force", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                delegator,
                profile,
                provider,
                force: "buy",
              }),
            })
          }
        >
          Force decision (buy)
        </button>
        <button
          disabled={busy}
          onClick={() =>
            callJson(base + "/api/strategy/decision/force", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                delegator,
                profile,
                provider,
                force: "sell",
              }),
            })
          }
        >
          Force decision (sell)
        </button>
        {/* Autopilot controls */}
        <span
          style={{
            marginLeft: 8,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <label style={{ fontSize: 12 }}>
            Autopilot (sec):
            <input
              value={auto.interval}
              onChange={(e) =>
                setAuto((a) => ({ ...a, interval: e.target.value }))
              }
              style={{ width: 60, marginLeft: 6 }}
            />
          </label>
          <button disabled={busy || !delegator} onClick={startAutopilot}>
            Start
          </button>
          <button disabled={busy || !delegator} onClick={stopAutopilot}>
            Stop
          </button>
          <span
            title={
              auto.lastRunAt ? new Date(auto.lastRunAt).toLocaleString() : ""
            }
            style={{
              padding: "2px 8px",
              borderRadius: 12,
              background: auto.active ? "#0a6d32" : "#777",
              color: "#fff",
              fontSize: 12,
            }}
          >
            {auto.active ? "Active" : "Stopped"}
          </span>
          {typeof auto.runsDone === "number" && (
            <span style={{ fontSize: 12, color: "#555" }}>
              runs: {auto.runsDone}
            </span>
          )}
        </span>
      </div>
      <div style={{ marginTop: 10, fontSize: 12 }}>
        <div style={{ fontSize: 11, color: "#555" }}>
          Réponse (affiche ok/erreur et payload):
        </div>
        <pre
          style={{
            background: "#0b0b0b",
            color: "#eee",
            padding: 10,
            borderRadius: 8,
            maxHeight: 280,
            overflow: "auto",
          }}
        >
          {out ? JSON.stringify(out, null, 2) : busy ? "…" : "(vide)"}
        </pre>
      </div>
    </div>
  );
}
