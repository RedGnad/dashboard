import React, { useEffect, useMemo, useRef, useState } from "react";
import AiConsole from "./AiConsole";
import AiActions from "./AiActions";
import AiDashboard from "./AiDashboard";
import { AutopilotMiniCard } from "./AiDashboard";
import Protocols from "./Protocols";
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useWalletClient,
} from "wagmi";
import { ConnectKitButton } from "connectkit";
import { injected } from "@wagmi/connectors";
import {
  Address,
  Hex,
  encodeFunctionData,
  parseUnits,
  getFunctionSelector,
  http,
} from "viem";
import { createBundlerClient } from "viem/account-abstraction";
import {
  Implementation,
  toMetaMaskSmartAccount,
  createOpenDelegation,
  getDeleGatorEnvironment,
} from "@metamask/delegation-toolkit";

// Guardian-style components
import GradientBackground from "./components/GradientBackground";
import BalanceBar from "./components/BalanceBar";
import WalletButton from "./components/WalletButton";
import ActionFAB from "./components/ActionFAB";
import Modal from "./components/Modal";
import DCADashboardModal from "./components/DCADashboardModal";

// Monad testnet UniswapV2 Router02
const UNISWAP_V2_ROUTER02 = "0xfb8e1c3b833f9e67a71c859a132cf783b645e436" as Address;
const USDC = "0xf817257fed379853cDe0fa4F97AB987181B1E5Ea" as Address;
const WMON = "0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701" as Address;

