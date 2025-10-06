import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useWalletClient,
} from "wagmi";
import { injected } from "@wagmi/connectors";
import {
  Address,
  Hex,
  encodeFunctionData,
  parseUnits,
  getFunctionSelector,
} from "viem";
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
  const [topupStatus, setTopupStatus] = useState<string>("");
  const [topupAmount, setTopupAmount] = useState("1"); // Montant de top-up configurable
  const DAILY_TOPUP_USDC = 1n; // 1 USDC per 24h (legacy, remplacé par topupAmount)
  // Track presence of native value delegation
  const [hasValueDelegation, setHasValueDelegation] = useState(false);
  const createValueDelegationNativeRef = useRef<() => Promise<void>>();
  const [saPanel, setSaPanel] = useState<{
    eoa?: string;
    delegator?: {
      address: string; // Smart Account address
      mon?: string;
      usdc?: string;
      wmon?: string; // added WMON balance
    };
    delegate?: {
      eoa?: string;
      sa?: string;
      mon?: string;
      usdc?: string;
      wmon?: string; // added WMON balance
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
          next.delegator.wmon = db.wmon ?? "0";
        } else {
          next.delegator.mon = next.delegator.mon || "0";
          next.delegator.usdc = next.delegator.usdc || "0";
          next.delegator.wmon = "0";
        }
      }
      if (delegate?.sa) {
        next.delegate = { eoa: delegate.eoa, sa: delegate.sa };
        const ddb = diag?.delegateBalances;
        if (ddb) {
          next.delegate.mon = ddb.mon;
          next.delegate.usdc = ddb.usdc;
          next.delegate.wmon = ddb.wmon ?? "0";
        } else {
          next.delegate.mon = next.delegate.mon || "0";
          next.delegate.usdc = next.delegate.usdc || "0";
          next.delegate.wmon = "0";
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
      const post = await fetch(`${apiBase || ""}/api/delegations?role=value`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          delegatorSA: delegatorSa,
          signedDelegation: { delegation, signature },
        }),
      });
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

  // Désactivation par défaut de la tentative permit (USDC testnet ne supporte pas 2612 ici)
  const [skipPermit, setSkipPermit] = useState(true);

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
              spender: smart.address as Address,
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
      const targets: Address[] = [USDC, UNISWAP_V2_ROUTER02, WMON];
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
            `${apiBase || ""}/api/delegations?role=value`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                delegatorSA: delegatorSa,
                signedDelegation: { delegation, signature },
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
          // Activer l'exécution immédiate du premier swap, comme lors de la création de la délégation
          immediate: true,
          unwrapToMon,
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

  async function sendMonNative() {
    if (!saPanel.delegator?.address) return;
    try {
      setBusy(true);
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
            "Délégation 'value' manquante: créez /api/delegations?role=value avant."
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

  const [backendVersion, setBackendVersion] = useState<string>("");
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

  const [debugOpen, setDebugOpen] = useState(false);
  const [delegationDebug, setDelegationDebug] = useState<any>(null);
  const [delegationsList, setDelegationsList] = useState<any>(null);
  const [statusDebug, setStatusDebug] = useState<any>(null);

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

  return (
    <div
      style={{
        maxWidth: 680,
        margin: "2rem auto",
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      <h1>Monad Delegatoor</h1>
      <button
        style={{ position: "absolute", top: 8, right: 8, fontSize: 10 }}
        onClick={() => {
          setDebugOpen((o) => !o);
          if (!debugOpen) loadDelegationDebug(true);
        }}
      >
        {debugOpen ? "Close Debug" : "Debug"}
      </button>
      {debugOpen && (
        <div
          style={{
            background: "#111",
            color: "#eee",
            padding: 12,
            borderRadius: 6,
            fontSize: 11,
            maxHeight: 300,
            overflow: "auto",
          }}
        >
          <div style={{ display: "flex", gap: 8 }}>
            <button
              style={{ fontSize: 10 }}
              onClick={() => loadDelegationDebug(true)}
            >
              Reload
            </button>
          </div>
          <pre style={{ whiteSpace: "pre-wrap" }}>
            {JSON.stringify(
              {
                delegation: delegationDebug,
                list: delegationsList,
                status: statusDebug,
              },
              null,
              2
            )}
          </pre>
        </div>
      )}
      {backendVersion && (
        <div style={{ fontSize: 12, color: "#666" }}>
          backend git: {backendVersion}
        </div>
      )}
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
                  {"  •  "}
                  WMON:{" "}
                  {saPanel.delegator?.wmon
                    ? (Number(saPanel.delegator.wmon) / 1e18).toFixed(6)
                    : "0.000000"}
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
                  {"  •  "}
                  WMON:{" "}
                  {saPanel.delegate?.wmon
                    ? (Number(saPanel.delegate.wmon) / 1e18).toFixed(6)
                    : "0.000000"}
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
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={createAndPostDelegation} disabled={busy}>
                {busy ? "Working…" : "Create Core Delegation"}
              </button>
              <button
                onClick={createValueDelegationNative}
                disabled={
                  busy || !saPanel.delegator?.address || hasValueDelegation
                }
                title={
                  hasValueDelegation
                    ? "Value delegation (native) déjà existante"
                    : "Crée et signe la value delegation avec scope natif"
                }
              >
                {hasValueDelegation
                  ? "Value Delegation OK"
                  : "Create Value Delegation (native)"}
              </button>
            </div>
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
              {topupStatus && (
                <div style={{ fontSize: 12, color: "#0a6" }}>{topupStatus}</div>
              )}
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
                  onClick={unwrapNow}
                  disabled={
                    busy || !saPanel.delegator?.address || !hasDelegation
                  }
                >
                  Unwrap WMON → MON
                </button>
                <button
                  onClick={() => flushToken("WMON")}
                  disabled={
                    busy || !saPanel.delegator?.address || !hasDelegation
                  }
                >
                  Send WMON → EOA
                </button>
                <button
                  onClick={sendMonNative}
                  disabled={
                    busy ||
                    !saPanel.delegator?.address ||
                    !hasDelegation ||
                    !hasValueDelegation
                  }
                  title={
                    !hasValueDelegation
                      ? "Créer d'abord la value delegation (native)"
                      : "Envoie tout le solde MON natif vers l'EOA"
                  }
                >
                  Retirer MON (natif) → EOA
                </button>
                <button
                  onClick={sendDelegateMonNative}
                  disabled={busy || !hasValueDelegation}
                  title="Retire le solde natif MON du delegate smart account vers son EOA"
                >
                  Retirer MON delegate SA → delegate EOA
                </button>
                {/* Bouton MON supprimé (flush natif désactivé) */}
                <button
                  onClick={wrapMonAll}
                  disabled={
                    busy || !saPanel.delegator?.address || !hasDelegation
                  }
                >
                  Wrap MON → WMON
                </button>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    marginTop: "8px",
                  }}
                >
                  <label style={{ fontSize: "14px" }}>
                    Montant top-up USDC:
                    <input
                      type="number"
                      value={topupAmount}
                      onChange={(e) => setTopupAmount(e.target.value)}
                      min="0"
                      step="0.1"
                      style={{
                        width: "80px",
                        marginLeft: "8px",
                        padding: "4px",
                      }}
                    />
                  </label>
                  <button
                    onClick={directTopupUsdc}
                    disabled={
                      busy ||
                      !saPanel.delegator?.address ||
                      !address ||
                      !topupAmount ||
                      parseFloat(topupAmount) <= 0
                    }
                  >
                    Top-up direct USDC (EOA→SA)
                  </button>
                </div>
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
