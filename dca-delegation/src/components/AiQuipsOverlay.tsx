import { useEffect, useMemo, useRef, useState } from "react";
import { useAiRestaking } from "../hooks/useAiRestaking";

// Fun quips shown as ephemeral AI bubbles (no "Last Decision" badge)
const QUIPS = [
  "Skoolkid is a big brain. Not like me.",
  "Would you like me to read the daily news? I can barely read tho.",
  "I am dumb but I always try my best.",
  "I love novee",
  "Serious alpha: Chogtanks is the best game on Monad so far, forget the AAAs",
] as const;

const FORTYTWO_MSG =
  "Please follow @fortytwonetwork and send a message to mimie_matic in Monad Discord. Ask when 42.";

type Phase = "hidden" | "enter" | "visible" | "exit";

type Quip = { id: string; text: string };

interface AiQuipsOverlayProps {
  // Props gardées pour compatibilité mais non utilisées pour les effets visuels
  isInitialized?: boolean;
  signedDelegation?: any;
}

export default function AiQuipsOverlay({}: AiQuipsOverlayProps) {
  // Invoke hook for any internal side-effects; no need to read return value here
  useAiRestaking();
  const [mounted, setMounted] = useState(false);
  const [phase, setPhase] = useState<Phase>("hidden");
  const [current, setCurrent] = useState<Quip | null>(null);
  const queueRef = useRef<Quip[]>([]);
  const startTsRef = useRef<number>(Date.now());
  const lastTickSecRef = useRef<number>(-1);
  const lastFiredTickRef = useRef<number>(-1);

  const canShow = useMemo(
    // Afficher les quips IA fun tout le temps pour l'ambiance - pas besoin de délégation !
    () => true,
    []
  );

  // Drive animation phases
  useEffect(() => {
    if (!current || !canShow) return;
    setMounted(true);
    setPhase("enter");
    const t1 = setTimeout(() => setPhase("visible"), 20);
    const t2 = setTimeout(() => setPhase("exit"), 5600);
    const t3 = setTimeout(() => {
      setMounted(false);
      setPhase("hidden");
      setCurrent(null);
    }, 6000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [current?.id, canShow]);

  // Scheduler: every ~1s, check 30s ticks and 40% probability
  useEffect(() => {
    if (!canShow) return;
    let id: any;
    const loop = () => {
      const now = Date.now();
      const sec = Math.floor((now - startTsRef.current) / 1000);
      if (sec !== lastTickSecRef.current) {
        lastTickSecRef.current = sec;
        if (sec > 0 && sec % 30 === 0 && lastFiredTickRef.current !== sec) {
          lastFiredTickRef.current = sec;
          if (Math.random() < 0.4) {
            const pick = QUIPS[Math.floor(Math.random() * QUIPS.length)];
            enqueue({ id: `q_${now}`, text: pick });
          }
        }
      }
      id = setTimeout(loop, 1000);
    };
    id = setTimeout(loop, 1000);
    return () => clearTimeout(id);
  }, [canShow]);

  // One-time scheduled special message at ~42s
  useEffect(() => {
    if (!canShow) return;
    const t = setTimeout(() => {
      enqueue({ id: `forty2_sched_${Date.now()}`, text: FORTYTWO_MSG });
    }, 42000);
    return () => clearTimeout(t);
  }, [canShow]);

  function enqueue(q: Quip) {
    queueRef.current.push(q);
    // If nothing showing, start it immediately
    if (!current && phase === "hidden") {
      const next = queueRef.current.shift() || null;
      if (next) setCurrent(next);
    }
  }

  // When current finishes (phase transitions manage unmount), start next
  useEffect(() => {
    if (phase === "hidden" && !current) {
      const next = queueRef.current.shift() || null;
      if (next) setCurrent(next);
    }
  }, [phase, current]);

  // Special event: provider fortytwo selected -> chase current bubble and show immediately
  useEffect(() => {
    function onFortyTwo() {
      const special: Quip = { id: `forty2_${Date.now()}`, text: FORTYTWO_MSG };
      if (mounted && (phase === "enter" || phase === "visible")) {
        // Chase: brief exit then show special immediately
        setPhase("exit");
        setTimeout(() => {
          setMounted(false);
          setPhase("hidden");
          setCurrent(special);
        }, 220);
      } else {
        // Nothing on screen -> show now
        setCurrent(special);
      }
    }
    window.addEventListener("ai:quip:fortytwo", onFortyTwo as any);
    return () =>
      window.removeEventListener("ai:quip:fortytwo", onFortyTwo as any);
  }, [mounted, phase]);

  // Allow showing special messages (e.g., FortyTwo) even if not fully initialized
  if (!mounted || !current) return null;

  const style: React.CSSProperties =
    phase === "enter"
      ? {
          opacity: 0,
          transform: "translateY(16px)",
          transition: "opacity 240ms ease, transform 240ms ease",
        }
      : phase === "visible"
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
    <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 w-[560px] h-[560px]">
      <div className="absolute top-16 right-2 max-w-[260px]" style={style}>
        <div className="relative pointer-events-none rounded-xl px-3 py-2 text-xs leading-snug text-white/90 bg-black/50 backdrop-blur-md border border-white/10 shadow-[0_0_20px_rgba(99,102,241,0.25)]">
          <div className="text-[12px] text-white whitespace-pre-line">
            {current.text}
          </div>
        </div>
      </div>
    </div>
  );
}
