import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { parseUnits } from "viem";
import { useDcaDelegation } from "../hooks/useDcaDelegation";
import {
  USDC,
  getTargetTokens,
  getToken,
  getAllTradableTokens,
  TOKENS,
} from "../lib/tokens";
import {
  ArrowUpDown,
  RefreshCw,
  Copy,
  Settings,
  BarChart2,
  Cpu,
  SlidersHorizontal,
  Brain,
} from "lucide-react";
import { useEnvioMetrics } from "../hooks/useEnvioMetrics";
import ProtocolMetricsChart from "../components/ProtocolMetricsChart";
import TokenMetricsChart from "../components/TokenMetricsChart";
import ProtocolBarChart from "../components/ProtocolBarChart";
import { useTodayProtocolMetrics } from "../hooks/useTodayProtocolMetrics";
import {
  useProtocolDailyMetrics,
  type ProtocolMetricKey,
} from "../hooks/useProtocolDailyMetrics";
import { useAutonomousAi } from "../hooks/useAutonomousAi";
import { useTokenMetrics } from "../hooks/useTokenMetrics";
import { useWhaleTransfers } from "../hooks/useWhaleTransfers";
import { useWhaleAlerts } from "../hooks/useWhaleAlerts";
import AiVerificationPanel from "./AiVerificationPanel";
import WithdrawModal from "./WithdrawModal";

type TabKey = "trade" | "ai" | "metrics" | "verification" | "settings";

