import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useWalletClient,
} from "wagmi";
import { injected } from "@wagmi/connectors";
import { Address, Hex, encodeFunctionData, parseUnits } from "viem";
import {
  Implementation,
  toMetaMaskSmartAccount,
  createOpenDelegation,
  getDeleGatorEnvironment,
} from "@metamask/delegation-toolkit";
// Monad testnet UniswapV2 Router02
const UNISWAP_V2_ROUTER02 =
  "0xfb8e1c3b833f9e67a71c859a132cf783b645e436" as Address;

const USDC = "0xf817257fed379853cDe0fa4F97AB987181B1E5Ea" as Address;
const WMON = "0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701" as Address;

export default function App() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const apiBase = useMemo(() => {
    const hinted = (import.meta as any)?.env?.VITE_API_BASE as
      | string
      | undefined;
    if (hinted) return hinted.replace(/\/$/, "");
    try {
      const loc = window.location;
      return loc.port === "5173" ? "http://127.0.0.1:8787" : "";
    } catch {
      return "";
    }
  }, []);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [lastUserOp, setLastUserOp] = useState<{
    hash?: string;
    txHash?: string;
    status?: string;
    polling?: boolean;
    countdown?: number;
  } | null>(null);
  const pollRef = useRef<number | null>(null);
  // DCA job state for current delegator SA
  const [job, setJob] = useState<{
    delegatorSA: string;
    intervalSec: number;
    active: boolean;
    lastRunAt?: number;
    lastOpHash?: string;
    lastError?: string;
    expiresAt?: number;
    runsDone?: number;
  } | null>(null);
  const [emissionCountdown, setEmissionCountdown] = useState<number | null>(
    null
  );
  const jobRef = useRef<typeof job>(null);
  const jobPollRef = useRef<number | null>(null);
  const [hasDelegation, setHasDelegation] = useState<boolean>(false);
  const [amount, setAmount] = useState("1");
  const [slippageBps, setSlippageBps] = useState("100");
  const [unwrapToMon, setUnwrapToMon] = useState(false);
  const [saPanel, setSaPanel] = useState<{
    eoa?: string;
    delegator?: {
      address: string; // Smart Account address
      mon?: string;
      usdc?: string;
    };
    delegate?: {
      eoa?: string;
      sa?: string;
      mon?: string;
      usdc?: string;
    };
    quote?: { in?: string; out?: string };
    error?: string;
  }>({});
  const usePaymaster = useMemo(() => {
    try {
      const pm = new URLSearchParams(window.location.search).get("pm");
      // Default to paymaster disabled while debugging AA policy; enable with ?pm=1
      return pm === null ? false : pm === "1";
    } catch {
      return true;
    }
  }, []);

  const injectedConnector = useMemo(() => injected(), []);

  async function refreshSaPanel() {
    try {
      // fetch delegate info
      const delRes = await fetch(`${apiBase || ""}/api/delegate`)
        .then((r) => r.json())
        .catch(() => ({}));
      const delegate = {
        eoa: delRes?.eoa,
        sa: delRes?.sa,
      } as any;
      // derive user's smart account deterministically (Hybrid) using DTK environment
      let delegatorSa: string | undefined = undefined;
      try {
        if (address && publicClient && walletClient) {
          const env = getDeleGatorEnvironment(10143);
          const smart = await toMetaMaskSmartAccount({
            client: publicClient,
            implementation: Implementation.Hybrid,
            deployParams: [address as Address, [], [], []],
            deploySalt: "0x",
            signer: { walletClient: walletClient as any },
            environment: env as any,
          });
          delegatorSa = smart.address;
        }
      } catch (e) {
        // fall back to EOA if derivation fails (will be less accurate)
        delegatorSa = address;
      }

      // fetch diagnostics for balances and quote (use Delegator SA address)
      const diagUrl = new URL("/api/diag", apiBase || window.location.origin);
      if (delegatorSa) diagUrl.searchParams.set("delegator", delegatorSa);
      diagUrl.searchParams.set(
        "amountUsdc",
        (parseFloat(amount || "1") * 1e6).toFixed(0)
      );
      const diag = await fetch(diagUrl.toString()).then((r) => r.json());

      const next: any = {};
      if (address) next.eoa = address;
      if (delegatorSa) {
        next.delegator = { address: delegatorSa };
        const db = diag?.delegatorBalances;
        if (db) {
          next.delegator.mon = db.mon;
          next.delegator.usdc = db.usdc;
        }
      }
      if (delegate?.sa) {
        next.delegate = { eoa: delegate.eoa, sa: delegate.sa };
        const ddb = diag?.delegateBalances;
        if (ddb) {
          next.delegate.mon = ddb.mon;
          next.delegate.usdc = ddb.usdc;
        }
      }
      if (diag?.quote) next.quote = diag.quote;
      if (
        diag?.delegateBalancesError ||
        diag?.delegatorBalancesError ||
        diag?.quoteError
      ) {
        next.error =
          diag?.delegateBalancesError ||
          diag?.delegatorBalancesError ||
          diag?.quoteError;
      }
      setSaPanel(next);
    } catch (e: any) {
      setSaPanel({ error: e?.message || String(e) });
    }
  }

  useEffect(() => {
    if (isConnected) {
      refreshSaPanel();
    } else {
      setSaPanel({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected]);

  async function createAndPostDelegation() {
    if (!address || !publicClient || !walletClient) return;
    setBusy(true);
    setMsg("Preparing smart account…");
    try {
      // Get delegate SA from backend (safe JSON parse)
      console.log("[ui] API base:", apiBase || "(same-origin)");
      const infoRes = await fetch(`${apiBase || ""}/api/delegate`);
      const infoText = await infoRes.text();
      let info: any = {};
      try {
        info = infoText ? JSON.parse(infoText) : {};
      } catch {
        info = {};
      }
      if (!infoRes.ok)
        throw new Error(
          info?.error || `GET /api/delegate failed (${infoRes.status})`
        );
      if (!info?.sa)
        throw new Error("Delegate smart account not available from backend");

      // Resolve DTK environment early (before use)
      const env = getDeleGatorEnvironment(10143);
      if (!env) {
        setMsg("Erreur: environnement DelegationToolkit introuvable");
        setBusy(false);
        return;
      }

      // Derive user's MetaMask smart account (no tx, deterministic) with DTK environment
      const smart = await toMetaMaskSmartAccount({
        client: publicClient,
        implementation: Implementation.Hybrid,
        deployParams: [address as Address, [], [], []],
        deploySalt: "0x",
        signer: { walletClient: walletClient as any },
        environment: env as any,
      });

      setMsg(`Smart account: ${smart.address}\nCreating delegation…`);

      // Build exact executions: approve USDC -> router, then swap USDC->WMON to the delegator smart account
      const amt = parseUnits(amount || "1", 6);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 60); // +1h
      const approveCalldata: Hex = encodeFunctionData({
        abi: [
          {
            name: "approve",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "spender", type: "address" },
              { name: "amount", type: "uint256" },
            ],
            outputs: [{ name: "", type: "bool" }],
          },
        ] as any,
        functionName: "approve",
        args: [UNISWAP_V2_ROUTER02, amt],
      });
      const swapCalldata: Hex = encodeFunctionData({
        abi: [
          {
            name: "swapExactTokensForTokens",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "amountIn", type: "uint256" },
              { name: "amountOutMin", type: "uint256" },
              { name: "path", type: "address[]" },
              { name: "to", type: "address" },
              { name: "deadline", type: "uint256" },
            ],
            outputs: [{ name: "amounts", type: "uint256[]" }],
          },
        ] as any,
        functionName: "swapExactTokensForTokens",
        args: [amt, 0n, [USDC, WMON], smart.address as Address, deadline],
      });
      const executions = [
        { target: USDC, value: 0n, callData: approveCalldata },
        { target: UNISWAP_V2_ROUTER02, value: 0n, callData: swapCalldata },
      ];
      console.log("executions", executions);
      console.log("delegateSA", info.sa);
      if (!Array.isArray(executions) || executions.length === 0) {
        setMsg("Erreur: executions introuvables");
        setBusy(false);
        return;
      }

      // Official flow only: createOpenDelegation with functionCall scope and selectors/targets. No fallback.
      const targets: Address[] = [USDC, UNISWAP_V2_ROUTER02];
      const selectors: Hex[] = [
        "0x095ea7b3", // approve(address,uint256)
        "0x38ed1739", // swapExactTokensForTokens
      ];
      const delegation = createOpenDelegation({
        environment: env as any,
        from: smart.address as Address,
        scope: {
          type: "functionCall",
          targets,
          selectors,
        } as any,
      });

      setMsg("Signing delegation…");
      const signature = await smart.signDelegation({ delegation });

      setMsg("Posting to backend…");
      // JSON-sûr: convertir BigInt -> string pour le champ value des executions
      const executionsJson = executions.map((e) => ({
        target: e.target,
        value: e.value.toString(),
        callData: e.callData,
      }));
      const res = await fetch(`${apiBase || ""}/api/delegations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          delegatorSA: smart.address,
          signedDelegation: { delegation, signature },
          job: {
            amountUSDC: amount,
            slippageBps: Number(slippageBps),
            intervalSec: 60,
            durationSec: 24 * 60 * 60,
            unwrapToMon,
            usePaymaster,
            // Echo back executions shape for server side logging/debug if needed
            executions: executionsJson,
          },
        }),
      }).then(async (r) => {
        // Safe JSON parsing to avoid "Unexpected end of JSON input"
        const t = await r.text();
        let body: any = {};
        try {
          body = t ? JSON.parse(t) : {};
        } catch {
          body = {};
        }
        return { status: r.status, body };
      });

      console.log("POST /api/delegations ->", res.body);
      if (res.status === 200 && res.body?.ok) {
        setHasDelegation(true);
        if (res.body?.job) {
          setJob(res.body.job);
          jobRef.current = res.body.job;
        }
        const hash = res.body.userOperationHash as string | undefined;
        if (hash) {
          setMsg(
            `Delegation saved. userOperationHash: ${hash}\nTracking inclusion for up to 60s…`
          );
          startUserOpPolling(hash, 60);
        } else {
          setMsg("Delegation saved. Backend can now execute your DCA.");
        }
      } else {
        const errMsg = res.body?.error || res.body?.details || "Backend error";
        const reason = res.body?.revertReason
          ? `\nReason: ${res.body.revertReason}`
          : "";
        const debug = res.body?.debug
          ? `\nDebug: ${JSON.stringify(res.body.debug, null, 2)}`
          : "";
        console.error("Backend error", res.body);
        throw new Error(errMsg + reason + debug);
      }
    } catch (e: any) {
      setMsg(`Error: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  // --- userOperation inclusion polling helpers ---
  function stopUserOpPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function fetchUserOp(hash: string) {
    try {
      const r = await fetch(`${apiBase || ""}/api/userop/${hash}?waitMs=0`);
      const t = await r.text();
      return t ? JSON.parse(t) : {};
    } catch {
      return {} as any;
    }
  }

  function startUserOpPolling(hash: string, seconds = 60) {
    stopUserOpPolling();
    setLastUserOp({ hash, polling: true, countdown: seconds });
    let sec = seconds;
    pollRef.current = window.setInterval(async () => {
      sec -= 1;
      setLastUserOp((prev) => (prev ? { ...prev, countdown: sec } : prev));
      // Ping every 3s, and at t=0
      if (sec % 3 === 0 || sec <= 0) {
        const j = await fetchUserOp(hash);
        if (j?.found && j?.txHash) {
          stopUserOpPolling();
          const txHash = j.txHash as string;
          setLastUserOp({
            hash,
            txHash,
            status: j?.status,
            polling: false,
            countdown: sec,
          });
          setMsg(
            `Delegation saved. userOperationHash: ${hash}\nIncluded: ${txHash}\nExplorer: https://testnet.monadexplorer.com/tx/${txHash}`
          );
          return;
        }
      }
      if (sec <= 0) {
        stopUserOpPolling();
        setMsg(
          (m) =>
            `${
              m || ""
            }\nStill pending after 60s; will continue next run or check later.`
        );
      }
    }, 1000);
  }

  useEffect(() => {
    return () => stopUserOpPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- DCA job polling & countdown ---
  async function refreshJobStatus() {
    try {
      const delegatorSa = saPanel.delegator?.address?.toLowerCase();
      if (!delegatorSa) {
        setJob(null);
        jobRef.current = null;
        setHasDelegation(false);
        return;
      }
      // Check if delegation exists for this SA
      try {
        const r0 = await fetch(
          `${apiBase || ""}/api/delegations/${delegatorSa}`
        );
        const t0 = await r0.text();
        const j0 = t0 ? JSON.parse(t0) : {};
        setHasDelegation(Boolean(j0?.exists));
      } catch {}
      const r = await fetch(`${apiBase || ""}/api/jobs`);
      const t = await r.text();
      const j = t ? JSON.parse(t) : {};
      const found = Array.isArray(j?.jobs)
        ? j.jobs.find((x: any) => x.delegatorSA?.toLowerCase() === delegatorSa)
        : null;
      setJob(found || null);
      jobRef.current = found || null;
    } catch {
      // ignore transient errors
    }
  }

  useEffect(() => {
    // Clear previous poller
    if (jobPollRef.current) {
      clearInterval(jobPollRef.current);
      jobPollRef.current = null;
    }
    // Start polling when we have a delegator SA
    if (!saPanel.delegator?.address) {
      setJob(null);
      setEmissionCountdown(null);
      return;
    }
    // Initial fetch
    refreshJobStatus();
    let tick = 0;
    jobPollRef.current = window.setInterval(() => {
      tick += 1;
      // Refresh from server every 3s to catch new lastRunAt / status
      if (tick % 3 === 0) refreshJobStatus();
      // Update countdown locally every second
      setEmissionCountdown(() => {
        const j = jobRef.current as any;
        if (!j || !j.active || !j.lastRunAt || !j.intervalSec) return null;
        const elapsed = Math.floor((Date.now() - j.lastRunAt) / 1000);
        const remaining = Math.max(0, j.intervalSec - elapsed);
        return remaining;
      });
    }, 1000);
    return () => {
      if (jobPollRef.current) {
        clearInterval(jobPollRef.current);
        jobPollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saPanel.delegator?.address, apiBase]);

  async function startDca() {
    if (!saPanel.delegator?.address) return;
    try {
      setBusy(true);
      const r = await fetch(`${apiBase || ""}/api/jobs/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          delegatorSA: saPanel.delegator.address,
          intervalSec: 60,
          durationSec: 24 * 60 * 60,
          immediate: false,
        }),
      });
      const t = await r.text();
      const j = t ? JSON.parse(t) : {};
      if (j?.ok && j?.job) {
        setJob(j.job);
        jobRef.current = j.job;
      }
    } catch (e: any) {
      setMsg(`Start failed: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  async function stopDca() {
    if (!saPanel.delegator?.address) return;
    try {
      setBusy(true);
      const r = await fetch(`${apiBase || ""}/api/jobs/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delegatorSA: saPanel.delegator.address }),
      });
      const t = await r.text();
      const j = t ? JSON.parse(t) : {};
      if (j?.ok && j?.job) {
        setJob(j.job);
        jobRef.current = j.job;
      }
    } catch (e: any) {
      setMsg(`Stop failed: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  async function runNowOnce() {
    if (!saPanel.delegator?.address) return;
    try {
      setBusy(true);
      const r = await fetch(`${apiBase || ""}/api/jobs/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delegatorSA: saPanel.delegator.address }),
      });
      const t = await r.text();
      const j = t ? JSON.parse(t) : {};
      if (j?.ok && j?.job) {
        setJob(j.job);
        jobRef.current = j.job;
      }
    } catch (e: any) {
      setMsg(`Run failed: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        maxWidth: 680,
        margin: "2rem auto",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <h1>Monad DCA Agent</h1>
      {!isConnected ? (
        <button
          disabled={connectStatus === "pending"}
          onClick={() => connect({ connector: injectedConnector })}
        >
          {connectStatus === "pending" ? "Connecting…" : "Connect Wallet"}
        </button>
      ) : (
        <div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <code>{address}</code>
            <button onClick={() => disconnect()}>Disconnect</button>
          </div>
          <hr style={{ margin: "1rem 0" }} />
          {/* Accounts panel */}
          <div
            style={{
              background: "#fcfcfd",
              border: "1px solid #eee",
              borderRadius: 8,
              padding: 12,
              marginBottom: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <strong>Accounts</strong>
              <button onClick={refreshSaPanel} style={{ fontSize: 12 }}>
                Refresh
              </button>
            </div>
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              <div>
                <div style={{ fontSize: 12, color: "#666" }}>EOA</div>
                <div style={{ wordBreak: "break-all" }}>
                  {saPanel.eoa || "—"}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: "#666" }}>Delegator SA</div>
                <div style={{ wordBreak: "break-all" }}>
                  {saPanel.delegator?.address || "—"}
                </div>
                <div style={{ fontSize: 12, color: "#444" }}>
                  MON:{" "}
                  {saPanel.delegator?.mon
                    ? (Number(saPanel.delegator.mon) / 1e18).toFixed(6)
                    : "?"}
                  {"  •  "}
                  USDC:{" "}
                  {saPanel.delegator?.usdc
                    ? (Number(saPanel.delegator.usdc) / 1e6).toFixed(2)
                    : "?"}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: "#666" }}>Delegate SA</div>
                <div style={{ wordBreak: "break-all" }}>
                  {saPanel.delegate?.sa || "—"}
                </div>
                <div style={{ fontSize: 12, color: "#444" }}>
                  MON:{" "}
                  {saPanel.delegate?.mon
                    ? (Number(saPanel.delegate.mon) / 1e18).toFixed(6)
                    : "?"}
                  {"  •  "}
                  USDC:{" "}
                  {saPanel.delegate?.usdc
                    ? (Number(saPanel.delegate.usdc) / 1e6).toFixed(2)
                    : "?"}
                </div>
              </div>
              {saPanel.quote && (
                <div style={{ fontSize: 12, color: "#444" }}>
                  Quote 1 USDC → WMON:{" "}
                  {saPanel.quote.out
                    ? `${(Number(saPanel.quote.out) / 1e18).toFixed(6)} WMON`
                    : "?"}
                </div>
              )}
              {saPanel.error && (
                <div style={{ fontSize: 12, color: "#b00" }}>
                  Diag error: {saPanel.error}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: "grid", gap: 12 }}>
            <label>
              Amount per DCA (USDC):
              <input
                value={amount}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setAmount(e.target.value)
                }
              />
            </label>
            <label>
              Slippage (bps):
              <input
                value={slippageBps}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setSlippageBps(e.target.value)
                }
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={unwrapToMon}
                onChange={(e) => setUnwrapToMon(e.target.checked)}
              />{" "}
              Unwrap to MON
            </label>
            <button onClick={createAndPostDelegation} disabled={busy}>
              {busy ? "Working…" : "Create & Sign Delegation"}
            </button>
            {/* DCA job controls */}
            <div
              style={{
                marginTop: 8,
                padding: 12,
                border: "1px solid #eee",
                borderRadius: 8,
                background: "#fcfcfd",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <strong>DCA Scheduler</strong>
                <div style={{ fontSize: 12, color: "#666" }}>
                  Interval: 60s • Duration: 24h
                </div>
              </div>
              <div style={{ fontSize: 13, marginTop: 6 }}>
                Status: {job?.active ? "Active" : "Stopped"}
                {job?.runsDone != null ? ` • Runs: ${job.runsDone}` : ""}
                {job?.lastError ? (
                  <span style={{ color: "#b00" }}>
                    {" "}
                    • Last error: {job.lastError}
                  </span>
                ) : null}
              </div>
              <div style={{ fontSize: 13 }}>
                Last run:{" "}
                {job?.lastRunAt
                  ? new Date(job.lastRunAt).toLocaleTimeString()
                  : "—"}
              </div>
              <div style={{ fontSize: 13 }}>
                Next in:{" "}
                {job?.active && emissionCountdown != null
                  ? `${emissionCountdown}s`
                  : "—"}
              </div>
              <div style={{ fontSize: 12, color: "#666" }}>
                Expires:{" "}
                {job?.expiresAt
                  ? new Date(job.expiresAt).toLocaleString()
                  : "—"}
              </div>
              {!hasDelegation && (
                <div style={{ fontSize: 12, color: "#b26" }}>
                  Créez et signez d’abord la délégation pour autoriser le DCA.
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button
                  onClick={startDca}
                  disabled={
                    busy || !saPanel.delegator?.address || !hasDelegation
                  }
                >
                  Start DCA
                </button>
                <button
                  onClick={stopDca}
                  disabled={
                    busy || !saPanel.delegator?.address || !hasDelegation
                  }
                >
                  Stop DCA
                </button>
                <button
                  onClick={runNowOnce}
                  disabled={
                    busy || !saPanel.delegator?.address || !hasDelegation
                  }
                >
                  Run now
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {msg && (
        <pre
          style={{
            whiteSpace: "pre-wrap",
            background: "#f6f8fa",
            padding: 12,
            marginTop: 16,
          }}
        >
          {msg}
        </pre>
      )}
      {lastUserOp?.hash && (
        <div
          style={{
            marginTop: 8,
            padding: 8,
            border: "1px solid #eee",
            borderRadius: 8,
            background: "#fff",
            fontSize: 13,
          }}
        >
          <div style={{ wordBreak: "break-all" }}>
            userOp: <code>{lastUserOp.hash}</code>
          </div>
          {lastUserOp.txHash ? (
            <div>
              tx:{" "}
              <a
                href={`https://testnet.monadexplorer.com/tx/${lastUserOp.txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                {lastUserOp.txHash}
              </a>
            </div>
          ) : (
            <div>Pending… {lastUserOp.countdown}s</div>
          )}
        </div>
      )}
    </div>
  );
}
