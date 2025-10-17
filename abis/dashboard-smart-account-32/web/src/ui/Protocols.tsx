import React, { useMemo } from "react";
import { ProtocolMetricsPanel } from "./AiDashboard";

export default function Protocols({ apiBase }: { apiBase?: string }) {
  const base = useMemo(
    () =>
      (
        apiBase ||
        (import.meta as any)?.env?.VITE_API_BASE ||
        "http://127.0.0.1:8787"
      ).replace(/\/$/, ""),
    [apiBase]
  );
  return (
    <div style={{ maxWidth: 1100, margin: "20px auto", padding: "0 12px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <h2 style={{ margin: 0 }}>Protocol Metrics</h2>
        <small style={{ color: "#666" }}>Data source: Envio (Hosted)</small>
      </div>
      <div style={{ marginTop: 10 }}>
        <ProtocolMetricsPanel apiBase={base} />
      </div>
    </div>
  );
}