export default function DcaControl() {
  const [active, setActive] = useState<TabKey>("trade");
  const [monDcaAmount, setMonDcaAmount] = useState("0.05");
  const [slippageBps, setSlippageBps] = useState("300");
  const [interval, setInterval] = useState("60");
  const [monAmount, setMonAmount] = useState("0.1");
  const [outToken, setOutToken] = useState<string>(() => {
    const allowed = getTargetTokens().filter((t) => t.symbol !== "WMON");
    return allowed[0]?.symbol || "CHOG";
  });
  const [metricKey, setMetricKey] = useState<ProtocolMetricKey>("txDaily");
  const [historyDays, setHistoryDays] = useState<number>(30);
  const [todayMetric, setTodayMetric] = useState<"usersDaily" | "txDaily">(
    "txDaily"
  );

  const {
    isInitialized,
    isLoading,
    dcaStatus,
    balances,
    delegatorSmartAccount,
    delegationExpired,
    delegationExpiresAt,
    reinitialize,
    startNativeDca,
    stopDca,
    refreshBalances,
    renewDelegation,
    topUpMon,
    withdrawMon,
    convertAllToMon,
    withdrawToken,
    withdrawAll,
    ensureMagmaDelegation,
    unstakeMagma,

    panic,
  } = useDcaDelegation();

  // outToken address resolved on demand when starting DCA
  const {
    metrics,
    loading: metricsLoading,
    error: metricsError,
  } = useEnvioMetrics(delegatorSmartAccount?.address);
  const {
    series,
    dates,
    loading: dailyLoading,
    error: dailyError,
    loadOlder,
    hasMore,
  } = useProtocolDailyMetrics(metricKey, historyDays);
  const {
    todayData,
    latestData,
    loading: todayLoading,
    error: todayError,
  } = useTodayProtocolMetrics();
  const PROTOCOLS = [
    "magma",
    "ambient",
    "curvance",
    "kuru",
    "atlantis",
    "octoswap",
    "pingu",
    "dex",
  ] as const;
  const todayBarData = PROTOCOLS.map((p) => ({
    protocolId: p,
    value: Number(
      (todayData.find((d) => d.protocolId === p) as any)?.[todayMetric] || 0
    ),
  }));
  const [totalMetric, setTotalMetric] = useState<
    "txCumulative" | "avgTxPerUser" | "avgFeeNative"
  >("txCumulative");
  const totalsProtocols =
    totalMetric === "avgFeeNative"
      ? PROTOCOLS.filter((p) => p !== "curvance")
      : Array.from(PROTOCOLS);
  const totalsBarData = totalsProtocols.map((p) => ({
    protocolId: p,
    value: Number(
      (latestData.find((l) => l.protocolId === p) as any)?.[totalMetric] || 0
    ),
  }));
  const { tokenMetrics, loading: tokenMetricsLoading } = useTokenMetrics();
  // Avoid greying the Start AI button on every Envio refresh: require readiness only once
  // Speed up first activation: as soon as Envio metrics are ready, allow starting AI
  // (token prices may still be warming up but AI can operate with partial data and re-evaluate)
  const initialDataReadyRef = useRef(false);
  useEffect(() => {
    if (!initialDataReadyRef.current) {
      const metricsReady = Boolean(metrics?.lastUpdated);
      const minimalPricesReady = Array.isArray(tokenMetrics)
        ? tokenMetrics.some((tm) => Number.isFinite(tm.price) && tm.price > 0)
        : false;
      if (metricsReady || minimalPricesReady) {
        initialDataReadyRef.current = true;
      }
    }
  }, [metrics?.lastUpdated, tokenMetrics]);
  const {
    personality,
    enabled: aiEnabled,
    decisions,
    isProcessing,
    error: aiError,
    setPersonality,
    setEnabled,
    makeDecision,
    provider,
    setProvider,
  } = useAutonomousAi();
  const hasOpenAiKey = Boolean((import.meta as any).env?.VITE_OPENAI_API_KEY);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawSymbol, setWithdrawSymbol] = useState<string>("");
  const [withdrawDecimals, setWithdrawDecimals] = useState<number>(18);
  const [withdrawBalance, setWithdrawBalance] = useState<string>("0");

  const [tokenMetricKind, setTokenMetricKind] = useState<
    "momentum" | "volatility" | "price"
  >("price");
  // removed unused selectedTokenForChart state
  // const [selectedTokenForChart, setSelectedTokenForChart] = useState<string>("USDC");
  // Separate series per metric to avoid resets/mixing on tab switch
  const [tokenDatesPrice, setTokenDatesPrice] = useState<string[]>([]);
  const [tokenDatesMomentum, setTokenDatesMomentum] = useState<string[]>([]);
  const [tokenDatesVol, setTokenDatesVol] = useState<string[]>([]);
  // Seuil whales contrôlé depuis l'UI (localStorage)
  const [whaleThreshold, setWhaleThreshold] = useState<number>(() => {
    try {
      const v = localStorage.getItem("whaleThresholdUsd");
      return v ? Number(v) : 10000;
    } catch {
      return 10000;
    }
  });
  const onChangeWhaleThreshold = (val: number) => {
    setWhaleThreshold(val);
    try {
      localStorage.setItem("whaleThresholdUsd", String(val));
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("whale:threshold", { detail: val })
        );
      }
    } catch {}
  };
  const [selectedChartToken, setSelectedChartToken] = useState<string | null>(
    null
  );
  const [tokenSeriesPrice, setTokenSeriesPrice] = useState<
    Record<string, { token: string; points: { x: string; y: number }[] }>
  >({});
  const [tokenSeriesMomentum, setTokenSeriesMomentum] = useState<
    Record<string, { token: string; points: { x: string; y: number }[] }>
  >({});
  const [tokenSeriesVol, setTokenSeriesVol] = useState<
    Record<string, { token: string; points: { x: string; y: number }[] }>
  >({});
  const [tokenVolSeries, setTokenVolSeries] = useState<
    Record<string, { token: string; points: { x: string; y: number }[] }>
  >({});

  const [limitsEnabled, setLimitsEnabled] = useState(false);
  const [entryKind, setEntryKind] = useState<"above" | "below">("above");
  const [entryPrice, setEntryPrice] = useState<string>("");
  const [stopEnabled, setStopEnabled] = useState(false);
  const [stopKind, setStopKind] = useState<"above" | "below">("below");
  const [stopPrice, setStopPrice] = useState<string>("");

  const [aiLimitsEnabled, setAiLimitsEnabled] = useState(false);
  const [aiEntryKind, setAiEntryKind] = useState<"above" | "below">("above");
  const [aiEntryPrice, setAiEntryPrice] = useState<string>("");
  const [aiStopEnabled, setAiStopEnabled] = useState(false);
  const [aiStopKind, setAiStopKind] = useState<"above" | "below">("below");
  const [aiStopPrice, setAiStopPrice] = useState<string>("");
  const [showManualLimits, setShowManualLimits] = useState(false);
  const [showAiLimits, setShowAiLimits] = useState(false);
  const [trailEnabled, setTrailEnabled] = useState(false);
  const [trailPct, setTrailPct] = useState<string>("5");
  const [aiTrailEnabled, setAiTrailEnabled] = useState(false);
  const [aiTrailPct, setAiTrailPct] = useState<string>("5");
  const trailHighRef = useRef<Record<string, number>>({});
  const aiTrailHighRef = useRef<Record<string, number>>({});
  const [emaGate] = useState(false);
  const [showVolume] = useState(false);
  const [logScale, setLogScale] = useState(false);
  const [chartUnit, setChartUnit] = useState<"USD" | "%">("%");
  const MAX_POINTS = Number((import.meta as any).env?.VITE_CHART_POINTS ?? 120);

  // Auto stake: always default OFF on every page load (no persistence)
  const [restakeAi, setRestakeAi] = useState<boolean>(false);

  const [envioMode, setEnvioMode] = useState<"FAST" | "PRECISE" | "DEFAULT">(
    () => {
      try {
        const sp = new URLSearchParams(window.location.search);
        const qs = sp.get("envio")?.toUpperCase();
        if (qs === "FAST" || qs === "PRECISE") return qs;
        const ls = localStorage.getItem("envio-endpoint")?.toUpperCase();
        if (ls === "FAST" || ls === "PRECISE") return ls;
      } catch {}
      // Default to PRECISE when not specified
      return "PRECISE";
    }
  );
  const applyEnvioMode = useCallback((mode: "FAST" | "PRECISE") => {
    try {
      localStorage.setItem("envio-endpoint", mode);
    } catch {}
    setEnvioMode(mode);
    try {
      window.location.reload();
    } catch {}
  }, []);

  useEffect(() => {
    if (tokenMetricsLoading) return;
    const now = new Date();
    const label = now.toISOString().slice(11, 19);
    const allowed = getTargetTokens().map((t) => t.symbol);

    const nextPrice = { ...tokenSeriesPrice };
    const nextMom = { ...tokenSeriesMomentum };
    const nextVol = { ...tokenSeriesVol };
    const nextVolSeries = { ...tokenVolSeries };

    for (const sym of allowed) {
      const m = tokenMetrics.find((tm) => tm.token === sym);
      const p = Number.isFinite(m?.price) ? Number(m?.price) : 0;
      const mom = Number.isFinite(m?.momentum) ? Number(m?.momentum) : 0;
      const vol = Number.isFinite(m?.volatility) ? Number(m?.volatility) : 0;

      const prevP = nextPrice[sym]?.points || [];
      const ptsP = [...prevP, { x: label, y: p }];
      while (ptsP.length > MAX_POINTS) ptsP.shift();
      nextPrice[sym] = { token: sym, points: ptsP };

      const prevM = nextMom[sym]?.points || [];
      const ptsM = [...prevM, { x: label, y: mom }];
      while (ptsM.length > MAX_POINTS) ptsM.shift();
      nextMom[sym] = { token: sym, points: ptsM };

      const prevV = nextVol[sym]?.points || [];
      const ptsV = [...prevV, { x: label, y: vol }];
      while (ptsV.length > MAX_POINTS) ptsV.shift();
      nextVol[sym] = { token: sym, points: ptsV };

      const vol24 = Number.isFinite(m?.volume24h) ? Number(m?.volume24h) : 0;
      const prevVol = nextVolSeries[sym]?.points || [];
      const ptsVol = [...prevVol, { x: label, y: vol24 }];
      while (ptsVol.length > MAX_POINTS) ptsVol.shift();
      nextVolSeries[sym] = { token: sym, points: ptsVol };
    }

    const ndP = [...(tokenDatesPrice || []), label];
    const ndM = [...(tokenDatesMomentum || []), label];
    const ndV = [...(tokenDatesVol || []), label];
    while (ndP.length > MAX_POINTS) ndP.shift();
    while (ndM.length > MAX_POINTS) ndM.shift();
    while (ndV.length > MAX_POINTS) ndV.shift();

    setTokenSeriesPrice(nextPrice);
    setTokenSeriesMomentum(nextMom);
    setTokenSeriesVol(nextVol);
    setTokenVolSeries(nextVolSeries);
    setTokenDatesPrice(ndP);
    setTokenDatesMomentum(ndM);
    setTokenDatesVol(ndV);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenMetrics, tokenMetricsLoading]);

  const {
    moves: whaleMoves,
    loading: whalesLoading,
    error: whalesError,
  } = useWhaleTransfers(7);
  const { alerts: whaleAlerts } = useWhaleAlerts();
  const whaleMonOnly =
    ((import.meta as any).env?.VITE_WHALE_MON_ONLY ?? "false") === "true";
  const whaleRows = useMemo(() => {
    let rows =
      whaleMoves && whaleMoves.length
        ? whaleMoves
        : (whaleAlerts || []).map((a, i) => {
            const addr = String(a.token).toLowerCase() as `0x${string}`;
            const tok = Object.values(TOKENS).find(
              (t) => (t.address as string).toLowerCase() === addr
            );
            const dec = tok?.decimals || 18;
            let valNum = 0;
            try {
              valNum = Number(a.value) / Math.pow(10, dec);
            } catch {
              valNum = 0;
            }
            return {
              id: `${a.tx}_${i}`,
              token: tok?.symbol || addr.slice(0, 6) + "…" + addr.slice(-4),
              tokenAddress: addr,
              from: a.from,
              to: a.to,
              valueRaw: a.value,
              value: valNum,
              blockTimestamp: Number(a.ts),
              transactionHash: a.tx,
            };
          });
    if (whaleMonOnly) rows = rows.filter((r) => r.token === "WMON");
    return rows;
  }, [whaleMoves, whaleAlerts, whaleMonOnly]);

  // Ensure selected outToken is always a valid target at startup
  useEffect(() => {
    const allowed = getTargetTokens()
      .filter((t) => t.symbol !== "WMON")
      .map((t) => t.symbol);
    if (!allowed.includes(outToken)) {
      const fallback = allowed[0];
      if (fallback) setOutToken(fallback);
    }
    // We intentionally depend only on outToken to correct initial invalid state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outToken]);

  const todayTotals = useMemo(() => {
    let users = 0,
      tx = 0;
    for (const r of todayData) {
      users += Number((r as any)?.usersDaily || 0);
      tx += Number((r as any)?.txDaily || 0);
    }
    return { users, tx };
  }, [todayData]);

  const resolveSymbolFromAddress = useCallback((addr: `0x${string}`) => {
    const lower = addr?.toLowerCase?.();
    for (const t of Object.values(TOKENS)) {
      if ((t.address as string).toLowerCase() === lower) return t.symbol;
    }
    return "";
  }, []);

  const conditionCallback = useCallback(
    async (ctx: {
      mode: "manual" | "ai";
      balances: Record<string, string>;
      outToken: `0x${string}`;
    }) => {
      const isAi = ctx.mode === "ai";
      const en = isAi ? aiLimitsEnabled : limitsEnabled;
      if (!en && !(isAi ? aiTrailEnabled : trailEnabled))
        return { allow: true };
      const sym = resolveSymbolFromAddress(ctx.outToken);
      const tm = tokenMetrics.find((m) => m.token === sym);
      const price = Number(tm?.price || 0);
      if (!Number.isFinite(price) || price <= 0) {
        // When limits or trailing are enabled, require a price
        return { allow: false, reason: "no-price" };
      }
      // Entry conditions
      if (en) {
        const ek = isAi ? aiEntryKind : entryKind;
        const ep = Number(isAi ? aiEntryPrice : entryPrice);
        const se = isAi ? aiStopEnabled : stopEnabled;
        const sk = isAi ? aiStopKind : stopKind;
        const sp = Number(isAi ? aiStopPrice : stopPrice);
        if (Number.isFinite(ep)) {
          if (ek === "above" && !(price >= ep)) return { allow: false };
          if (ek === "below" && !(price <= ep)) return { allow: false };
        }
        if (se && Number.isFinite(sp)) {
          if (sk === "above" && price >= sp)
            return { allow: false, stop: true };
          if (sk === "below" && price <= sp)
            return { allow: false, stop: true };
        }
        if (emaGate && tokenMetricKind === "price") {
          const s = tokenSeriesPrice[sym]?.points || [];
          const ema = (pts: { x: string; y: number }[], window: number) => {
            const k = 2 / (window + 1);
            let e: number | null = null;
            const out: { x: string; y: number }[] = [];
            for (let i = 0; i < pts.length; i++) {
              const y = pts[i].y;
              e = e == null ? y : y * k + (e as number) * (1 - k);
              out.push({ x: pts[i].x, y: e });
            }
            return out;
          };
          const e9 = ema(s, 9);
          const e21 = ema(s, 21);
          const last9 = e9.length ? e9[e9.length - 1].y : NaN;
          const last21 = e21.length ? e21[e21.length - 1].y : NaN;
          if (!Number.isFinite(last9) || !Number.isFinite(last21))
            return { allow: false };
          if (!(last9 >= last21)) return { allow: false };
        }
      }
      // Trailing stop
      const trailOn = isAi ? aiTrailEnabled : trailEnabled;
      if (trailOn) {
        const pct = Number(isAi ? aiTrailPct : trailPct);
        const store = isAi ? aiTrailHighRef.current : trailHighRef.current;
        const prevHigh = store[sym];
        if (!Number.isFinite(prevHigh) || price > prevHigh) store[sym] = price;
        if (Number.isFinite(pct) && pct > 0 && Number.isFinite(store[sym])) {
          const threshold = store[sym] * (1 - pct / 100);
          if (price <= threshold) return { allow: false, stop: true };
        }
      }
      return { allow: true };
    },
    [
      tokenMetrics,
      limitsEnabled,
      entryKind,
      entryPrice,
      stopEnabled,
      stopKind,
      stopPrice,
      aiLimitsEnabled,
      aiEntryKind,
      aiEntryPrice,
      aiStopEnabled,
      aiStopKind,
      aiStopPrice,
      resolveSymbolFromAddress,
      trailEnabled,
      trailPct,
      aiTrailEnabled,
      aiTrailPct,
      emaGate,
      tokenMetricKind,
      tokenSeriesPrice,
    ]
  );

  function formatMonDisplay(v: string) {
    const n = Number(v || "0");
    if (n > 0 && n < 0.001) return "<0.001";
    if (!Number.isFinite(n)) return "0";
    const s = n.toFixed(6);
    return s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  }

  const visibleError = useMemo(() => {
    const err = dcaStatus.lastError || "";
    if (!err) return "";
    if (err.startsWith("Insufficient MON")) {
      const have = parseFloat(balances.MON || "0");
      // Hide if current requested DCA amount is affordable now
      const currentNeed = parseFloat(monDcaAmount || "0");
      if (Number.isFinite(currentNeed) && have >= currentNeed) return "";
      // Fallback: parse previous error 'Need X'
      const m = /Need\s+(\d*\.?\d+)/.exec(err);
      if (m) {
        const need = parseFloat(m[1]);
        if (have >= need) return "";
      }
    }
    return err;
  }, [dcaStatus.lastError, balances.MON, monDcaAmount]);

  const openWithdraw = (symbol: string) => {
    setWithdrawSymbol(symbol);
    if (symbol === "MON") {
      setWithdrawDecimals(18);
      setWithdrawBalance(balances.MON || "0");
    } else {
      const token = TOKENS[symbol as keyof typeof TOKENS];
      setWithdrawDecimals(token?.decimals || 18);
      setWithdrawBalance((balances as any)[symbol] || "0");
    }
    setWithdrawOpen(true);
  };

  const handleWithdrawConfirm = async (amount: string) => {
    if (!withdrawSymbol) return;
    if (withdrawSymbol === "MON") {
      await withdrawMon(amount);
    } else {
      await withdrawToken(withdrawSymbol, amount);
    }
    setWithdrawOpen(false);
  };

  const hasConvertible = useMemo(() => {
    try {
      const wmon = parseFloat((balances as any).WMON || "0") > 0;
      if (wmon) return true;
      for (const t of Object.values(TOKENS)) {
        if (t.isNative || t.symbol === "WMON") continue;
        const bs = (balances as any)[t.symbol] || "0";
        try {
          if (parseUnits(bs, t.decimals) > 0n) return true;
        } catch {
          if (parseFloat(bs) > 0) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }, [balances]);

  // AI callback for autonomous DCA
  const aiCallback = async (currentBalances: Record<string, string>) => {
    try {
      const decision = await makeDecision(
        currentBalances,
        metrics,
        tokenMetrics,
        { allowStake: restakeAi }
      );
      if (decision && decision.action.type !== "HOLD") {
        // Handle different action types
        // MAGMA: STAKE / UNSTAKE handled by hook scheduler via magmaAction flag
        if (decision.action.type === "STAKE") {
          // Gate staking behind the Auto stake switch
          if (!restakeAi) return null;
          return {
            amount: decision.action.amount || "0.05",
            token: USDC as `0x${string}`,
            interval: decision.nextInterval,
            sourceToken: "MON",
            magmaAction: "STAKE",
            decisionId: decision.id,
          } as any;
        }
        if (decision.action.type === "UNSTAKE") {
          // Gate unstaking behind the Auto stake switch
          if (!restakeAi) return null;
          return {
            amount: decision.action.amount || "0.05",
            token: USDC as `0x${string}`,
            interval: decision.nextInterval,
            sourceToken: "MON",
            magmaAction: "UNSTAKE",
            decisionId: decision.id,
          } as any;
        }

        if (decision.action.type === "BUY") {
          // Map token symbols to addresses
          const tokenMap: Record<string, string> = Object.values(TOKENS).reduce(
            (acc, t) => {
              acc[t.symbol] = t.address;
              return acc;
            },
            {} as Record<string, string>
          );
          // Forbid WMON as a final target for AI-controlled DCA
          const requested = (decision.action.targetToken || "").toUpperCase();
          const finalSymbol = requested === "WMON" ? "USDC" : requested;
          const targetAddress = tokenMap[finalSymbol] || USDC;

          return {
            amount: decision.action.amount || "0.05",
            token: targetAddress as `0x${string}`,
            interval: decision.nextInterval,
            sourceToken: decision.action.sourceToken, // Pass source info for future use
            decisionId: decision.id,
          };
        } else if (decision.action.type === "SWAP") {
          const tokenMap: Record<string, string> = Object.values(TOKENS).reduce(
            (acc, t) => {
              acc[t.symbol] = t.address;
              return acc;
            },
            {} as Record<string, string>
          );
          const tgtReq = (decision.action.targetToken || "").toUpperCase();
          const finalSymbol = tgtReq === "WMON" ? "USDC" : tgtReq;
          const targetAddress = (tokenMap[finalSymbol] ||
            USDC) as `0x${string}`;
          const srcReq = (decision.action.sourceToken || "").toUpperCase();
          return {
            amount: decision.action.amount || "0.05",
            token: targetAddress,
            interval: decision.nextInterval,
            sourceToken: srcReq || "USDC",
            decisionId: decision.id,
          };
        }
        // For SELL actions, we'll need to implement sell logic later
        // For now, default to buying USDC
        return {
          amount: "0.05",
          token: USDC as `0x${string}`,
          interval: decision.nextInterval,
          sourceToken: "MON",
          decisionId: decision.id,
        };
      }
      return null; // HOLD decision
    } catch (error) {
      console.error("AI callback failed:", error);
      return null;
    }
  };

  if (!isInitialized) {
    return (
      <div className="max-w-md w-full">
        <div className="glass rounded-2xl p-8 text-center">
          {isLoading ? (
            <>
              <div className="animate-spin w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full mx-auto mb-4"></div>
              <h2 className="text-xl font-semibold mb-2 text-white">
                Initializing…
              </h2>
              <p className="text-gray-300 text-sm">
                Setting up smart accounts and delegation permissions
              </p>
            </>
          ) : (
            <>
              <h2 className="text-xl font-semibold mb-2 text-white">
                Setup required
              </h2>
              <p className="text-gray-300 text-sm mb-4">
                Initialize your smart accounts and grant delegation. This takes
                one signature.
              </p>
              <button
                type="button"
                onClick={() => {
                  try {
                    reinitialize();
                  } catch {}
                }}
                className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-gradient-to-r from-purple-600 to-violet-600 text-white font-semibold hover:from-purple-700 hover:to-violet-700"
              >
                Initialize Delegation
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[1280px] mx-auto px-4">
      <div className="flex justify-center mb-3">
        <div className="grid grid-cols-[360px_560px_360px] items-center gap-4 w-[1280px]">
          <div className="pr-1">
            <div className="flex gap-2">
              <button
                onClick={() => setActive("trade")}
                className={`px-3 py-2 rounded-lg text-sm ${
                  active === "trade"
                    ? "bg-white/10 text-white"
                    : "bg-white/5 text-gray-300 hover:text-white"
                }`}
              >
                Trade
              </button>
              <button
                onClick={() => setActive("ai")}
                className={`px-3 py-2 rounded-lg text-sm ${
                  active === "ai"
                    ? "bg-white/10 text-white"
                    : "bg-white/5 text-gray-300 hover:text-white"
                }`}
              >
                AI
              </button>
              <button
                onClick={() => setActive("metrics")}
                className={`px-3 py-2 rounded-lg text-sm ${
                  active === "metrics"
                    ? "bg-white/10 text-white"
                    : "bg-white/5 text-gray-300 hover:text-white"
                }`}
              >
                Metrics
              </button>
              <button
                onClick={() => setActive("verification")}
                className={`px-3 py-2 rounded-lg text-sm ${
                  active === "verification"
                    ? "bg-white/10 text-white"
                    : "bg-white/5 text-gray-300 hover:text-white"
                }`}
              >
                Verification
              </button>
              <button
                onClick={() => setActive("settings")}
                className={`px-3 py-2 rounded-lg text-sm ${
                  active === "settings"
                    ? "bg-white/10 text-white"
                    : "bg-white/5 text-gray-300 hover:text-white"
                }`}
              >
                Settings
              </button>
            </div>
          </div>
          <div />
          <div className="flex items-center justify-end pr-1">
            <button
              onClick={refreshBalances}
              disabled={isLoading}
              className="p-2 text-gray-300 hover:text-white disabled:opacity-50"
            >
              <RefreshCw
                size={16}
                className={isLoading ? "animate-spin" : ""}
              />
            </button>
          </div>
        </div>
      </div>

      {active === "trade" && (
        <div className="flex justify-center">
          <div className="grid grid-cols-[360px_560px_360px] gap-4 items-stretch w-[1280px]">
            <div className="space-y-4 max-h-[78vh] overflow-y-auto pr-1">
              <div className="glass rounded-2xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="text-xl font-semibold text-white flex items-center gap-2">
                    <SlidersHorizontal size={18} />
                    DCA
                  </div>
                  <label className="inline-flex items-center gap-2 text-sm text-gray-300">
                    <input
                      type="checkbox"
                      checked={aiEnabled}
                      onChange={(e) => setEnabled(e.target.checked)}
                      className="accent-purple-500"
                      disabled={provider !== "openai"}
                      title={
                        provider !== "openai"
                          ? provider === "opengradient"
                            ? "Ready. Needs Devnet Token."
                            : "Coming Soon"
                          : "active"
                      }
                    />
                    AI Control
                  </label>
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        !metricsLoading && !metricsError
                          ? "bg-green-400"
                          : "bg-yellow-400"
                      }`}
                    ></span>
                    <span className="text-[11px] text-gray-400">
                      Envio{" "}
                      {!metricsLoading && !metricsError
                        ? "Available"
                        : "Pending"}
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowAiLimits((v) => !v)}
                      className="text-[11px] px-2 py-1 rounded bg-white/5 text-gray-300 hover:text-white"
                    >
                      Limits
                    </button>
                    <label className="inline-flex items-center gap-2 text-[11px] text-gray-300">
                      <input
                        type="checkbox"
                        className="accent-purple-500"
                        checked={aiLimitsEnabled}
                        onChange={(e) => setAiLimitsEnabled(e.target.checked)}
                      />{" "}
                      Enable
                    </label>
                  </div>
                </div>
                {showAiLimits && (
                  <div className="grid md:grid-cols-2 gap-2 text-xs">
                    <div className="flex items-center gap-2">
                      <select
                        value={aiEntryKind}
                        onChange={(e) => setAiEntryKind(e.target.value as any)}
                        className="bg-zinc-900/50 border border-zinc-600 rounded px-2 py-1 text-gray-200"
                      >
                        <option value="above">Start if ≥</option>
                        <option value="below">Start if ≤</option>
                      </select>
                      <input
                        type="number"
                        inputMode="decimal"
                        step="any"
                        placeholder="Entry price (base)"
                        value={aiEntryPrice}
                        onChange={(e) => setAiEntryPrice(e.target.value)}
                        className="w-full bg-zinc-900/50 border border-zinc-600 rounded px-2 py-1 text-white"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="inline-flex items-center gap-2 text-xs text-gray-300">
                        <input
                          type="checkbox"
                          className="accent-purple-500"
                          checked={aiStopEnabled}
                          onChange={(e) => setAiStopEnabled(e.target.checked)}
                        />{" "}
                        Stop
                      </label>
                      <select
                        value={aiStopKind}
                        onChange={(e) => setAiStopKind(e.target.value as any)}
                        className="bg-zinc-900/50 border border-zinc-600 rounded px-2 py-1 text-gray-200"
                      >
                        <option value="above">if ≥</option>
                        <option value="below">if ≤</option>
                      </select>
                      <input
                        type="number"
                        inputMode="decimal"
                        step="any"
                        placeholder="Stop price (base)"
                        value={aiStopPrice}
                        onChange={(e) => setAiStopPrice(e.target.value)}
                        className="w-full bg-zinc-900/50 border border-zinc-600 rounded px-2 py-1 text-white"
                      />
                    </div>
                    <div className="col-span-2 flex items-center gap-3 text-xs">
                      <label className="inline-flex items-center gap-2 text-gray-300">
                        <input
                          type="checkbox"
                          className="accent-purple-500"
                          checked={aiTrailEnabled}
                          onChange={(e) => setAiTrailEnabled(e.target.checked)}
                        />{" "}
                        Trailing stop
                      </label>
                      <div className="flex items-center gap-2">
                        <span className="text-gray-400">Drop %</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          step="any"
                          value={aiTrailPct}
                          onChange={(e) => setAiTrailPct(e.target.value)}
                          className="w-24 bg-zinc-900/50 border border-zinc-600 rounded px-2 py-1 text-xs text-white"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {aiEnabled ? (
                <div className="p-3 bg-white/5 border border-white/10 rounded-lg text-xs text-gray-300">
                  <div>
                    AI control enabled. Amount, slippage, target token and
                    interval are decided by the AI.
                  </div>
                  <div className="mt-1 text-gray-400 flex items-center justify-between">
                    <span>
                      Powered by Envio metrics. The AI analyzes market metrics,
                      whale activity, and portfolio balance.
                    </span>
                    <span className="ml-2 inline-flex items-center gap-1">
                      {(() => {
                        const fresh =
                          !!metrics?.lastUpdated &&
                          Date.now() - (metrics.lastUpdated || 0) < 120000;
                        const color = fresh
                          ? "bg-green-400"
                          : metricsLoading
                          ? "bg-yellow-400"
                          : metricsError
                          ? "bg-red-400"
                          : "bg-yellow-400";
                        const label = fresh
                          ? "Available"
                          : metricsLoading
                          ? "Pending"
                          : metricsError
                          ? "Offline"
                          : "Pending";
                        return (
                          <>
                            <span
                              className={`w-2 h-2 rounded-full ${color}`}
                            ></span>
                            <span className="text-[11px] text-gray-400">
                              Envio {label}
                            </span>
                          </>
                        );
                      })()}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-300 mb-1">
                      MON Amount
                    </label>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="any"
                      value={monDcaAmount}
                      onChange={(e) => setMonDcaAmount(e.target.value)}
                      className="w-full bg-zinc-900/50 border border-zinc-600 rounded-lg px-3 py-2 text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-300 mb-1">
                      Slippage (bps)
                    </label>
                    <input
                      type="number"
                      inputMode="numeric"
                      step="1"
                      value={slippageBps}
                      onChange={(e) => setSlippageBps(e.target.value)}
                      className="w-full bg-zinc-900/50 border border-zinc-600 rounded-lg px-3 py-2 text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-300 mb-1">
                      Target Token
                    </label>
                    <select
                      value={outToken}
                      onChange={(e) => setOutToken(e.target.value)}
                      className="w-full bg-zinc-900/50 border border-zinc-600 rounded-lg px-3 py-2 text-white"
                    >
                      {getTargetTokens()
                        .filter((t) => t.symbol !== "WMON")
                        .map((token) => (
                          <option key={token.symbol} value={token.symbol}>
                            {token.symbol}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-300 mb-1">
                      Interval (s)
                    </label>
                    <input
                      type="number"
                      inputMode="numeric"
                      step="1"
                      min={Number(
                        (import.meta as any).env
                          ?.VITE_MIN_DCA_INTERVAL_SECONDS ?? 60
                      )}
                      value={interval}
                      onChange={(e) => setInterval(e.target.value)}
                      className="w-full bg-zinc-900/50 border border-zinc-600 rounded-lg px-3 py-2 text-white"
                    />
                  </div>
                  <div className="col-span-2">
                    <div className="flex items-center justify-between mb-1">
                      <button
                        type="button"
                        onClick={() => setShowManualLimits((v) => !v)}
                        className="text-[11px] px-2 py-1 rounded bg-white/5 text-gray-300 hover:text-white"
                      >
                        Limits
                      </button>
                      <label className="inline-flex items-center gap-2 text-[11px] text-gray-300">
                        <input
                          type="checkbox"
                          className="accent-purple-500"
                          checked={limitsEnabled}
                          onChange={(e) => setLimitsEnabled(e.target.checked)}
                        />{" "}
                        Enable
                      </label>
                    </div>
                    {showManualLimits && (
                      <div className="grid grid-cols-2 gap-2">
                        <div className="flex items-center gap-2">
                          <select
                            value={entryKind}
                            onChange={(e) =>
                              setEntryKind(e.target.value as any)
                            }
                            className="bg-zinc-900/50 border border-zinc-600 rounded px-2 py-1 text-xs text-gray-200"
                          >
                            <option value="above">Start if ≥</option>
                            <option value="below">Start if ≤</option>
                          </select>
                          <input
                            type="number"
                            inputMode="decimal"
                            step="any"
                            placeholder="Entry price (base)"
                            value={entryPrice}
                            onChange={(e) => setEntryPrice(e.target.value)}
                            className="w-full bg-zinc-900/50 border border-zinc-600 rounded px-2 py-1 text-xs text-white"
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="inline-flex items-center gap-2 text-xs text-gray-300">
                            <input
                              type="checkbox"
                              className="accent-purple-500"
                              checked={stopEnabled}
                              onChange={(e) => setStopEnabled(e.target.checked)}
                            />{" "}
                            Stop
                          </label>
                          <select
                            value={stopKind}
                            onChange={(e) => setStopKind(e.target.value as any)}
                            className="bg-zinc-900/50 border border-zinc-600 rounded px-2 py-1 text-xs text-gray-200"
                          >
                            <option value="above">if ≥</option>
                            <option value="below">if ≤</option>
                          </select>
                          <input
                            type="number"
                            inputMode="decimal"
                            step="any"
                            placeholder="Stop price (base)"
                            value={stopPrice}
                            onChange={(e) => setStopPrice(e.target.value)}
                            className="w-full bg-zinc-900/50 border border-zinc-600 rounded px-2 py-1 text-xs text-white"
                          />
                        </div>
                        <div className="col-span-2 flex items-center gap-3 text-xs">
                          <label className="inline-flex items-center gap-2 text-gray-300">
                            <input
                              type="checkbox"
                              className="accent-purple-500"
                              checked={trailEnabled}
                              onChange={(e) =>
                                setTrailEnabled(e.target.checked)
                              }
                            />{" "}
                            Trailing stop
                          </label>
                          <div className="flex items-center gap-2">
                            <span className="text-gray-400">Drop %</span>
                            <input
                              type="number"
                              inputMode="decimal"
                              step="any"
                              value={trailPct}
                              onChange={(e) => setTrailPct(e.target.value)}
                              className="w-24 bg-zinc-900/50 border border-zinc-600 rounded px-2 py-1 text-xs text-white"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div className="grid grid-cols-1 gap-3 mt-4">
                {!dcaStatus.isActive ? (
                  <button
                    onClick={() => {
                      const selected = getToken(outToken);
                      const addr = (
                        selected && selected.symbol !== "WMON"
                          ? selected.address
                          : getTargetTokens().find((t) => t.symbol !== "WMON")
                              ?.address || USDC
                      ) as `0x${string}`;
                      // reset trailing highs at start
                      trailHighRef.current = {};
                      aiTrailHighRef.current = {};
                      return startNativeDca(
                        monDcaAmount,
                        parseInt(slippageBps),
                        addr,
                        parseInt(interval),
                        aiEnabled,
                        aiEnabled ? aiCallback : undefined,
                        conditionCallback
                      );
                    }}
                    disabled={
                      isLoading ||
                      delegationExpired ||
                      // Only gate AI start until initial metrics/prices are ready; do not re-disable on refresh
                      (aiEnabled && !initialDataReadyRef.current)
                    }
                    className="flex items-center justify-center gap-2 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 disabled:opacity-50 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200"
                    style={{
                      boxShadow:
                        "0 0 25px rgba(34, 197, 94, 0.5), 0 4px 15px rgba(0, 0, 0, 0.2)",
                    }}
                  >
                    {aiEnabled ? "Start AI" : "Start"}
                  </button>
                ) : (
                  <button
                    onClick={() => stopDca()}
                    disabled={isLoading}
                    className="flex items-center justify-center gap-2 bg-gradient-to-r from-red-600 to-pink-600 hover:from-red-700 hover:to-pink-700 disabled:opacity-50 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200"
                    style={{
                      boxShadow:
                        "0 0 25px rgba(239, 68, 68, 0.5), 0 4px 15px rgba(0, 0, 0, 0.2)",
                    }}
                  >
                    {aiEnabled ? "Stop AI" : "Stop"}
                  </button>
                )}
              </div>
            </div>
            <div />
            <div className="space-y-4 max-h-[78vh] overflow-y-auto pr-1">
              <div className="glass rounded-2xl p-5">
                <div className="text-lg font-semibold mb-3 text-white flex items-center gap-2">
                  <Cpu size={18} />
                  MON Actions
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-gray-300 mb-1">
                      Deposit MON
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        inputMode="decimal"
                        step="any"
                        value={monAmount}
                        onChange={(e) => setMonAmount(e.target.value)}
                        className="w-full bg-zinc-900/50 border border-zinc-600 rounded-lg px-3 py-2 text-white"
                      />
                      <button
                        onClick={() => topUpMon(monAmount)}
                        disabled={isLoading}
                        className="px-4 rounded-lg bg-gradient-to-r from-purple-600 to-violet-600 hover:from-purple-700 hover:to-violet-700 text-white font-semibold shadow-lg transition-all duration-200"
                        style={{
                          boxShadow:
                            "0 0 20px rgba(147, 51, 234, 0.4), 0 4px 15px rgba(0, 0, 0, 0.2)",
                        }}
                      >
                        Deposit
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-300 mb-1">
                      Portfolio Actions
                    </label>
                    <button
                      onClick={() => convertAllToMon(parseInt(slippageBps))}
                      disabled={
                        isLoading || delegationExpired || !hasConvertible
                      }
                      className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-600 hover:to-yellow-600 disabled:opacity-50 text-white font-semibold py-3 px-4 rounded-xl transition-all duration-200"
                      style={{
                        boxShadow:
                          "0 0 25px rgba(245, 158, 11, 0.5), 0 4px 15px rgba(0, 0, 0, 0.2)",
                      }}
                    >
                      <ArrowUpDown size={16} />
                      Convert ALL to MON
                    </button>
                  </div>
                </div>
              </div>
              <div className="glass rounded-2xl p-5">
                <div className="text-lg font-semibold mb-3 text-white flex items-center gap-2">
                  <Cpu size={18} />
                  Magma Liquid Stacking
                </div>
                <div className="space-y-3 text-sm text-gray-300">
                  <div className="flex items-center justify-between">
                    <span>Auto stake</span>
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="accent-purple-500"
                        checked={restakeAi}
                        onChange={async (e) => {
                          const enabled = e.target.checked;
                          setRestakeAi(enabled);
                          if (enabled) {
                            try {
                              await ensureMagmaDelegation?.();
                            } catch {}
                          }
                        }}
                      />
                      <span className="text-xs">Enable</span>
                    </label>
                  </div>
                  <div className="text-[11px] text-gray-400">
                    Automatically convert your MON to gMON and back when
                    helpful. This helps you earn yield while keeping funds
                    liquid. You can turn this off anytime.
                  </div>
                </div>
              </div>
              <div className="glass rounded-2xl p-5">
                <div className="text-lg font-semibold mb-3 text-white flex items-center gap-2">
                  <BarChart2 size={18} />
                  Balances
                </div>
                <div className="grid grid-cols-1 gap-2 text-sm">
                  {parseFloat(balances.MON || "0") > 0 && (
                    <div className="flex justify-between items-center gap-3 flex-wrap">
                      <span className="text-gray-300 flex items-center gap-2">
                        {TOKENS.MON.logoUrl && (
                          <img
                            src={TOKENS.MON.logoUrl}
                            alt="MON"
                            className="w-4 h-4 rounded-full"
                            onError={(e) => {
                              try {
                                (e.currentTarget as HTMLImageElement).src =
                                  TOKENS.MON.logoUrl!;
                              } catch {}
                            }}
                          />
                        )}
                        MON
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-white font-mono truncate max-w-[140px]">
                          {formatMonDisplay(balances.MON)}
                        </span>
                        <button
                          onClick={() => openWithdraw("MON")}
                          disabled={isLoading}
                          className="px-2 py-0.5 text-xs rounded bg-gradient-to-r from-pink-600 to-rose-600 text-white disabled:opacity-50"
                        >
                          Withdraw
                        </button>
                      </div>
                    </div>
                  )}
                  {parseFloat((balances as any).gMON || "0") > 0 && (
                    <div className="flex justify-between items-center gap-3 flex-wrap">
                      <span className="text-gray-300 flex items-center gap-2">
                        {TOKENS.gMON?.logoUrl && (
                          <img
                            src={TOKENS.gMON.logoUrl}
                            alt="gMON"
                            className="w-4 h-4 rounded-full"
                            onError={(e) => {
                              try {
                                (e.currentTarget as HTMLImageElement).src =
                                  TOKENS.gMON.logoUrl!;
                              } catch {}
                            }}
                          />
                        )}
                        gMON
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-white font-mono truncate max-w-[140px]">
                          {(balances as any).gMON ?? "0.0"}
                        </span>
                        <button
                          onClick={() => {
                            try {
                              const amt = (balances as any).gMON || "0";
                              if (parseFloat(amt) > 0) {
                                unstakeMagma?.(amt, { silent: true });
                              }
                            } catch {}
                          }}
                          disabled={isLoading}
                          className="px-2 py-0.5 text-xs rounded bg-gradient-to-r from-amber-600 to-yellow-600 text-white disabled:opacity-50"
                        >
                          Unstake
                        </button>
                      </div>
                    </div>
                  )}
                  {getAllTradableTokens()
                    .filter((t) => t.symbol !== "WMON")
                    .filter(
                      (t) => parseFloat((balances as any)[t.symbol] || "0") > 0
                    )
                    .map((t) => (
                      <div
                        key={t.symbol}
                        className="flex justify-between items-center gap-3 flex-wrap"
                      >
                        <span className="text-gray-300 flex items-center gap-2">
                          {t.logoUrl && (
                            <img
                              src={t.logoUrl}
                              alt={t.symbol}
                              className="w-4 h-4 rounded-full"
                              onError={(e) => {
                                try {
                                  (e.currentTarget as HTMLImageElement).src =
                                    TOKENS.MON.logoUrl!;
                                } catch {}
                              }}
                            />
                          )}
                          {t.symbol}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="text-white font-mono truncate max-w-[140px]">
                            {(balances as any)[t.symbol] ?? "0.0"}
                          </span>
                          <button
                            onClick={() => openWithdraw(t.symbol)}
                            disabled={isLoading}
                            className="px-2 py-0.5 text-xs rounded bg-gradient-to-r from-rose-600 to-pink-600 text-white disabled:opacity-50"
                          >
                            Withdraw
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
                <div className="mt-3">
                  <button
                    onClick={() => withdrawAll()}
                    disabled={isLoading}
                    className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-rose-700 to-pink-700 hover:from-rose-800 hover:to-pink-800 disabled:opacity-50 text-white font-semibold py-2 px-3 rounded-xl text-sm"
                  >
                    Withdraw ALL
                  </button>
                </div>
              </div>
              <div className="glass rounded-2xl p-5">
                <div className="text-lg font-semibold mb-3 text-white flex items-center gap-2">
                  <Settings size={18} />
                  Status
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-300">DCA</span>
                    <span
                      className={`font-semibold ${
                        dcaStatus.isActive ? "text-green-400" : "text-gray-400"
                      }`}
                    >
                      {dcaStatus.isActive ? "Active" : "Stopped"}
                    </span>
                  </div>
                  {dcaStatus.nextExecution && (
                    <div className="flex justify-between">
                      <span className="text-gray-300">Next</span>
                      <span className="text-white font-mono">
                        {dcaStatus.nextExecution.toLocaleTimeString()}
                      </span>
                    </div>
                  )}
                  {(dcaStatus as any).lastTxHash || dcaStatus.lastUserOpHash ? (
                    <div className="flex justify-between items-center">
                      <span className="text-gray-300">Last Tx</span>
                      {(dcaStatus as any).lastTxHash ? (
                        <a
                          className="text-blue-400 font-mono hover:underline"
                          href={`https://testnet.monadexplorer.com/tx/${
                            (dcaStatus as any).lastTxHash
                          }`}
                          target="_blank"
                          rel="noreferrer"
                          title="Open in explorer"
                        >
                          {String((dcaStatus as any).lastTxHash).slice(0, 10)}
                          ...
                        </a>
                      ) : (
                        <span className="text-gray-400 font-mono flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
                          Pending…
                        </span>
                      )}
                    </div>
                  ) : null}
                  {visibleError && (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-gray-300">Last Error</span>
                      <div className="flex items-center gap-2">
                        <span className="text-red-400">{visibleError}</span>
                        {visibleError.startsWith("ERC20 skipped") && (
                          <button
                            onClick={renewDelegation}
                            disabled={isLoading}
                            className="px-2 py-0.5 text-xs rounded bg-gradient-to-r from-amber-600 to-yellow-600 text-white disabled:opacity-50"
                            title="Renew core delegation to enable ERC20 withdrawals"
                          >
                            Renew
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {active === "ai" && (
        <div className="flex justify-center">
          <div className="grid grid-cols-[360px_560px_360px] gap-4 items-stretch w-[1280px]">
            <div className="space-y-4 max-h-[78vh] overflow-y-auto pr-1">
              <div className="glass rounded-2xl p-5">
                <div className="mb-4">
                  <div className="text-xl font-semibold text-white flex items-center gap-2 mb-3">
                    <Brain size={18} />
                    Autonomous AI Agent
                  </div>
                  <label className="inline-flex items-center gap-2 text-sm text-gray-300">
                    <input
                      type="checkbox"
                      checked={aiEnabled}
                      onChange={(e) => setEnabled(e.target.checked)}
                      className="accent-purple-500"
                      disabled={provider !== "openai"}
                      title={
                        provider !== "openai"
                          ? provider === "opengradient"
                            ? "Ready. Needs Devnet Token."
                            : "Coming Soon"
                          : "active"
                      }
                    />
                    Enable AI Control
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-4">
                  <button
                    onClick={() => setPersonality("conservative")}
                    className={`py-2 px-3 rounded-lg text-sm transition-all duration-200 ${
                      personality === "conservative"
                        ? "bg-blue-600 text-white"
                        : "bg-white/10 text-gray-300 hover:text-white"
                    }`}
                    style={
                      personality === "conservative"
                        ? { boxShadow: "0 0 20px rgba(37, 99, 235, 0.6)" }
                        : {}
                    }
                  >
                    Conservative
                  </button>
                  <button
                    onClick={() => setPersonality("balanced")}
                    className={`py-2 px-3 rounded-lg text-sm transition-all duration-200 ${
                      personality === "balanced"
                        ? "bg-blue-600 text-white"
                        : "bg-white/10 text-gray-300 hover:text-white"
                    }`}
                    style={
                      personality === "balanced"
                        ? { boxShadow: "0 0 20px rgba(37, 99, 235, 0.6)" }
                        : {}
                    }
                  >
                    Balanced
                  </button>
                  <button
                    onClick={() => setPersonality("aggressive")}
                    className={`py-2 px-3 rounded-lg text-sm transition-all duration-200 ${
                      personality === "aggressive"
                        ? "bg-blue-600 text-white"
                        : "bg-white/10 text-gray-300 hover:text-white"
                    }`}
                    style={
                      personality === "aggressive"
                        ? { boxShadow: "0 0 20px rgba(37, 99, 235, 0.6)" }
                        : {}
                    }
                  >
                    Aggressive
                  </button>
                  <button
                    onClick={() => setPersonality("contrarian")}
                    className={`py-2 px-3 rounded-lg text-sm transition-all duration-200 ${
                      personality === "contrarian"
                        ? "bg-blue-600 text-white"
                        : "bg-white/10 text-gray-300 hover:text-white"
                    }`}
                    style={
                      personality === "contrarian"
                        ? { boxShadow: "0 0 20px rgba(37, 99, 235, 0.6)" }
                        : {}
                    }
                  >
                    Contrarian
                  </button>
                </div>

                <div className="glass rounded-xl p-4 mb-4">
                  <div className="text-sm text-gray-300 mb-3">
                    Status & Personality
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div
                        className={`flex items-center gap-2 ${
                          aiEnabled ? "text-green-400" : "text-gray-400"
                        }`}
                      >
                        <div
                          className={`w-2 h-2 rounded-full ${
                            aiEnabled ? "bg-green-400" : "bg-gray-400"
                          }`}
                        ></div>
                        {aiEnabled ? "AI Enabled" : "AI Disabled"}
                      </div>
                      {isProcessing && (
                        <div className="flex items-center gap-2 text-yellow-400">
                          <div className="animate-spin w-3 h-3 border border-yellow-400 border-t-transparent rounded-full"></div>
                          <span className="text-xs">Processing...</span>
                        </div>
                      )}
                    </div>
                    <div className="text-sm">
                      <span className="text-gray-300">Personality: </span>
                      <span className="text-white capitalize font-medium">
                        {personality}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="glass rounded-xl p-4 mb-4">
                  <div className="text-sm text-gray-300 mb-3">AI Provider</div>
                  <div className="space-y-2">
                    <button
                      onClick={() => setProvider("openai")}
                      className={`w-full px-3 py-2 rounded-lg flex items-center gap-2 text-sm ${
                        provider === "openai"
                          ? "bg-white/10 text-white"
                          : "bg-white/5 text-gray-300 hover:text-white"
                      }`}
                    >
                      <span
                        className={`w-2 h-2 rounded-full ${
                          provider === "openai"
                            ? hasOpenAiKey
                              ? "bg-green-400"
                              : "bg-red-400"
                            : "bg-gray-400"
                        }`}
                      ></span>
                      Centralized
                    </button>
                    <button
                      onClick={() => {
                        setProvider("fortytwo");
                        try {
                          if (typeof window !== "undefined")
                            window.dispatchEvent(
                              new CustomEvent("ai:quip:fortytwo")
                            );
                        } catch {}
                      }}
                      className={`w-full px-3 py-2 rounded-lg flex items-center gap-2 text-sm ${
                        provider === "fortytwo"
                          ? "bg-white/10 text-white"
                          : "bg-white/5 text-gray-300 hover:text-white"
                      }`}
                    >
                      <span
                        className={`w-2 h-2 rounded-full ${
                          provider === "fortytwo"
                            ? "bg-yellow-400"
                            : "bg-gray-400"
                        }`}
                      ></span>
                      FortyTwo Network
                      <span className="text-xs text-yellow-400 ml-auto">
                        Coming Soon
                      </span>
                    </button>
                  </div>
                </div>

                {aiError && (
                  <div className="p-3 bg-red-600/20 border border-red-600/30 rounded-lg text-red-400 text-sm mb-4">
                    {aiError}
                  </div>
                )}

                <div className="glass rounded-xl p-4">
                  <div className="text-sm text-gray-300 mb-2">How it works</div>
                  <p className="text-gray-400 text-xs leading-relaxed">
                    {aiEnabled
                      ? "AI automatically controls DCA decisions using market metrics, whale activity, and portfolio balance analysis."
                      : "Enable AI to let the agent make autonomous trading decisions based on real-time market data."}
                  </p>
                </div>
              </div>
            </div>
            <div />
            <div className="space-y-4 max-h-[78vh] overflow-y-auto pr-1">
              {decisions.length > 0 && (
                <div className="glass rounded-2xl p-5">
                  <div className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                    <BarChart2 size={18} />
                    Decision History
                  </div>
                  <div className="space-y-3 max-h-60 overflow-y-auto">
                    {decisions.slice(0, 10).map((decision) => (
                      <div key={decision.id} className="glass rounded-lg p-3">
                        <div className="flex items-center justify-between mb-2">
                          <div className="text-sm text-gray-300">
                            {new Date(decision.timestamp).toLocaleString()}
                          </div>
                          <div
                            className={`px-2 py-1 rounded text-xs ${
                              decision.executed
                                ? "bg-green-600/20 text-green-400"
                                : "bg-yellow-600/20 text-yellow-400"
                            }`}
                          >
                            {decision.executed ? "Executed" : "Pending"}
                          </div>
                        </div>
                        <div className="text-white text-sm">
                          <span className="capitalize">
                            {decision.personality}
                          </span>
                          : {decision.action.type}
                          {decision.action.type === "BUY" &&
                            ` ${decision.action.amount} ${decision.action.sourceToken} → ${decision.action.targetToken}`}
                          {decision.action.type === "SELL_TO_MON" &&
                            ` ${decision.action.amount} ${decision.action.fromToken} → MON`}
                          {decision.action.type === "SELL_TO_USDC" &&
                            ` ${decision.action.amount} ${decision.action.fromToken} → USDC`}
                          {decision.action.type === "HOLD" &&
                            ` for ${decision.action.duration}s`}
                        </div>
                        <div className="text-gray-400 text-xs mt-1">
                          {decision.action.reasoning}
                        </div>
                        <div className="text-gray-500 text-xs mt-1">
                          Confidence: {Math.round(decision.confidence * 100)}% |
                          Next: {decision.nextInterval}s
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {active === "metrics" && (
        <div className="flex items-stretch justify-center gap-4">
          <div className="w-[360px] shrink-0 space-y-4 max-h-[78vh] overflow-y-auto pr-1">
            <div className="glass rounded-2xl p-5">
              <div className="text-sm text-gray-300">
                Users Today (all protocols)
              </div>
              <div className="text-2xl text-white font-bold">
                {todayTotals.users}
              </div>
            </div>
            <div className="glass rounded-2xl p-5">
              <div className="text-sm text-gray-300">
                Tx Today (all protocols)
              </div>
              <div className="text-2xl text-white font-bold">
                {todayTotals.tx}
              </div>
            </div>
          </div>

          <div className="w-[560px] shrink-0" />

          <div className="w-[360px] shrink-0 space-y-4 max-h-[78vh] overflow-y-auto pr-1">
            <div className="glass rounded-2xl p-5">
              <div className="mb-3">
                <div className="text-lg font-semibold text-white mb-2">
                  Protocol Metrics
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => setMetricKey("txDaily")}
                      className={`px-2 py-1 rounded ${
                        metricKey === "txDaily"
                          ? "bg-white/10 text-white"
                          : "bg-white/5 text-gray-300"
                      }`}
                    >
                      Tx/day
                    </button>
                    <button
                      onClick={() => setMetricKey("usersDaily")}
                      className={`px-2 py-1 rounded ${
                        metricKey === "usersDaily"
                          ? "bg-white/10 text-white"
                          : "bg-white/5 text-gray-300"
                      }`}
                    >
                      Users/day
                    </button>
                    <button
                      onClick={() => setMetricKey("txCumulative")}
                      className={`px-2 py-1 rounded ${
                        metricKey === "txCumulative"
                          ? "bg-white/10 text-white"
                          : "bg-white/5 text-gray-300"
                      }`}
                    >
                      Tx cumulative
                    </button>
                    <button
                      onClick={() => setMetricKey("avgTxPerUser")}
                      className={`px-2 py-1 rounded ${
                        metricKey === "avgTxPerUser"
                          ? "bg-white/10 text-white"
                          : "bg-white/5 text-gray-300"
                      }`}
                    >
                      Avg tx/user
                    </button>
                    <button
                      onClick={() => setMetricKey("avgFeeNative")}
                      className={`px-2 py-1 rounded ${
                        metricKey === "avgFeeNative"
                          ? "bg-white/10 text-white"
                          : "bg-white/5 text-gray-300"
                      }`}
                    >
                      Avg fee (MON)
                    </button>
                  </div>
                  <div className="flex items-center gap-2 ml-auto">
                    <button
                      onClick={() => setHistoryDays(30)}
                      className={`px-2 py-1 rounded ${
                        historyDays === 30
                          ? "bg-white/10 text-white"
                          : "bg-white/5 text-gray-300"
                      }`}
                    >
                      30d
                    </button>
                    <button
                      onClick={() => setHistoryDays(90)}
                      className={`px-2 py-1 rounded ${
                        historyDays === 90
                          ? "bg-white/10 text-white"
                          : "bg-white/5 text-gray-300"
                      }`}
                    >
                      90d
                    </button>
                    <button
                      onClick={() => setHistoryDays(180)}
                      className={`px-2 py-1 rounded ${
                        historyDays === 180
                          ? "bg-white/10 text-white"
                          : "bg-white/5 text-gray-300"
                      }`}
                    >
                      180d
                    </button>
                    <button
                      onClick={() =>
                        setHistoryDays((d) => Math.min(365, d + 30))
                      }
                      className="px-2 py-1 rounded bg-white/5 text-gray-300 hover:text-white"
                      title="Increase range"
                    >
                      +30d
                    </button>
                    <button
                      onClick={() => loadOlder?.()}
                      disabled={!hasMore}
                      className={`px-2 py-1 rounded ${
                        hasMore
                          ? "bg-white/5 text-gray-300 hover:text-white"
                          : "bg-white/5 text-gray-500 cursor-not-allowed"
                      }`}
                      title="Charger plus ancien"
                    >
                      Load older
                    </button>
                  </div>
                </div>
              </div>

              {dailyError && (
                <div className="text-sm text-red-400 mb-2">{dailyError}</div>
              )}
              {dailyLoading ? (
                <div className="text-sm text-gray-300">Loading…</div>
              ) : (
                <ProtocolMetricsChart
                  series={
                    metricKey === "avgFeeNative"
                      ? series.filter(
                          (s) =>
                            s.protocolId !== "curvance" &&
                            s.protocolId !== "dex" &&
                            s.protocolId !== "pyth"
                        )
                      : series.filter(
                          (s) =>
                            s.protocolId !== "dex" && s.protocolId !== "pyth"
                        )
                  }
                  dates={dates}
                />
              )}
            </div>

            <div className="glass rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-lg font-semibold text-white">
                  Token Metrics (live)
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <button
                    onClick={() => {
                      setTokenMetricKind("price");
                    }}
                    className={`px-2 py-1 rounded ${
                      tokenMetricKind === "price"
                        ? "bg-white/10 text-white"
                        : "bg-white/5 text-gray-300"
                    }`}
                  >
                    Price Index
                  </button>
                  <button
                    onClick={() => {
                      setTokenMetricKind("momentum");
                    }}
                    className={`px-2 py-1 rounded ${
                      tokenMetricKind === "momentum"
                        ? "bg-white/10 text-white"
                        : "bg-white/5 text-gray-300"
                    }`}
                  >
                    Momentum
                  </button>
                  <button
                    onClick={() => {
                      setTokenMetricKind("volatility");
                    }}
                    className={`px-2 py-1 rounded ${
                      tokenMetricKind === "volatility"
                        ? "bg-white/10 text-white"
                        : "bg-white/5 text-gray-300"
                    }`}
                  >
                    Volatility
                  </button>
                </div>
              </div>
              {tokenMetricKind === "volatility" ? (
                <ProtocolBarChart
                  data={getTargetTokens().map((t) => {
                    const m = tokenMetrics.find((tm) => tm.token === t.symbol);
                    return {
                      protocolId: t.symbol,
                      value: Number(m?.volatility || 0),
                    };
                  })}
                />
              ) : (
                (() => {
                  const selected = getToken(outToken);
                  const sym = selected?.symbol || "";
                  const baseSeries = Object.values(
                    tokenMetricKind === "price"
                      ? tokenSeriesPrice
                      : tokenSeriesMomentum
                  );
                  const hasAnyPoints = baseSeries.some(
                    (s) => (s.points || []).length > 0
                  );
                  // Selected token points unused (overlays removed)
                  const datesForChart =
                    tokenMetricKind === "price"
                      ? tokenDatesPrice
                      : tokenDatesMomentum;
                  // For momentum display, derive a rolling % momentum from PRICE series to guarantee a distinct shape from raw USD prices.
                  // Momentum = % change between recent avg (last 10) and older avg (previous 20) per timestamp.
                  function deriveMomentumFromPrice() {
                    const out: {
                      token: string;
                      points: { x: string; y: number }[];
                    }[] = [];
                    const shortW = 10;
                    const longW = 30;
                    for (const s of Object.values(tokenSeriesPrice)) {
                      const pts = s.points || [];
                      if (!pts.length) {
                        out.push({ token: s.token, points: [] });
                        continue;
                      }
                      const ys = pts.map((p) => p.y);
                      const mo: { x: string; y: number }[] = [];
                      for (let i = 0; i < ys.length; i++) {
                        const iShort = Math.max(0, i - shortW + 1);
                        const iLongStart = Math.max(0, i - longW + 1);
                        const olderEnd = Math.max(iLongStart, iShort);
                        const recentSlice = ys.slice(iShort, i + 1);
                        const olderSlice = ys.slice(iLongStart, olderEnd);
                        const avg = (arr: number[]) =>
                          arr.length
                            ? arr.reduce((a, b) => a + b, 0) / arr.length
                            : NaN;
                        const rAvg = avg(recentSlice);
                        const oAvg = avg(olderSlice);
                        const y =
                          Number.isFinite(oAvg) &&
                          oAvg > 0 &&
                          Number.isFinite(rAvg)
                            ? ((rAvg - oAvg) / oAvg) * 100
                            : 0;
                        mo.push({ x: pts[i].x, y });
                      }
                      out.push({ token: s.token, points: mo });
                    }
                    return out;
                  }
                  const displaySeries =
                    tokenMetricKind === "price"
                      ? baseSeries
                      : deriveMomentumFromPrice();
                  if (!hasAnyPoints) {
                    return (
                      <div className="text-sm text-gray-400">
                        Warming up live metrics…
                      </div>
                    );
                  }
                  // overlays removed
                  const overlays = [] as {
                    token: string;
                    points: { x: string; y: number }[];
                  }[];
                  return (
                    <div>
                      <div className="flex items-center gap-3 mb-2 text-xs text-gray-300 flex-wrap">
                        {tokenMetricKind === "price" && (
                          <>
                            <div className="inline-flex items-center gap-2 mr-2">
                              <button
                                onClick={() => setChartUnit("USD")}
                                className={`px-2 py-0.5 rounded ${
                                  chartUnit === "USD"
                                    ? "bg-slate-700 text-white"
                                    : "text-gray-400 hover:text-white"
                                }`}
                              >
                                USD
                              </button>
                              <button
                                onClick={() => setChartUnit("%")}
                                className={`px-2 py-0.5 rounded ${
                                  chartUnit === "%"
                                    ? "bg-slate-700 text-white"
                                    : "text-gray-400 hover:text-white"
                                }`}
                              >
                                %
                              </button>
                            </div>
                            <label className="inline-flex items-center gap-1">
                              <input
                                type="checkbox"
                                className="accent-purple-500"
                                checked={logScale}
                                onChange={(e) => setLogScale(e.target.checked)}
                              />{" "}
                              Log scale
                            </label>
                          </>
                        )}
                      </div>
                      <TokenMetricsChart
                        series={displaySeries as any}
                        dates={datesForChart}
                        zeroAxis={tokenMetricKind !== "price"}
                        overlays={overlays}
                        volBars={(tokenVolSeries[sym]?.points || []).map(
                          (p) => ({ x: p.x, y: p.y })
                        )}
                        showVolume={showVolume}
                        selectedToken={selectedChartToken || undefined}
                        showOnlySelected={true}
                        logScale={logScale}
                        normalizeMode={
                          tokenMetricKind === "price"
                            ? chartUnit === "%"
                              ? "pct"
                              : "none"
                            : "none"
                        }
                        unit={tokenMetricKind === "price" ? chartUnit : "%"}
                        onSelect={(tok) =>
                          setSelectedChartToken((prev) =>
                            prev === tok ? null : tok
                          )
                        }
                      />
                    </div>
                  );
                })()
              )}
              <div className="text-xs text-gray-400 mt-2">
                Values normalized against USDC or WMON for comparability.
                Includes UniversalRouter and Kuru OrderBook trades. Refreshes as
                metrics update.
              </div>
            </div>

            <div className="glass rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-lg font-semibold text-white">
                  Whale Movements (7d)
                </div>
                <div className="flex items-center gap-2 text-xs opacity-90">
                  <span className="text-gray-300">Whale ≥</span>
                  <select
                    className="bg-black/30 border border-white/10 rounded px-1 py-0.5"
                    value={String(whaleThreshold)}
                    onChange={(e) =>
                      onChangeWhaleThreshold(Number(e.target.value))
                    }
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
              {whalesError && (
                <div className="text-sm text-red-400 mb-2">{whalesError}</div>
              )}
              {whalesLoading ? (
                <div className="text-sm text-gray-300">Loading…</div>
              ) : (
                <div className="max-h-80 overflow-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-400">
                        <th className="text-left">Token</th>
                        <th className="text-left">Amount</th>
                        <th className="text-left">From → To</th>
                        <th className="text-left">Tx</th>
                        <th className="text-left">Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(whaleRows || []).slice(0, 150).map((m, i) => (
                        <tr key={m.id || i} className="text-gray-200">
                          <td className="py-1">{m.token}</td>
                          <td className="py-1">
                            {Number(m.value).toLocaleString(undefined, {
                              maximumFractionDigits: 4,
                            })}
                          </td>
                          <td className="py-1">
                            {m.from.slice(0, 6)}…{m.from.slice(-4)} →{" "}
                            {m.to.slice(0, 6)}…{m.to.slice(-4)}
                          </td>
                          <td className="py-1">
                            {m.transactionHash ? (
                              <a
                                className="text-indigo-300 hover:text-white underline underline-offset-2"
                                href={`https://testnet.monadexplorer.com/tx/${m.transactionHash}`}
                                target="_blank"
                                rel="noreferrer"
                                title="Open in explorer"
                              >
                                {m.transactionHash.slice(0, 8)}…
                                {m.transactionHash.slice(-6)}
                              </a>
                            ) : (
                              "-"
                            )}
                          </td>
                          <td className="py-1">
                            {new Date(m.blockTimestamp * 1000).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="glass rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-lg font-semibold text-white">
                  Today by Protocol
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <button
                    onClick={() => setTodayMetric("txDaily")}
                    className={`px-2 py-1 rounded ${
                      todayMetric === "txDaily"
                        ? "bg-white/10 text-white"
                        : "bg-white/5 text-gray-300"
                    }`}
                  >
                    Tx/day
                  </button>
                  <button
                    onClick={() => setTodayMetric("usersDaily")}
                    className={`px-2 py-1 rounded ${
                      todayMetric === "usersDaily"
                        ? "bg-white/10 text-white"
                        : "bg-white/5 text-gray-300"
                    }`}
                  >
                    Users/day
                  </button>
                </div>
              </div>

              {todayError && (
                <div className="text-sm text-red-400 mb-2">{todayError}</div>
              )}
              {todayLoading ? (
                <div className="text-sm text-gray-300">Loading…</div>
              ) : (
                <ProtocolBarChart data={todayBarData} />
              )}
            </div>

            <div className="glass rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-lg font-semibold text-white">
                  Totals by Protocol
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <button
                    onClick={() => setTotalMetric("txCumulative")}
                    className={`px-2 py-1 rounded ${
                      totalMetric === "txCumulative"
                        ? "bg-white/10 text-white"
                        : "bg-white/5 text-gray-300"
                    }`}
                  >
                    Tx cumulative
                  </button>
                  <button
                    onClick={() => setTotalMetric("avgTxPerUser")}
                    className={`px-2 py-1 rounded ${
                      totalMetric === "avgTxPerUser"
                        ? "bg-white/10 text-white"
                        : "bg-white/5 text-gray-300"
                    }`}
                  >
                    Avg tx/user
                  </button>
                  <button
                    onClick={() => setTotalMetric("avgFeeNative")}
                    className={`px-2 py-1 rounded ${
                      totalMetric === "avgFeeNative"
                        ? "bg-white/10 text-white"
                        : "bg-white/5 text-gray-300"
                    }`}
                  >
                    Avg fee (MON)
                  </button>
                </div>
              </div>

              <ProtocolBarChart data={totalsBarData} />
            </div>

            <div className="glass rounded-2xl p-5">
              <div className="text-lg font-semibold text-white mb-2">
                Realtime Protocol Totals
              </div>
              <div className="grid grid-cols-5 gap-2 text-xs text-gray-300 mb-1">
                <div className="font-semibold">Protocol</div>
                <div className="font-semibold">Tx cumulative</div>
                <div className="font-semibold">Avg tx/user</div>
                <div className="font-semibold">Avg fee (MON)</div>
                <div className="font-semibold">Today users/tx</div>
              </div>
              {PROTOCOLS.map((pid) => {
                const latest = latestData.find((l) => l.protocolId === pid);
                const todayRow: any = todayData.find(
                  (t) => t.protocolId === pid
                );
                return (
                  <div
                    key={pid}
                    className="grid grid-cols-5 gap-2 text-xs text-gray-300 py-1"
                  >
                    <div className="text-white">{pid}</div>
                    <div>{latest ? latest.txCumulative : 0}</div>
                    <div>
                      {latest ? latest.avgTxPerUser.toFixed(2) : "0.00"}
                    </div>
                    <div>
                      {latest && latest.avgFeeNative != null
                        ? latest.avgFeeNative.toFixed(6)
                        : "-"}
                    </div>
                    <div>
                      {todayRow
                        ? `${todayRow.usersDaily}/${todayRow.txDaily}`
                        : "0/0"}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {active === "settings" && (
        <div className="glass rounded-2xl p-5 space-y-4">
          <div className="text-xl font-semibold text-white flex items-center gap-2">
            <Settings size={18} />
            Settings
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <button
              onClick={renewDelegation}
              disabled={isLoading}
              className="py-3 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 text-white font-semibold"
            >
              Renew Delegation
            </button>
            <button
              onClick={panic}
              disabled={isLoading}
              className="py-3 rounded-xl bg-gradient-to-r from-red-700 to-red-600 text-white font-semibold"
            >
              Panic
            </button>
          </div>
          <div className="text-sm text-gray-300">
            {delegationExpired && (
              <div className="text-red-400">Delegation expired</div>
            )}
            {!delegationExpired && typeof delegationExpiresAt === "number" && (
              <div>
                Expires at:{" "}
                <span className="font-mono text-gray-200">
                  {new Date(delegationExpiresAt * 1000).toLocaleString()}
                </span>
              </div>
            )}
          </div>
          <div className="grid md:grid-cols-2 gap-3 text-sm text-gray-300">
            {delegatorSmartAccount && (
              <div className="flex items-center gap-2">
                <span>Smart Account:</span>
                <span className="font-mono text-gray-200">
                  {delegatorSmartAccount.address.slice(0, 6)}...
                  {delegatorSmartAccount.address.slice(-4)}
                </span>
                <button
                  className="p-1 hover:text-white"
                  onClick={() =>
                    navigator.clipboard.writeText(delegatorSmartAccount.address)
                  }
                  title="Copy"
                >
                  <Copy size={14} />
                </button>
              </div>
            )}
            {/* Delegate smart account address intentionally hidden */}
          </div>
          <div className="glass rounded-xl p-4">
            <div className="text-lg font-semibold text-white mb-2">
              Envio Endpoint (Development Settings)
            </div>
            <div className="text-sm text-gray-300 mb-2">
              FAST is less precise but up to date, PRECISE is accurate but still
              syncing, if not available please wait up to 24h or use FAST
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => applyEnvioMode("FAST")}
                className={`px-3 py-2 rounded border ${
                  envioMode === "FAST"
                    ? "bg-indigo-500/20 text-white border-indigo-400/40"
                    : "bg-white/5 text-gray-200 hover:text-white border-white/10"
                }`}
              >
                Use FAST
              </button>
              <button
                onClick={() => applyEnvioMode("PRECISE")}
                className={`px-3 py-2 rounded border ${
                  envioMode === "PRECISE"
                    ? "bg-indigo-500/20 text-white border-indigo-400/40"
                    : "bg-white/5 text-gray-200 hover:text-white border-white/10"
                }`}
              >
                Use PRECISE
              </button>
            </div>
          </div>
        </div>
      )}

      {active === "verification" && (
        <AiVerificationPanel
          balances={balances}
          portfolioValueMon={
            parseFloat(balances.MON) +
            parseFloat(balances.WMON) +
            parseFloat(balances.USDC) * 0.1 +
            parseFloat(balances.CHOG) * 0.001
          }
          delegationExpired={delegationExpired}
        />
      )}
      <WithdrawModal
        open={withdrawOpen}
        symbol={withdrawSymbol}
        decimals={withdrawDecimals}
        balance={withdrawBalance}
        isLoading={isLoading}
        onClose={() => setWithdrawOpen(false)}
        onConfirm={handleWithdrawConfirm}
      />
    </div>
  );
}
