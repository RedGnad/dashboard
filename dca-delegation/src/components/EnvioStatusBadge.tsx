import React from "react";
import { useEnvioMetrics } from "../hooks/useEnvioMetrics";
import { getEnvioUrl } from "../lib/envioClient";

function shortId(url: string) {
  try {
    const m = url.match(/\/([0-9a-f]{7,8})\//i);
    return m ? m[1] : new URL(url).host;
  } catch {
    return url;
  }
}

export default function EnvioStatusBadge() {
  const { metrics, loading } = useEnvioMetrics();
  const url = getEnvioUrl();
  const id = shortId(url);
  const [threshold, setThreshold] = React.useState<number>(() => {
    try {
      const v = localStorage.getItem("whaleThresholdUsd");
      return v ? Number(v) : 10000;
    } catch {
      return 10000;
    }
  });

  const onChangeThreshold = (val: number) => {
    setThreshold(val);
    try {
      localStorage.setItem("whaleThresholdUsd", String(val));
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("whale:threshold", { detail: val })
        );
      }
    } catch {}
  };
  const sinceUTC = (() => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 19) + "Z";
  })();

  return (
    <div className="fixed top-3 right-3 z-50 text-xs">
      <div className="backdrop-blur bg-black/40 border border-white/10 text-white rounded-md px-3 py-2 shadow-lg">
        <div className="font-semibold">
          Envio: <span className="text-emerald-300">{id || "n/a"}</span>
        </div>
        <div className="opacity-80">
          txToday: {loading ? "…" : metrics.txToday}
        </div>
        <div className="mt-1 flex items-center gap-2 opacity-90">
          <span className="text-gray-300">Whale≥</span>
          <select
            className="bg-black/30 border border-white/10 rounded px-1 py-0.5"
            value={String(threshold)}
            onChange={(e) => onChangeThreshold(Number(e.target.value))}
            title="Seuil des whales (USD)"
          >
            {[10000, 50000, 500000, 1000000].map((v) => (
              <option key={v} value={v}>
                {v.toLocaleString()} USDC{v === 1000000 ? "+" : ""}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="sr-only">since {sinceUTC}</div>
    </div>
  );
}
