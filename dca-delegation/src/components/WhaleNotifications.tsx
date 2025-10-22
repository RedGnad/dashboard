import { useEffect, useMemo, useRef, useState } from "react";
import { useWhaleAlerts } from "../hooks/useWhaleAlerts";
import { TOKENS } from "../lib/tokens";

function formatLocal(ts: number) {
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return String(ts);
  }
}

function addrToSymbol(addr: string) {
  const a = addr.toLowerCase();
  for (const t of Object.values(TOKENS)) {
    if (t.address.toLowerCase() === a) return t.symbol;
  }
  if (a === "0x0000000000000000000000000000000000000000") return "MON";
  return a.slice(0, 6) + "..." + a.slice(-4);
}

function formatAmount(addr: string, raw: string) {
  try {
    const a = addr.toLowerCase();
    let decimals = 18;
    for (const t of Object.values(TOKENS)) {
      if (t.address.toLowerCase() === a) {
        decimals = t.decimals;
        break;
      }
    }
    const n = Number(raw) / Math.pow(10, decimals);
    if (!isFinite(n)) return raw;
    if (n >= 1) {
      return new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(n);
    }
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(
      n
    );
  } catch {
    return raw;
  }
}

export default function WhaleNotifications() {
  const { unseen, dismiss } = useWhaleAlerts();
  const visible = unseen.length > 0;

  const items = useMemo(() => unseen.slice(0, 4), [unseen]);

  // Add fade-in / fade-out like AI bubbles
  const [phases, setPhases] = useState<
    Record<string, "enter" | "visible" | "exit">
  >({});
  const timersRef = useRef<Record<string, { v?: any; e?: any; d?: any }>>({});

  // When new items appear, animate enter -> visible and schedule auto exit + dismiss
  useEffect(() => {
    const nextPhases: Record<string, "enter" | "visible" | "exit"> = {
      ...phases,
    };
    for (const a of items) {
      const key = a.tx;
      if (!nextPhases[key]) {
        nextPhases[key] = "enter";
        // small delay to trigger transition to visible
        if (!timersRef.current[key]) timersRef.current[key] = {};
        timersRef.current[key].v && clearTimeout(timersRef.current[key].v);
        timersRef.current[key].v = setTimeout(() => {
          setPhases((p) => ({ ...p, [key]: "visible" }));
        }, 20);

        // schedule auto exit and then dismiss, similar to AI bubbles
        timersRef.current[key].e && clearTimeout(timersRef.current[key].e);
        timersRef.current[key].e = setTimeout(() => {
          setPhases((p) => ({ ...p, [key]: "exit" }));
        }, 5600);

        timersRef.current[key].d && clearTimeout(timersRef.current[key].d);
        timersRef.current[key].d = setTimeout(() => {
          dismiss(key);
          setPhases((p) => {
            const { [key]: _, ...rest } = p;
            return rest;
          });
        }, 6000);
      }
    }
    // Clean up phases for items that are no longer present
    for (const k of Object.keys(nextPhases)) {
      if (!items.find((a) => a.tx === k)) {
        delete nextPhases[k];
        const t = timersRef.current[k];
        if (t) {
          t.v && clearTimeout(t.v);
          t.e && clearTimeout(t.e);
          t.d && clearTimeout(t.d);
          delete timersRef.current[k];
        }
      }
    }
    setPhases(nextPhases);
    return () => {
      // no-op: timers cleared on subsequent effects/unmount
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map((i) => i.tx).join("|")]);

  const handleDismiss = (tx: string) => {
    // Smooth fade-out then dismiss
    setPhases((p) => ({ ...p, [tx]: "exit" }));
    setTimeout(() => dismiss(tx), 220);
  };

  if (!visible) return null;

  return (
    <div className="fixed top-4 right-4 z-50 w-80 space-y-2">
      {items.map((a) => {
        const ph = phases[a.tx] || "visible";
        const style: React.CSSProperties =
          ph === "enter"
            ? {
                opacity: 0,
                transform: "translateY(16px)",
                transition: "opacity 240ms ease, transform 240ms ease",
              }
            : ph === "visible"
            ? {
                opacity: 1,
                transform: "translateY(0)",
                transition: "opacity 240ms ease, transform 240ms ease",
              }
            : {
                opacity: 0,
                transform: "translateY(-12px)",
                transition: "opacity 220ms ease, transform 220ms ease",
              };
        return (
          <div
            key={a.tx}
            className="glass rounded-xl p-3 border border-amber-500/30 bg-amber-500/10 shadow"
            style={style}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="text-sm text-white font-semibold">
                Whale movement
              </div>
              <button
                onClick={() => handleDismiss(a.tx)}
                className="text-xs text-gray-300 hover:text-white"
              >
                Dismiss
              </button>
            </div>
            <div className="text-sm text-gray-200">
              <div className="flex justify-between">
                <span>Token</span>
                <span className="font-mono text-white">
                  {addrToSymbol(a.token)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Amount</span>
                <span className="font-mono text-white">
                  {formatAmount(a.token, a.value)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>From</span>
                <span className="font-mono">
                  {a.from.slice(0, 6)}...{a.from.slice(-4)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>To</span>
                <span className="font-mono">
                  {a.to.slice(0, 6)}...{a.to.slice(-4)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Time</span>
                <span className="font-mono">{formatLocal(a.ts)}</span>
              </div>
            </div>
            <a
              href={`https://testnet.monadexplorer.com/tx/${a.tx}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              View tx
            </a>
          </div>
        );
      })}
      {unseen.length > items.length && (
        <div className="glass rounded-xl p-2 text-xs text-gray-300 text-center">
          +{unseen.length - items.length} more
        </div>
      )}
    </div>
  );
}
