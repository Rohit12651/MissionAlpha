// Story-Pipeline S6 (react-review remediation) — debounce a monotonically-bumped live nonce so
// an SSE story.changed storm coalesces into ONE authoritative refetch instead of one per frame.
// Immediate on mount (state seeds from the initial value); a same-value trailing emit is a React
// bail-out, so no wasted render. Wraps the pure, unit-tested makeCoalescer (see coalesce.ts).

import { useEffect, useRef, useState } from "react";
import { makeCoalescer, NONCE_COALESCE_MS, type Coalescer } from "./coalesce.ts";

/** Returns `nonce` debounced by `waitMs`: bumps within the window collapse to a single update. */
export function useCoalescedNonce(nonce: number, waitMs: number = NONCE_COALESCE_MS): number {
  const [settled, setSettled] = useState(nonce);
  const latest = useRef(nonce);
  latest.current = nonce;
  const coalescer = useRef<Coalescer | null>(null);
  if (coalescer.current === null) {
    coalescer.current = makeCoalescer(() => setSettled(latest.current), waitMs);
  }
  useEffect(() => {
    coalescer.current?.bump();
  }, [nonce]);
  useEffect(() => () => coalescer.current?.cancel(), []);
  return settled;
}
