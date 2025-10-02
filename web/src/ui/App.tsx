import React, { useEffect, useMemo, useState } from "react";
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
        const hash = res.body.userOperationHash as string | undefined;
        setMsg(
          hash
            ? `Delegation saved. userOperationHash: ${hash}`
            : "Delegation saved. Backend can now execute your DCA."
        );
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
    </div>
  );
}
