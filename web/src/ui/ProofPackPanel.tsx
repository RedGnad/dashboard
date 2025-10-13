import React, { useState } from "react";
import { keccak256 } from "viem";

interface PackFileMeta {
  name: string;
  keccak256?: string;
  size?: number;
}
interface Manifest {
  packKeccak256?: string;
  files?: PackFileMeta[];
  anchorRef?: string;
  rollingHash?: string;
  decisionRollingHash?: string;
  featureHash?: string;
}

const gzipMagic = [0x1f, 0x8b];

function isGzip(buf: Uint8Array) {
  return buf.length >= 2 && buf[0] === gzipMagic[0] && buf[1] === gzipMagic[1];
}

async function ungzip(buffer: ArrayBuffer): Promise<string> {
  // Use dynamic import of fflate (light) if available else fallback to browser DecompressionStream
  try {
    const { gunzipSync, strFromU8 } = (await import("fflate")) as any;
    const out = gunzipSync(new Uint8Array(buffer));
    return strFromU8(out);
  } catch {
    if (typeof (window as any).DecompressionStream === "function") {
      const ds = new (window as any).DecompressionStream("gzip");
      const blob = new Blob([buffer]);
      const stream = blob.stream().pipeThrough(ds);
      const ab = await new Response(stream).arrayBuffer();
      return new TextDecoder().decode(ab);
    }
    throw new Error(
      "Aucun décompresseur gzip disponible (fflate ou DecompressionStream manquant)"
    );
  }
}

function hexKeccakFromUtf8(text: string): string | null {
  try {
    // Reproduire exactement stringToHex backend: encoder en UTF-8 puis concaténer chaque octet -> hex string 0x...
    const enc = new TextEncoder().encode(text);
    let hex = "0x";
    for (const b of enc) hex += b.toString(16).padStart(2, "0");
    return keccak256(hex as any);
  } catch {
    return null;
  }
}

