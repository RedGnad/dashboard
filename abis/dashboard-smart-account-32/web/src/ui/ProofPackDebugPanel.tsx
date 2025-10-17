import React, { useEffect, useState } from "react";

interface ProofPackDebugResponse {
  ok: boolean;
  manifestProvisional?: any;
  packKeccak256?: string;
  preImageLength?: number;
  error?: string;
}

interface PreImageLine {
  idx: number;
  text: string;
  category: "manifest-header" | "file" | "file-manifest-entry" | "other";
}

const smallHash = (h?: string) => (h ? h.slice(0, 18) + "…" : "—");

const CodeBlock: React.FC<{
  children: React.ReactNode;
  maxHeight?: number;
}> = ({ children, maxHeight = 160 }) => (
  <pre
    style={{
      background: "#0b0b0b",
      color: "#d6f8d6",
      padding: 8,
      fontSize: 10,
      lineHeight: 1.35,
      borderRadius: 6,
      overflow: "auto",
      maxHeight,
      margin: 0,
    }}
  >
    {children}
  </pre>
);

// Pretty renders manifestProvisional in stable key order (sorted) to highlight canonical hashing intent
function stableStringify(obj: any): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(stableStringify).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
      .join(",") +
    "}"
  );
}

export const ProofPackDebugPanel: React.FC<{ apiBase: string }> = ({
  apiBase,
}) => {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ProofPackDebugResponse | null>(null);
  const [error, setError] = useState<string>("");
  const [expanded, setExpanded] = useState<boolean>(false);
  const [preImagePreview, setPreImagePreview] = useState<PreImageLine[] | null>(
    null
  );
  const [copyStatus, setCopyStatus] = useState<string>("");

  async function load() {
    setLoading(true);
    setError("");
    setPreImagePreview(null);
    try {
      const res = await fetch(apiBase + "/api/proof-pack/debug");
      const js: ProofPackDebugResponse = await res.json();
      if (!js.ok) throw new Error(js.error || "debug_failed");
      setData(js);
      buildPreImagePreview(js);
    } catch (e: any) {
      setError(e?.message || "fetch_failed");
    } finally {
      setLoading(false);
    }
  }

  function buildPreImagePreview(js: ProofPackDebugResponse) {
    try {
      const prov = js.manifestProvisional;
      if (!prov) return;
      // Reconstruct provisional manifest pretty (same indentation backend uses for manifest.json inside pre-image)
      const manifestPretty = JSON.stringify(prov, null, 2);
      // Pre-image structure: { "files": [ ...nonManifestFiles, { name:'manifest.json', content: <manifestPretty> } ] }
      // We can't show full JSON (could be large); instead produce synthetic preview lines.
      const lines: PreImageLine[] = [];
      // Manifest header subset (+ stable ordering demonstration)
      const headerKeys = [
        "schemaVersion",
        "buildTs",
        "decisionRollingHash",
        "featureHash",
        "modelHash",
      ];
      headerKeys.forEach((k, i) => {
        if (prov[k] !== undefined)
          lines.push({
            idx: lines.length,
            text: `manifest.${k} = ${JSON.stringify(prov[k])}`,
            category: "manifest-header",
          });
      });
      if (Array.isArray(prov.files)) {
        prov.files.forEach((f: any) => {
          lines.push({
            idx: lines.length,
            text: `file ${f.name} keccak256=${f.keccak256?.slice(0, 18)}…`,
            category: "file",
          });
        });
      }
      lines.push({
        idx: lines.length,
        text: "— manifest.json (provisional pretty JSON) —",
        category: "file-manifest-entry",
      });
      manifestPretty
        .split("\n")
        .slice(0, 40)
        .forEach((l: string) => {
          lines.push({
            idx: lines.length,
            text: l,
            category: "file-manifest-entry",
          });
        });
      if (manifestPretty.split("\n").length > 40) {
        lines.push({
          idx: lines.length,
          text: "… (truncated)",
          category: "other",
        });
      }
      setPreImagePreview(lines);
    } catch {}
  }

  useEffect(() => {
    load();
  }, []);

  const prov = data?.manifestProvisional;

  async function copyText(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus(label + " copié");
      setTimeout(() => setCopyStatus(""), 1800);
    } catch (e: any) {
      setCopyStatus("échec copie");
      setTimeout(() => setCopyStatus(""), 2000);
    }
  }

  return (
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: 8,
        padding: 10,
        background: "#fffdf8",
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
          Proof Pack Debug
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={load} disabled={loading} style={{ fontSize: 11 }}>
            {loading ? "…" : "Refresh"}
          </button>
          <button
            onClick={() => setExpanded((e) => !e)}
            style={{ fontSize: 11 }}
          >
            {expanded ? "Réduire" : "Détails"}
          </button>
        </div>
      </div>
      {error && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#b00" }}>
          Erreur: {error}
        </div>
      )}
      {!error && !prov && !loading && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#666" }}>
          Aucune donnée (pas encore de décision?).
        </div>
      )}
      {prov && (
        <div style={{ marginTop: 6, fontSize: 11 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span>
              Pack pre-image hash: <code>{smallHash(data?.packKeccak256)}</code>
            </span>
            {data?.packKeccak256 && (
              <button
                style={{ fontSize: 10 }}
                onClick={() => copyText("hash", data.packKeccak256!)}
              >
                Copy
              </button>
            )}
          </div>
          <div>Pre-image length: {data?.preImageLength}</div>
          <div style={{ marginTop: 4 }}>
            Files: {Array.isArray(prov.files) ? prov.files.length : 0}
          </div>
          <div style={{ marginTop: 4, fontSize: 10, color: "#555" }}>
            NB: packKeccak256 = keccak256(UTF8(JSON(
            {`{files:[... , manifest.json(provisional)]}`})))
          </div>
          {preImagePreview && (
            <div style={{ marginTop: 6 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                  color: "#444",
                }}
              >
                Pré‑image (aperçu synthétique)
              </div>
              <CodeBlock maxHeight={expanded ? 380 : 160}>
                {preImagePreview.map((l) => (
                  <div
                    key={l.idx}
                    style={{
                      color:
                        l.category === "manifest-header"
                          ? "#9ef"
                          : l.category === "file"
                          ? "#fea"
                          : l.category === "file-manifest-entry"
                          ? "#cfc"
                          : "#eee",
                    }}
                  >
                    {l.text}
                  </div>
                ))}
              </CodeBlock>
            </div>
          )}
          {expanded && (
            <div style={{ marginTop: 8 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  color: "#444",
                }}
              >
                Manifest Provisional (stable stringify)
              </div>
              <div style={{ marginBottom: 4 }}>
                <button
                  style={{ fontSize: 10 }}
                  onClick={() => copyText("manifest", stableStringify(prov))}
                >
                  Copy manifest
                </button>
              </div>
              <CodeBlock maxHeight={320}>{stableStringify(prov)}</CodeBlock>
            </div>
          )}
          {copyStatus && (
            <div style={{ marginTop: 4, fontSize: 10, color: "#056" }}>
              {copyStatus}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ProofPackDebugPanel;
