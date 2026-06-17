import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Shared 1s ticker.
 *
 * Phase 5 perf fix: previously `useNow()` lived at the App root, so every second
 * the ENTIRE tree (including the 3D <Canvas> and every card) re-rendered. Now a
 * single interval lives in this provider and exposes `now` via context. Only the
 * LEAF components that actually display a live-counting age subscribe with
 * `useTick()` — the static chrome and the globe do NOT subscribe, so they never
 * re-render on the tick. The globe animates off its own RAF clock instead.
 */
const TickContext = createContext<number>(Date.now());

export function TickProvider({
  children,
  intervalMs = 1000,
}: {
  children: ReactNode;
  intervalMs?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  const intervalRef = useRef(intervalMs);
  intervalRef.current = intervalMs;

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalRef.current);
    return () => clearInterval(id);
  }, []);

  return <TickContext.Provider value={now}>{children}</TickContext.Provider>;
}

/** Subscribe to the shared 1s tick. Re-renders the calling component each second. */
export function useTick(): number {
  return useContext(TickContext);
}