export const ProofPackPanel: React.FC<{ apiBase: string }> = ({ apiBase }) => {
  const [downloading, setDownloading] = useState(false);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [files, setFiles] = useState<
    { name: string; content: string }[] | null
  >(null);
  const [rehash, setRehash] = useState<{
    pack?: string;
    match?: boolean;
    error?: string;
  } | null>(null);
  const [anchors, setAnchors] = useState<any[]>([]);
  const [anchorLoadErr, setAnchorLoadErr] = useState<string>("");

  async function loadAnchors() {
    try {
      setAnchorLoadErr("");
      const js = await fetch(apiBase + "/api/strategy/anchors").then((r) =>
        r.json()
      );
      if (js?.ok) setAnchors(js.anchors || []);
    } catch (e: any) {
      setAnchorLoadErr(e?.message || "anchors_failed");
    }
  }

  async function download(anchor = false) {
    setDownloading(true);
    setManifest(null);
    setFiles(null);
    setRehash(null);
    try {
      const url =
        apiBase +
        "/api/strategy/proof-pack/latest" +
        (anchor ? "?anchor=1" : "");
      const res = await fetch(url);
      if (!res.ok) throw new Error("http_" + res.status);
      const arr = new Uint8Array(await res.arrayBuffer());
      if (!isGzip(arr)) throw new Error("pas gzip");
      const jsonText = await ungzip(arr.buffer);
      const pack = JSON.parse(jsonText);
      const fileArr = Array.isArray(pack.files) ? pack.files : [];
      const manifestFile = fileArr.find((f: any) => f.name === "manifest.json");
      if (!manifestFile) throw new Error("manifest.json manquant");
      let manifestObj: Manifest | null = null;
      try {
        manifestObj = JSON.parse(manifestFile.content);
      } catch {
        throw new Error("manifest.json invalide");
      }
      setManifest(manifestObj);
      setFiles(fileArr);
      // Re-hash canonical pré-image : reproduire EXACTEMENT la pré-image backend
      // Backend steps (see build-proof-pack / verify-proof-pack):
      // 1. manifestProvisional JSON.stringify(..., null, 2)
      // 2. bundleSansPack = { files: [...files, { name: 'manifest.json', content: manifestProvisionalString }] }
      // 3. packKeccak256 = keccak256(stringToHex(JSON.stringify(bundleSansPack)))
      try {
        // 1. Cloner manifest et retirer champs exclus
        const provisional = { ...manifestObj };
        delete (provisional as any).packKeccak256;
        delete (provisional as any).anchorRef;
        // 2. Reconstituer la liste des fichiers en conservant l'ordre actuel:
        //    Dans le pack, manifest.json est le DERNIER fichier.
        //    On reconstruit donc: autres fichiers dans l'ordre, puis manifest.json provisoire.
        const otherFiles = fileArr
          .filter((f: any) => f.name !== "manifest.json")
          .map((f: any) => ({ name: f.name, content: f.content }));
        const manifestProvisionalContent = JSON.stringify(provisional, null, 2);
        const provisionalFiles = [
          ...otherFiles,
          { name: "manifest.json", content: manifestProvisionalContent },
        ];
        // 3. Pré-image globale (outer JSON SANS indentation)
        const bundleSansPack = { files: provisionalFiles };
        const preImage = JSON.stringify(bundleSansPack);
        // 4. Hash local (UTF-8 -> hex -> keccak) — aligné avec backend
        const localHash = hexKeccakFromUtf8(preImage);
        if (!localHash) {
          setRehash({ error: "keccak local indisponible (js-sha3?)" });
        } else {
          setRehash({
            pack: localHash,
            match:
              !!manifestObj?.packKeccak256 &&
              localHash.toLowerCase() ===
                manifestObj.packKeccak256.toLowerCase(),
          });
        }
      } catch (e: any) {
        setRehash({ error: e?.message || "rehash_failed" });
      }
      loadAnchors();
    } catch (e: any) {
      setRehash({ error: e?.message || "download_failed" });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: 8,
        padding: 10,
        background: "#f8fbff",
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
          Proof Pack
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            disabled={downloading}
            onClick={() => download(false)}
            style={{ fontSize: 11 }}
          >
            {downloading ? "…" : "Télécharger"}
          </button>
          <button
            disabled={downloading}
            onClick={() => download(true)}
            style={{ fontSize: 11 }}
          >
            {downloading ? "…" : "Télécharger+Anchor"}
          </button>
          <button onClick={loadAnchors} style={{ fontSize: 11 }}>
            Anchors
          </button>
        </div>
      </div>
      {!manifest && !rehash?.error && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#666" }}>
          Aucun pack chargé.
        </div>
      )}
      {rehash?.error && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#b00" }}>
          Erreur: {rehash.error}
        </div>
      )}
      {manifest && (
        <div style={{ marginTop: 8, fontSize: 11 }}>
          <div>
            packKeccak256: <code>{manifest.packKeccak256?.slice(0, 30)}…</code>
          </div>
          {rehash && rehash.pack && (
            <div
              style={{ marginTop: 4, color: rehash.match ? "#0a5" : "#c22" }}
            >
              Re-hash local: {rehash.pack.slice(0, 30)}…{" "}
              {rehash.match ? "OK" : "Mismatch"}
            </div>
          )}
          {manifest.anchorRef && (
            <div style={{ marginTop: 4 }}>
              anchorRef: <code>{manifest.anchorRef}</code>
            </div>
          )}
          <div style={{ marginTop: 4 }}>
            rollingHash: <code>{manifest.rollingHash?.slice(0, 30)}…</code>
          </div>
          <div style={{ marginTop: 4 }}>
            decisionRollingHash:{" "}
            <code>{manifest.decisionRollingHash?.slice(0, 30)}…</code>
          </div>
          <div style={{ marginTop: 4 }}>
            featureHash: <code>{manifest.featureHash?.slice(0, 30)}…</code>
          </div>
          <div style={{ marginTop: 6 }}>Fichiers ({files?.length || 0}):</div>
          <ul
            style={{
              margin: 0,
              paddingLeft: 16,
              maxHeight: 120,
              overflow: "auto",
            }}
          >
            {files?.map((f) => (
              <li key={f.name} style={{ fontSize: 11 }}>
                {f.name}{" "}
                <span style={{ color: "#555" }}>
                  ({f.content?.length || 0} chars)
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 600 }}>Anchors récents:</div>
        {anchorLoadErr && (
          <div style={{ fontSize: 11, color: "#b00" }}>{anchorLoadErr}</div>
        )}
        {!anchors.length && !anchorLoadErr && (
          <div style={{ fontSize: 11, color: "#666" }}>—</div>
        )}
        {anchors.length > 0 && (
          <ul
            style={{
              margin: 0,
              paddingLeft: 16,
              maxHeight: 100,
              overflow: "auto",
            }}
          >
            {anchors
              .slice()
              .reverse()
              .slice(0, 10)
              .map((a) => (
                <li key={a.anchorRef || a.ts} style={{ fontSize: 10 }}>
                  {new Date(a.ts).toLocaleTimeString()} •{" "}
                  {String(a.packKeccak256 || "").slice(0, 14)}…{" "}
                  {a.anchorRef && <code>{a.anchorRef}</code>}
                </li>
              ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default ProofPackPanel;