export default function AppModern() {
  // COPIE EXACTE: Tous les hooks wagmi (lignes 39-43 de App.tsx)
  const { address, isConnected } = useAccount();
  const { connect, connectors, status: connectStatus } = useConnect();
  const { disconnect } = useDisconnect();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  // Modal states for Guardian UI
  const [showDashboard, setShowDashboard] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);

  // COPIE EXACTE: apiBase (lignes 44-60 de App.tsx)
  const apiBase = useMemo(() => {
    const hinted = (import.meta as any)?.env?.VITE_API_BASE as string | undefined;
    if (hinted) return hinted.replace(/\/$/, "");
    try {
      const loc = window.location;
      const isLocal = /^(localhost|127\.0\.0\.1)$/i.test(loc.hostname);
      if (isLocal) return `${loc.protocol}//${loc.hostname}:8787`;
      return "";
    } catch {
      return "http://127.0.0.1:8787";
    }
  }, []);

  // COPIE EXACTE: Tous les states (lignes 62-260 de App.tsx)
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
  
  const [emissionCountdown, setEmissionCountdown] = useState<number | null>(null);
  const jobRef = useRef<typeof job>(null);
  const jobPollRef = useRef<number | null>(null);
  const [hasDelegation, setHasDelegation] = useState<boolean>(false);
  const [amount, setAmount] = useState("1");
  const [schedulerSource, setSchedulerSource] = useState<"USDC" | "MON">("USDC");
  const [schedulerTargetSymbol, setSchedulerTargetSymbol] = useState<string>("WMON");
  const [slippageBps, setSlippageBps] = useState("100");
  const [unwrapToMon, setUnwrapToMon] = useState(false);
  const [topupStatus, setTopupStatus] = useState<string>("");
  const [topupAmount, setTopupAmount] = useState("1");
  const DAILY_TOPUP_USDC = 1n;
  const [hasValueDelegation, setHasValueDelegation] = useState(false);
  const createValueDelegationNativeRef = useRef<() => Promise<void>>();
  
  const [saPanel, setSaPanel] = useState<{
    eoa?: string;
    delegator?: {
      address: string;
      mon?: string;
      usdc?: string;
      wmon?: string;
    };
    delegate?: {
      eoa?: string;
      sa?: string;
      mon?: string;
      usdc?: string;
      wmon?: string;
    };
    quote?: { in?: string; out?: string };
    error?: string;
  }>({});

  const usePaymaster = useMemo(() => {
    try {
      const pm = new URLSearchParams(window.location.search).get("pm");
      return pm === null ? false : pm === "1";
    } catch {
      return true;
    }
  }, []);

  const [priceMeta, setPriceMeta] = useState<any>(null);
  const [momentum, setMomentum] = useState<number | null>(null);
  
  const aiEnabled = useMemo(() => {
    try {
      const ai = new URLSearchParams(window.location.search).get("ai");
      return ai === "1";
    } catch {
      return false;
    }
  }, []);

  const injectedConnector = useMemo(() => {
    try {
      const inj =
        (connectors || []).find((c) => c.id === "injected") ||
        (connectors || []).find((c) => /metamask/i.test(c.name)) ||
        (connectors || [])[0];
      return inj as any;
    } catch {
      return undefined as any;
    }
  }, [connectors]);

  const [connectError, setConnectError] = useState<string>("");
  const [skipPermit, setSkipPermit] = useState(true);
  
  const [tokensMeta, setTokensMeta] = useState<
    Record<string, { symbol: string; address: string; decimals: number; isStable?: boolean }>
  >({});
  
  const [allBalances, setAllBalances] = useState<{
    MON?: string;
    tokens?: Record<string, string>;
  }>({});
  
  // EOA balances (separate from Smart Account balances)
  const [eoaBalances, setEoaBalances] = useState<{
    MON?: string;
    tokens?: Record<string, string>;
  }>({});
  
  const [manualTargets, setManualTargets] = useState<Record<string, boolean>>({});
  const [manualMonAmount, setManualMonAmount] = useState<string>("0");
  const [manualSlippageBps, setManualSlippageBps] = useState<string>("100");
  const [debugOpen, setDebugOpen] = useState(false);
  const [delegationDebug, setDelegationDebug] = useState<any>(null);
  const [delegationsList, setDelegationsList] = useState<any>(null);
  const [statusDebug, setStatusDebug] = useState<any>(null);
  const [backendVersion, setBackendVersion] = useState<string>("");
  const [authStatus, setAuthStatus] = useState<"idle" | "needed" | "signing" | "verifying" | "ready" | "authing" | "authed" | "error">("idle");

  // Helper function
  function fmtBalance(v: any): string {
    if (v === null || v === undefined) return "?";
    if (typeof v === "string") {
      if (v.trim() === "") return "?";
      if (/^0+$/.test(v.trim())) return "0";
      return v;
    }
    if (typeof v === "number")
      return Number.isFinite(v) ? (v === 0 ? "0" : String(v)) : "?";
    if (typeof v === "bigint") return v === 0n ? "0" : v.toString();
    return String(v);
  }

  // Human-readable formatter using decimals
  function formatUnitsString(raw: string | undefined, decimals: number, maxFrac = 4): string {
    if (!raw) return "0";
    // raw may be big integer string
    let s = raw.replace(/^0x/i, "");
    if (!/^[0-9]+$/.test(s)) {
      // if already human, return as is
      return raw;
    }
    const negative = false; // balances are non-negative
    while (s.length < decimals + 1) s = "0" + s;
    const intPart = s.slice(0, s.length - decimals).replace(/^0+(?=\d)/, "");
    let frac = s.slice(s.length - decimals).replace(/0+$/, "");
    if (frac.length > maxFrac) frac = frac.slice(0, maxFrac).replace(/0+$/, "");
    return (negative ? "-" : "") + (frac ? `${intPart}.${frac}` : intPart);
  }

  function decimalsForSymbol(sym: string): number {
    const m = tokensMeta?.[sym];
    if (m?.decimals != null) return m.decimals;
    if (sym === "USDC") return 6;
    if (sym === "WMON" || sym === "MON") return 18;
    return 18;
  }

  function fmtToken(sym: string, raw?: string): string {
    return formatUnitsString(raw, decimalsForSymbol(sym));
  }


  // ========== BUSINESS LOGIC FROM App.tsx ==========
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

          // Check if SA is deployed
          const code = await publicClient.getBytecode({
            address: smart.address,
          });
          const isDeployed = code && code !== "0x";
          console.log(`[SA] ${smart.address} deployed: ${isDeployed}`);
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
          next.delegator.mon = fmtBalance(db.mon);
          next.delegator.usdc = fmtBalance(db.usdc);
          next.delegator.wmon = fmtBalance(db.wmon ?? "0");
        } else {
          next.delegator.mon = fmtBalance(next.delegator.mon || "0");
          next.delegator.usdc = fmtBalance(next.delegator.usdc || "0");
          next.delegator.wmon = fmtBalance("0");
        }
      }
      if (delegate?.sa) {
        next.delegate = { eoa: delegate.eoa, sa: delegate.sa };
        const ddb = diag?.delegateBalances;
        if (ddb) {
          next.delegate.mon = fmtBalance(ddb.mon);
          next.delegate.usdc = fmtBalance(ddb.usdc);
          next.delegate.wmon = fmtBalance(ddb.wmon ?? "0");
        } else {
          next.delegate.mon = fmtBalance(next.delegate.mon || "0");
          next.delegate.usdc = fmtBalance(next.delegate.usdc || "0");
          next.delegate.wmon = fmtBalance("0");
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

  // Création / upgrade value delegation (native token scope)
  async function createValueDelegationNative() {
    if (!address || !publicClient || !walletClient) return;
    if (!saPanel.delegator?.address) return;
    setBusy(true);
    setMsg((m) => (m ? m + "\n" : "") + "Création délégation value native…");
    try {
      const infoRes = await fetch(`${apiBase || ""}/api/delegate`);
      const infoTxt = await infoRes.text();
      let info: any = {};
      try {
        info = infoTxt ? JSON.parse(infoTxt) : {};
      } catch {}
      if (!infoRes.ok) throw new Error(info?.error || "delegate_info_failed");
      const env = getDeleGatorEnvironment(10143);
      const smart = await toMetaMaskSmartAccount({
        client: publicClient,
        implementation: Implementation.Hybrid,
        deployParams: [address as Address, [], [], []],
        deploySalt: "0x",
        signer: { walletClient: walletClient as any },
        environment: env as any,
      });
      const delegatorSa = smart.address;
      const maxAmount: bigint = 10_000_000n * 10n ** 18n; // 10M MON
      const delegation = createOpenDelegation({
        environment: env as any,
        from: delegatorSa as Address,
        scope: { type: "nativeTokenTransferAmount", maxAmount } as any,
      });
      const signature = await smart.signDelegation({ delegation });
      // Utilise désormais le flux immuable submit (l'endpoint legacy a été supprimé)
      const post = await fetch(
        `${apiBase || ""}/api/delegations/submit?role=value`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            delegatorSA: delegatorSa,
            signedDelegation: { delegation, signature },
            role: "value",
          }),
        }
      );
      const bodyTxt = await post.text();
      let body: any = {};
      try {
        body = bodyTxt ? JSON.parse(bodyTxt) : {};
      } catch {}
      if (!post.ok || !body?.ok)
        throw new Error(body?.error || "value_post_failed");
      setHasValueDelegation(true);
      setMsg(
        (m) =>
          (m ? m + "\n" : "") +
          `Délégation value native créée (plafond 10M MON).`
      );
    } catch (e: any) {
      setMsg(
        (m) =>
          (m ? m + "\n" : "") +
          `Création value native échouée: ${e?.message || e}`
      );
    } finally {
      setBusy(false);
    }
  }
  createValueDelegationNativeRef.current = createValueDelegationNative;

  useEffect(() => {
    if (isConnected) {
      refreshSaPanel();
    } else {
      setSaPanel({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected]);

  // Fetch tokens registry once
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${apiBase || ""}/api/tokens`).then((x) =>
          x.json()
        );
        if (r && r.ok && r.tokens) {
          setTokensMeta(r.tokens || {});
        }
      } catch {}
    })();
  }, [apiBase]);

  // Fetch balances for all tokens when delegator SA known
  useEffect(() => {
    (async () => {
      const addr = saPanel?.delegator?.address;
      if (!addr) return;
      try {
        const url = new URL("/api/balances", apiBase || window.location.origin);
        url.searchParams.set("address", addr);
        const r = await fetch(url.toString()).then((x) => x.json());
        if (r && (r.ok || r.address)) {
          setAllBalances({ MON: r.MON, tokens: r.tokens || {} });
        }
      } catch {}
    })();
  }, [apiBase, saPanel?.delegator?.address]);

  // Fetch EOA balances when EOA address known
  useEffect(() => {
    (async () => {
      if (!address) return;
      try {
        const url = new URL("/api/balances", apiBase || window.location.origin);
        url.searchParams.set("address", address);
        const r = await fetch(url.toString()).then((x) => x.json());
        if (r && (r.ok || r.address)) {
          setEoaBalances({ MON: r.MON, tokens: r.tokens || {} });
        }
      } catch {}
    })();
  }, [apiBase, address]);

  // Helper: refresh all balances on demand (used by poller and after actions)
  const refreshAllBalances = useRef<() => Promise<void>>();
  refreshAllBalances.current = async () => {
    const addr = saPanel?.delegator?.address;
    if (!addr) return;
    try {
      const url = new URL("/api/balances", apiBase || window.location.origin);
      url.searchParams.set("address", addr);
      const r = await fetch(url.toString()).then((x) => x.json());
      if (r && (r.ok || r.address)) {
        setAllBalances({ MON: r.MON, tokens: r.tokens || {} });
      }
    } catch {}
    try {
      if (address) {
        const url2 = new URL("/api/balances", apiBase || window.location.origin);
        url2.searchParams.set("address", address);
        const r2 = await fetch(url2.toString()).then((x) => x.json());
        if (r2 && (r2.ok || r2.address)) {
          setEoaBalances({ MON: r2.MON, tokens: r2.tokens || {} });
        }
      }
    } catch {}
  };

  // ========== Business Logic Functions ==========

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

      setMsg(`Smart account: ${smart.address}\nChecking deployment...`);

      // Check if SA is deployed, if not deploy it first
      const code = await publicClient.getBytecode({ address: smart.address });
      const isDeployed = code && code !== "0x";

      if (!isDeployed) {
        setMsg(`Deploying smart account...`);
        try {
          // Send a simple userOp to deploy the SA
          const bundlerClient = createBundlerClient({
            client: publicClient,
            transport: http(
              "https://rpc.zerodev.app/api/v3/7535339b-9ae3-41bb-ad97-5375bae4a51b/chain/10143"
            ),
          });

          const deployHash = await bundlerClient.sendUserOperation({
            account: smart,
            calls: [{ to: smart.address, data: "0x" }],
          });

          setMsg(`Waiting for deployment (${deployHash})...`);

          // Wait for deployment confirmation
          let attempts = 0;
          while (attempts < 30) {
            const deployCode = await publicClient.getBytecode({
              address: smart.address,
            });
            if (deployCode && deployCode !== "0x") break;
            await new Promise((r) => setTimeout(r, 2000));
            attempts++;
          }

          setMsg(`Smart account deployed!\nCreating delegation...`);
        } catch (deployError: any) {
          console.error("Deployment error:", deployError);
          setMsg(
            `Deployment failed: ${deployError?.message || "unknown error"}`
          );
          setBusy(false);
          return;
        }
      } else {
        setMsg(`Smart account already deployed\nCreating delegation…`);
      }

      // Optionally prepare EIP-2612 permit only if not skipped
      let maybePermit: any = null;
      let maybeEip3009: any = null;
      if (!skipPermit && false) {
        // force disable permit path
        async function tryBuildPermit(): Promise<any> {
          try {
            if (!publicClient) return null;
            // Detect support via nonces(owner)
            const nonce = (await publicClient.readContract({
              address: USDC,
              abi: [
                {
                  name: "nonces",
                  type: "function",
                  stateMutability: "view",
                  inputs: [{ name: "owner", type: "address" }],
                  outputs: [{ name: "", type: "uint256" }],
                },
              ] as any,
              functionName: "nonces",
              args: [address as Address],
            })) as bigint;
            // Fetch token name/version for domain (fallbacks)
            let tokenName = "Token";
            let tokenVersion = "1";
            try {
              tokenName = (await publicClient.readContract({
                address: USDC,
                abi: [
                  {
                    name: "name",
                    type: "function",
                    stateMutability: "view",
                    inputs: [],
                    outputs: [{ name: "", type: "string" }],
                  },
                ] as any,
                functionName: "name",
                args: [],
              })) as string;
            } catch {}
            try {
              tokenVersion = (await publicClient.readContract({
                address: USDC,
                abi: [
                  {
                    name: "version",
                    type: "function",
                    stateMutability: "view",
                    inputs: [],
                    outputs: [{ name: "", type: "string" }],
                  },
                ] as any,
                functionName: "version",
                args: [],
              })) as string;
            } catch {}
            const chainId = await publicClient.getChainId();
            // authorize daily cap upfront (single popup)
            const valueCap = (DAILY_TOPUP_USDC * 1_000_000n).toString();
            const deadline = (
              Math.floor(Date.now() / 1000) +
              30 * 24 * 3600
            ).toString();
            const domain = {
              name: tokenName,
              version: tokenVersion,
              chainId,
              verifyingContract: USDC,
            } as const;
            const types = {
              Permit: [
                { name: "owner", type: "address" },
                { name: "spender", type: "address" },
                { name: "value", type: "uint256" },
                { name: "nonce", type: "uint256" },
                { name: "deadline", type: "uint256" },
              ],
            } as const;
            const message = {
              owner: address as Address,
              spender: smart.address as Address,
              value: valueCap,
              nonce: nonce.toString(),
              deadline,
            } as const;
            const signature = await (walletClient as any).signTypedData({
              domain,
              primaryType: "Permit",
              types,
              message,
            });
            // Split signature
            const r = "0x" + signature.slice(2, 66);
            const s = "0x" + signature.slice(66, 130);
            const v = parseInt(signature.slice(130, 132), 16);
            return {
              owner: address as Address,
              value: valueCap,
              deadline,
              v,
              r: r as Hex,
              s: s as Hex,
            };
          } catch {
            return null;
          }
        }
        maybePermit = await tryBuildPermit();

        // EIP-3009 fallback: build TransferWithAuthorization signature if 2612 not available
        async function tryBuildEip3009(): Promise<{
          from: Address;
          to: Address;
          value: string;
          validAfter: string;
          validBefore: string;
          nonce: Hex;
          v: number;
          r: Hex;
          s: Hex;
        } | null> {
          try {
            if (!publicClient || !walletClient) return null;
            // Resolve domain
            let tokenName = "Token";
            let tokenVersion = "1";
            try {
              tokenName = (await publicClient.readContract({
                address: USDC,
                abi: [
                  {
                    name: "name",
                    type: "function",
                    stateMutability: "view",
                    inputs: [],
                    outputs: [{ name: "", type: "string" }],
                  },
                ] as any,
                functionName: "name",
                args: [],
              })) as string;
            } catch {}
            try {
              tokenVersion = (await publicClient.readContract({
                address: USDC,
                abi: [
                  {
                    name: "version",
                    type: "function",
                    stateMutability: "view",
                    inputs: [],
                    outputs: [{ name: "", type: "string" }],
                  },
                ] as any,
                functionName: "version",
                args: [],
              })) as string;
            } catch {}
            const chainId = await publicClient.getChainId();
            const value = (DAILY_TOPUP_USDC * 1_000_000n).toString();
            const now = Math.floor(Date.now() / 1000);
            const validAfter = now.toString();
            const validBefore = (now + 30 * 24 * 3600).toString();
            const rand = crypto.getRandomValues(new Uint8Array(32));
            const nonce: Hex = ("0x" +
              Array.from(rand)
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("")) as Hex;
            const domain = {
              name: tokenName,
              version: tokenVersion,
              chainId,
              verifyingContract: USDC,
            } as const;
            const types = {
              TransferWithAuthorization: [
                { name: "from", type: "address" },
                { name: "to", type: "address" },
                { name: "value", type: "uint256" },
                { name: "validAfter", type: "uint256" },
                { name: "validBefore", type: "uint256" },
                { name: "nonce", type: "bytes32" },
              ],
            } as const;
            const message = {
              from: address as Address,
              to: smart.address as Address,
              value,
              validAfter,
              validBefore,
              nonce,
            } as const;
            const sig = await (walletClient as any).signTypedData({
              domain,
              primaryType: "TransferWithAuthorization",
              types,
              message,
            });
            const r = ("0x" + sig.slice(2, 66)) as Hex;
            const s = ("0x" + sig.slice(66, 130)) as Hex;
            const v = parseInt(sig.slice(130, 132), 16);
            return {
              from: address as Address,
              to: smart.address as Address,
              value,
              validAfter,
              validBefore,
              nonce,
              v,
              r,
              s,
            };
          } catch {
            return null;
          }
        }
        maybeEip3009 = !maybePermit ? await tryBuildEip3009() : null;
      }

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
      // Include all tokens for "Convert All to MON" feature
      const targets: Address[] = [
        USDC,
        UNISWAP_V2_ROUTER02,
        WMON,
        "0xe0590015a873bf326bd645c3e1266d4db41c4e6b" as Address, // CHOG
        "0xfe140e1dCe99Be9F4F15d657CD9b7BF622270C50" as Address, // YAKI
        "0x0f0bdebf0f83cd1ee3974779bcb7315f9808c714" as Address, // DAK
        "0x268e4e24e0051ec27b3d27a95977e71ce6875a05" as Address, // BEAN
        "0xcf5a6076cfa32686c0Df13aBaDa2b40dec133F1d" as Address, // WBTC
        "0x0569049E527BB151605EEC7bf48Cfd55bD2Bf4c8" as Address, // DAKIMAKURA
      ];
      // Add EOA as permissible target for native MON transfer (needed for flush MON)
      if (address && !targets.includes(address as Address))
        targets.push(address as Address);
      // compute selectors including EIP-3009
      const selApprove: Hex = getFunctionSelector(
        "approve(address,uint256)"
      ) as Hex;
      const selSwap: Hex = getFunctionSelector(
        "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"
      ) as Hex;
      const selWithdraw: Hex = getFunctionSelector("withdraw(uint256)") as Hex;
      const selDeposit: Hex = getFunctionSelector("deposit()") as Hex; // wrap MON -> WMON
      const selPermit: Hex = getFunctionSelector(
        "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)"
      ) as Hex;
      const selTransferFrom: Hex = getFunctionSelector(
        "transferFrom(address,address,uint256)"
      ) as Hex;
      const selTransfer: Hex = getFunctionSelector(
        "transfer(address,uint256)"
      ) as Hex;
      const selTransferWithAuth: Hex = getFunctionSelector(
        "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)"
      ) as Hex;
      const selectors: Hex[] = [
        selApprove,
        selSwap,
        selWithdraw,
        selDeposit,
        selPermit,
        selTransferFrom,
        selTransfer,
        selTransferWithAuth,
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

      // Top-up intent note for the user
      if (maybePermit)
        setTopupStatus("Top-up authorized via EIP-2612 permit (24 USDC cap)");
      else if (maybeEip3009)
        setTopupStatus("Top-up authorized via EIP-3009 (24 USDC)");
      else
        setTopupStatus("No offchain top-up auth available; ensure SA has USDC");

      setMsg("Posting to backend…");
      // JSON-sûr: convertir BigInt -> string pour le champ value des executions
      const executionsJson = executions.map((e) => ({
        target: e.target,
        value: e.value.toString(),
        callData: e.callData,
      }));
      const res = await fetch(`${apiBase || ""}/api/delegations/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          delegatorSA: smart.address,
          signedDelegation: { delegation, signature },
          role: "core",
          job: {
            amountUSDC: amount,
            slippageBps: Number(slippageBps),
            intervalSec: 60,
            durationSec: 24 * 60 * 60,
            unwrapEvery: unwrapToMon ? 1 : 24,
            unwrapToMon,
            usePaymaster,
            ownerEOA: address,
            permit: maybePermit,
            auth3009: maybeEip3009,
            dailyTopupUSDC: Number(DAILY_TOPUP_USDC),
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
        if (res.body?.immediateRun) {
          if (res.body.immediateRun.ok) {
            setMsg(
              (m) =>
                `${
                  m ? m + "\n" : ""
                }Premier swap exécuté immédiatement (hash: ${
                  res.body.immediateRun.hash
                })`
            );
          } else {
            setMsg(
              (m) =>
                `${m ? m + "\n" : ""}Premier swap a échoué: ${
                  res.body.immediateRun.error
                }`
            );
          }
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
      try {
        const r0 = await fetch(
          `${apiBase || ""}/api/delegations/${delegatorSa}`
        );
        const t0 = await r0.text();
        const j0 = t0 ? JSON.parse(t0) : {};
        const has =
          typeof j0.exists === "boolean"
            ? j0.exists
            : Array.isArray(j0.roles) && j0.roles.includes("core");
        if (!has) {
          // fallback /api/status
          try {
            const s = await fetch(
              `${apiBase || ""}/api/status/${delegatorSa}`
            ).then((r) => r.json());
            if (s?.hasDelegation) {
              setHasDelegation(true);
            } else {
              setHasDelegation(false);
            }
          } catch (e) {
            console.warn("[refreshJobStatus] status fallback failed", e);
            setHasDelegation(false);
          }
        } else {
          setHasDelegation(true);
        }
      } catch (e) {
        console.warn("[refreshJobStatus] primary fetch failed", e);
      }
      const r = await fetch(`${apiBase || ""}/api/jobs`);

      // Création / Upgrade de la value delegation avec scope natif (nativeTokenTransferAmount)
      // Pas de paramètre d'entrée: on fixe un plafond très large pour couvrir la plupart des usages.
      async function createValueDelegationNative() {
        if (!address || !publicClient || !walletClient) return;
        if (!saPanel.delegator?.address) return;
        setBusy(true);
        setMsg(
          (m) => (m ? m + "\n" : "") + "Création délégation value native…"
        );
        try {
          // Récup info delegate (pour vérifier env supporté)
          const infoRes = await fetch(`${apiBase || ""}/api/delegate`);
          const infoTxt = await infoRes.text();
          let info: any = {};
          try {
            info = infoTxt ? JSON.parse(infoTxt) : {};
          } catch {}
          if (!infoRes.ok)
            throw new Error(info?.error || "delegate_info_failed");
          const env = getDeleGatorEnvironment(10143);
          const smart = await toMetaMaskSmartAccount({
            client: publicClient,
            implementation: Implementation.Hybrid,
            deployParams: [address as Address, [], [], []],
            deploySalt: "0x",
            signer: { walletClient: walletClient as any },
            environment: env as any,
          });
          const delegatorSa = smart.address;
          // maxAmount très large (10 millions MON) pour éviter de devoir re-signer souvent
          const maxAmount: bigint = 10_000_000n * 10n ** 18n; // 10M MON
          const delegation = createOpenDelegation({
            environment: env as any,
            from: delegatorSa as Address,
            scope: { type: "nativeTokenTransferAmount", maxAmount } as any,
          });
          const signature = await smart.signDelegation({ delegation });
          const post = await fetch(
            `${apiBase || ""}/api/delegations/submit?role=value`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                delegatorSA: delegatorSa,
                signedDelegation: { delegation, signature },
                role: "value",
              }),
            }
          );
          const bodyTxt = await post.text();
          let body: any = {};
          try {
            body = bodyTxt ? JSON.parse(bodyTxt) : {};
          } catch {}
          if (!post.ok || !body?.ok)
            throw new Error(body?.error || "value_post_failed");
          setHasValueDelegation(true);
          setMsg(
            (m) =>
              (m ? m + "\n" : "") +
              `Délégation value native créée (plafond 10M MON).`
          );
        } catch (e: any) {
          setMsg(
            (m) =>
              (m ? m + "\n" : "") +
              `Création value native échouée: ${e?.message || e}`
          );
        } finally {
          setBusy(false);
        }
      }
      const t = await r.text();
      const j = t ? JSON.parse(t) : {};
      const found = Array.isArray(j?.jobs)
        ? j.jobs.find((x: any) => x.delegatorSA?.toLowerCase() === delegatorSa)
        : null;
      setJob(found || null);
      jobRef.current = found || null;
    } catch (e) {
      console.warn("[refreshJobStatus] outer error", e);
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
      // Refresh balances (MON + tokens) every 5s while scheduler panel is open
      if (tick % 5 === 0) {
        try {
          refreshAllBalances.current?.();
        } catch {}
      }
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
      const r = await fetch(`${apiBase || ""}/api/scheduler/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          delegator: saPanel.delegator.address,
          intervalSec: 60,
          durationSec: 24 * 60 * 60,
          immediate: true,
          unwrapToMon,
          jobType: "dca_schedule",
          source: schedulerSource,
          targetSymbol: schedulerTargetSymbol,
          amountPolicy: "fixed",
          amountUSDC:
            schedulerSource === "USDC" ? Number(amount || "0") : undefined,
          amountMON:
            schedulerSource === "MON" ? Number(amount || "0") : undefined,
          slippageBps: Number(slippageBps || "100"),
        }),
      });
      const t = await r.text();
      const j = t ? JSON.parse(t) : {};
      if (j?.ok && j?.job) {
        setJob(j.job);
        jobRef.current = j.job;
        // Feedback utilisateur : démarrage + swap en cours
        setMsg(
          (m) =>
            `${
              m ? m + "\n" : ""
            }DCA démarré: premier swap en cours d'exécution…`
        );
        // Rafraîchir les soldes immédiatement
        try {
          await refreshAllBalances.current?.();
        } catch {}
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
      const r = await fetch(`${apiBase || ""}/api/scheduler/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delegator: saPanel.delegator.address }),
      });
      const t = await r.text();
      const j = t ? JSON.parse(t) : {};
      if (j?.ok && j?.job) {
        setJob(j.job);
        jobRef.current = j.job;
        setMsg((m) => `${m ? m + "\n" : ""}DCA arrêté.`);
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

  async function unwrapNow() {
    if (!saPanel.delegator?.address) return;
    try {
      setBusy(true);
      // For manual unwrap, ask backend to withdraw all WMON.balanceOf(SA)
      // Here we pass 0 to indicate backend can decide; or you can prompt user for amount.
      const r = await fetch(`${apiBase || ""}/api/unwrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          delegatorSA: saPanel.delegator.address,
          amount: 0,
        }),
      });
      const t = await r.text();
      const j = t ? JSON.parse(t) : {};
      if (!j?.ok) setMsg(`Unwrap failed: ${j?.error || "unknown"}`);
      else setMsg(`Unwrap userOperationHash: ${j.userOperationHash}`);
    } catch (e: any) {
      setMsg(`Unwrap failed: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  async function flushToken(token: "USDC" | "WMON" | "MON") {
    if (!saPanel.delegator?.address) return;
    try {
      setBusy(true);
      const r = await fetch(`${apiBase || ""}/api/flush`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          delegatorSA: saPanel.delegator.address,
          token,
          to: saPanel.eoa,
          amount: "all",
        }),
      });
      const t = await r.text();
      const j = t ? JSON.parse(t) : {};
      if (!j?.ok) setMsg(`Flush ${token} échoué: ${j?.error || "inconnu"}`);
      else setMsg(`Flush ${token} userOperationHash: ${j.userOperationHash}`);
    } catch (e: any) {
      setMsg(`Flush échoué: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  async function wrapMonAll() {
    if (!saPanel.delegator?.address) return;
    try {
      setBusy(true);
      const r = await fetch(`${apiBase || ""}/api/wrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delegatorSA: saPanel.delegator.address }),
      });
      const t = await r.text();
      const j = t ? JSON.parse(t) : {};
      if (!j?.ok) {
        if (j?.code === "delegation_missing") {
          setHasDelegation(false);
          setMsg("Wrap impossible: délégation absente (créez-la d'abord).");
        } else {
          setMsg(`Wrap échoué: ${j?.error || "inconnu"}`);
        }
      } else setMsg(`Wrap userOperationHash: ${j.userOperationHash}`);
    } catch (e: any) {
      setMsg(`Wrap échoué: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  async function convertAllToMon() {
    if (!saPanel.delegator?.address) return;
    try {
      setBusy(true);
      setMsg("Conversion de tous les tokens → WMON → MON...");
      const r = await fetch(`${apiBase || ""}/api/convert-all-to-mon`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delegatorSA: saPanel.delegator.address }),
      });
      const t = await r.text();
      const j = t ? JSON.parse(t) : {};
      if (!j?.ok) {
        if (j?.code === "delegation_missing") {
          setHasDelegation(false);
          setMsg(
            "Conversion impossible: délégation absente (créez-la d'abord)."
          );
        } else {
          setMsg(`Conversion échouée: ${j?.error || "inconnu"}`);
        }
      } else {
        setMsg(
          `✅ Conversion réussie! UserOp: ${j.userOperationHash || "N/A"}`
        );
      }
    } catch (e: any) {
      setMsg(`Conversion échouée: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  async function sendMonNative() {
    if (!saPanel.delegator?.address) return;
    try {
      setBusy(true);

      // Créer automatiquement la value delegation si elle n'existe pas
      if (!hasValueDelegation) {
        setMsg("Création automatique de la value delegation...");
        await createValueDelegationNative();
        // Attendre un peu pour que la délégation soit enregistrée
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      const r = await fetch(`${apiBase || ""}/api/send-mon`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delegatorSA: saPanel.delegator.address }),
      });
      const t = await r.text();
      const j = t ? JSON.parse(t) : {};
      if (!j?.ok) {
        if (j?.error === "value_delegation_missing") {
          setMsg(
            "Délégation 'value' manquante: réessayez dans quelques secondes."
          );
        } else if (j?.error === "core_delegation_missing") {
          setMsg("Délégation core absente.");
        } else if (j?.error === "no_wmon_balance") {
          setMsg("Aucun WMON à retirer (faire un swap d'abord).");
        } else {
          setMsg(`Retrait MON natif échoué: ${j?.error || "inconnu"}`);
        }
      } else {
        setMsg(`Retrait MON natif userOp: ${j.userOperationHash}`);
      }
    } catch (e: any) {
      setMsg(`Retrait MON natif échoué: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  // Retrait du solde natif MON du delegate SA vers son EOA contrôleur
  async function sendDelegateMonNative() {
    try {
      setBusy(true);
      const r = await fetch(`${apiBase || ""}/api/delegate/withdraw-mon`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const t = await r.text();
      const j = t ? JSON.parse(t) : {};
      if (!j?.ok) {
        if (j?.error === "no_mon_balance_delegate") {
          setMsg("Delegate SA: aucun MON natif à retirer.");
        } else if (j?.error === "Missing DELEGATE_PRIVATE_KEY") {
          setMsg(
            "Backend: DELEGATE_PRIVATE_KEY manquant pour retrait delegate."
          );
        } else if (r.status === 404) {
          setMsg(
            "Endpoint retrait delegate introuvable (redémarrer backend?)."
          );
        } else {
          setMsg(`Retrait delegate MON échoué: ${j?.error || "inconnu"}`);
        }
      } else {
        setMsg(`Delegate MON retrait userOp: ${j.userOperationHash}`);
      }
    } catch (e: any) {
      setMsg(`Retrait delegate MON échoué: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  // Fallback direct USDC top-up from EOA to Smart Account
  async function directTopupUsdc() {
    if (
      !saPanel.delegator?.address ||
      !address ||
      !walletClient ||
      !publicClient
    )
      return;
    try {
      setBusy(true);
      const topupAmountNum = parseFloat(topupAmount || "0");
      if (topupAmountNum <= 0) {
        setMsg("Montant de top-up invalide");
        return;
      }
      const value = BigInt(Math.floor(topupAmountNum * 1_000_000)); // USDC a 6 décimales
      // Lire le solde USDC de l'EOA
      let bal: bigint = 0n;
      try {
        bal = (await publicClient.readContract({
          address: USDC,
          abi: [
            {
              name: "balanceOf",
              type: "function",
              stateMutability: "view",
              inputs: [{ name: "owner", type: "address" }],
              outputs: [{ name: "", type: "uint256" }],
            },
          ] as any,
          functionName: "balanceOf",
          args: [address as Address],
        })) as unknown as bigint;
      } catch {}
      if (bal < value) {
        setMsg(
          `EOA: solde USDC insuffisant (${(Number(bal) / 1_000_000).toFixed(
            2
          )} USDC disponible, ${topupAmountNum} USDC requis)`
        );
        return;
      }
      // Transfert direct depuis l'EOA vers le Smart Account
      const tx = await (walletClient as any).writeContract({
        address: USDC,
        abi: [
          {
            name: "transfer",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "to", type: "address" },
              { name: "value", type: "uint256" },
            ],
            outputs: [{ name: "", type: "bool" }],
          },
        ] as any,
        functionName: "transfer",
        args: [saPanel.delegator.address as Address, value],
      });
      setMsg(
        `Top-up direct USDC tx: ${tx} (${topupAmountNum} USDC transférés)`
      );
    } catch (e: any) {
      setMsg(`Top-up direct échoué: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  // Direct native MON top-up from EOA to Smart Account (value transfer)
  async function directTopupMon() {
    if (!saPanel.delegator?.address || !address || !walletClient) return;
    try {
      setBusy(true);
      const amt = parseFloat(topupAmount || "0");
      if (!(amt > 0)) {
        setMsg("Montant MON invalide");
        return;
      }
      const value = BigInt(Math.floor(amt * 1e18));
      const txHash = await (walletClient as any).sendTransaction({
        to: saPanel.delegator.address as Address,
        value,
      });
      setMsg(`Top-up natif MON tx: ${txHash} (${amt} MON transférés)`);
    } catch (e: any) {
      setMsg(`Top-up natif échoué: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  // Backend version polling
  useEffect(() => {
    let aborted = false;
    async function loadVersion() {
      try {
        const r = await fetch(`${apiBase || ""}/api/version`);
        const t = await r.text();
        if (aborted) return;
        if (!t) return;
        try {
          const j = JSON.parse(t);
          if (j?.git) setBackendVersion(j.git);
        } catch {}
      } catch {}
    }
    loadVersion();
    const iv = setInterval(loadVersion, 15000);
    return () => {
      aborted = true;
      clearInterval(iv);
    };
  }, [apiBase]);

  async function loadDelegationDebug(force = false) {
    if (!saPanel.delegator?.address) return;
    try {
      const base = saPanel.delegator.address.toLowerCase();
      const d = await fetch(`${apiBase || ""}/api/delegations/${base}`)
        .then((r) => r.json())
        .catch(() => null);
      const l = await fetch(`${apiBase || ""}/api/delegations`)
        .then((r) => r.json())
        .catch(() => null);
      const s = await fetch(`${apiBase || ""}/api/status/${base}`)
        .then((r) => r.json())
        .catch(() => null);
      setDelegationDebug(d);
      setDelegationsList(l);
      setStatusDebug(s);
      if (force) console.log("[debug] delegation", d, l, s);
    } catch (e) {
      console.warn("[debug] loadDelegationDebug failed", e);
    }
  }

  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string>("");

  // Attempt restore session
  useEffect(() => {
    const stored = localStorage.getItem("dcaAuthToken");
    if (stored) {
      (async () => {
        try {
          const r = await fetch(`${apiBase || ""}/api/auth/me`, {
            headers: { Authorization: `Bearer ${stored}` },
          });
          const t = await r.text();
          let j: any = {};
          try {
            j = t ? JSON.parse(t) : {};
          } catch {}
          if (r.ok && j?.ok) {
            setAuthToken(stored);
            setAuthStatus("ready");
          } else {
            localStorage.removeItem("dcaAuthToken");
            setAuthStatus("needed");
          }
        } catch {
          setAuthStatus("needed");
        }
      })();
    } else {
      setAuthStatus("needed");
    }
  }, [apiBase]);

  async function beginAuth() {
    if (!address || !window?.ethereum) {
      setAuthError("Wallet non connectée");
      return;
    }
    try {
      setAuthError("");
      setAuthStatus("signing");
      // Fetch nonce + message
      const nonceResp = await fetch(
        `${apiBase || ""}/api/auth/nonce?address=${address}`
      );
      const txt = await nonceResp.text();
      let nr: any = {};
      try {
        nr = txt ? JSON.parse(txt) : {};
      } catch {}
      if (!nonceResp.ok || !nr?.ok)
        throw new Error(nr?.error || "nonce_failed");
      const message: string = nr.message;
      // personal_sign via provider (raw utf-8) - wagmi's walletClient.signMessage is fine
      let signature: string;
      if ((window as any).ethereum?.request) {
        signature = await (window as any).ethereum.request({
          method: "personal_sign",
          params: [message, address],
        });
      } else {
        throw new Error("Provider manquant");
      }
      setAuthStatus("verifying");
      const verResp = await fetch(`${apiBase || ""}/api/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, signature }),
      });
      const vtxt = await verResp.text();
      let vr: any = {};
      try {
        vr = vtxt ? JSON.parse(vtxt) : {};
      } catch {}
      if (!verResp.ok || !vr?.ok) throw new Error(vr?.error || "verify_failed");
      localStorage.setItem("dcaAuthToken", vr.token);
      setAuthToken(vr.token);
      setAuthStatus("ready");
    } catch (e: any) {
      setAuthError(e?.message || "auth_failed");
      setAuthStatus("error");
    }
  }

  useEffect(() => {
    if (isConnected) {
      refreshSaPanel();
    } else {
      setSaPanel({});
    }
  }, [isConnected]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${apiBase || ""}/api/tokens`).then((x) => x.json());
        if (r && r.ok && r.tokens) {
          setTokensMeta(r.tokens || {});
        }
      } catch {}
    })();
  }, [apiBase]);

  useEffect(() => {
    (async () => {
      const addr = saPanel?.delegator?.address;
      if (!addr) return;
      try {
        const url = new URL("/api/balances", apiBase || window.location.origin);
        url.searchParams.set("address", addr);
        const r = await fetch(url.toString()).then((x) => x.json());
        if (r && (r.ok || r.address)) {
          setAllBalances({ MON: r.MON, tokens: r.tokens || {} });
        }
      } catch {}
    })();
  }, [apiBase, saPanel?.delegator?.address]);

  // Helper functions for balance progress bars
  const calculateEOAProgress = () => {
    const eoaUsdc = Number(eoaBalances?.tokens?.USDC || 0) / 1e6;
    const eoaMon = Number(eoaBalances?.MON || 0) / 1e18;
    const eoaWmon = Number(eoaBalances?.tokens?.WMON || 0) / 1e18;
    
    const saUsdc = Number(saPanel?.delegator?.usdc ?? allBalances?.tokens?.USDC || 0) / 1e6;
    const saMon = Number(saPanel?.delegator?.mon ?? allBalances?.MON || 0) / 1e18;
    const saWmon = Number(saPanel?.delegator?.wmon ?? allBalances?.tokens?.WMON || 0) / 1e18;
    
    const totalEoa = eoaUsdc + eoaMon + eoaWmon;
    const totalSa = saUsdc + saMon + saWmon;
    const grandTotal = totalEoa + totalSa;
    
    if (grandTotal === 0) return 50;
    return (totalEoa / grandTotal) * 100;
  };

  const calculateSAProgress = () => {
    return 100 - calculateEOAProgress();
  };

  // If not connected, show login screen
  if (!isConnected) {
    return (
      <div className="w-screen h-screen relative overflow-hidden">
        <GradientBackground />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <h1 className="text-5xl font-bold text-white mb-8 drop-shadow-lg">
              Monad Delegatoor
            </h1>
            <div className="flex justify-center">
              <ConnectKitButton />
            </div>
            {connectError && (
              <div className="mt-4 text-red-300 text-sm">{connectError}</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Main Guardian UI
  return (
    <div className="w-screen h-screen relative overflow-hidden">
      <GradientBackground />
      
      {/* Wallet button */}
      <WalletButton />

      {/* Balance bars - Guardian style */}
      <div className="absolute top-6 left-6 space-y-3 z-30">
        <BalanceBar
          title="EOA Wallet"
          icon="wallet"
          address={address}
          balances={{
            USDC: fmtToken("USDC", eoaBalances?.tokens?.USDC),
            MON: fmtToken("MON", eoaBalances?.MON),
            WMON: fmtToken("WMON", eoaBalances?.tokens?.WMON),
          }}
          progressPercentage={calculateEOAProgress()}
          gradient="red"
          onRefresh={refreshAllBalances.current}
          isRefreshing={false}
        />
        <BalanceBar
          title="Smart Account"
          icon="shield"
          address={saPanel?.delegator?.address}
          balances={{
            USDC: fmtToken("USDC", saPanel?.delegator?.usdc ?? allBalances?.tokens?.USDC),
            MON: fmtToken("MON", saPanel?.delegator?.mon ?? allBalances?.MON),
            WMON: fmtToken("WMON", saPanel?.delegator?.wmon ?? allBalances?.tokens?.WMON),
          }}
          progressPercentage={calculateSAProgress()}
          gradient="blue"
          onRefresh={refreshAllBalances.current}
          isRefreshing={false}
        />
        {/* Other tokens overview */}
        <div className="backdrop-blur-md bg-white/10 border border-white/20 rounded-2xl shadow-lg p-4">
          <div className="text-white/90 font-semibold mb-2">Other tokens</div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-white/70 text-xs mb-1">EOA tokens</div>
              <div className="flex flex-wrap gap-2 text-xs">
                {Object.entries(eoaBalances?.tokens || {})
                  .filter(([k]) => ["USDC", "WMON"].indexOf(k) === -1)
                  .slice(0, 20)
                  .map(([sym, val]) => (
                    <div key={`eoa-${sym}`} className="px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-white/90">
                      {sym}: <span className="font-mono">{fmtToken(sym, val)}</span>
                    </div>
                  ))}
                {(!eoaBalances?.tokens || Object.keys(eoaBalances.tokens).filter((k)=>!["USDC","WMON"].includes(k)).length===0) && (
                  <div className="text-white/50">—</div>
                )}
              </div>
            </div>
            <div>
              <div className="text-white/70 text-xs mb-1">Smart Account tokens</div>
              <div className="flex flex-wrap gap-2 text-xs">
                {Object.entries(allBalances?.tokens || {})
                  .filter(([k]) => ["USDC", "WMON"].indexOf(k) === -1)
                  .slice(0, 20)
                  .map(([sym, val]) => (
                    <div key={`sa-${sym}`} className="px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-white/90">
                      {sym}: <span className="font-mono">{fmtToken(sym, val)}</span>
                    </div>
                  ))}
                {(!allBalances?.tokens || Object.keys(allBalances.tokens).filter((k)=>!["USDC","WMON"].includes(k)).length===0) && (
                  <div className="text-white/50">—</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Action FAB */}
      <ActionFAB
        onDashboard={() => setShowDashboard(true)}
        onSettings={() => setShowAnalytics(true)}
      />

      {/* Dashboard Modal */}
      <Modal
        isOpen={showDashboard}
        onClose={() => setShowDashboard(false)}
        title="DCA Control Dashboard"
        maxWidth="1200px"
      >
        <DCADashboardModal
          amount={amount}
          setAmount={setAmount}
          schedulerSource={schedulerSource}
          setSchedulerSource={setSchedulerSource}
          schedulerTargetSymbol={schedulerTargetSymbol}
          setSchedulerTargetSymbol={setSchedulerTargetSymbol}
          slippageBps={slippageBps}
          setSlippageBps={setSlippageBps}
          tokensMeta={tokensMeta}
          job={job}
          emissionCountdown={emissionCountdown}
          hasDelegation={hasDelegation}
          topupStatus={topupStatus}
          createAndPostDelegation={createAndPostDelegation}
          startDca={startDca}
          stopDca={stopDca}
          sendMonNative={sendMonNative}
          convertAllToMon={convertAllToMon}
          topupAmount={topupAmount}
          setTopupAmount={setTopupAmount}
          directTopupUsdc={directTopupUsdc}
          directTopupMon={directTopupMon}
          busy={busy}
          address={address}
          delegatorAddress={saPanel?.delegator?.address}
          msg={msg}
        />

        {/* AI Components */}
        <div className="mt-6 space-y-4">
          <div className="bg-white rounded-xl border border-slate-200 p-4 text-slate-900">
            <AutopilotMiniCard
              apiBase={apiBase}
              delegator={saPanel?.delegator?.address}
            />
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-4 text-slate-900">
            <AiActions
              apiBase={apiBase || ""}
              defaultDelegator={saPanel?.delegator?.address || ""}
            />
          </div>
        </div>
      </Modal>

      {/* Analytics Modal */}
      <Modal
        isOpen={showAnalytics}
        onClose={() => setShowAnalytics(false)}
        title="AI Analytics & Monitoring"
        maxWidth="1400px"
      >
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-slate-200 p-4 text-slate-900">
            <AiConsole
              apiBase={apiBase}
              delegator={saPanel?.delegator?.address}
            />
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-4 text-slate-900">
            <AiDashboard apiBase={apiBase} />
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-4 text-slate-900">
            <Protocols apiBase={apiBase} />
          </div>
        </div>
      </Modal>
    </div>
  );
}
