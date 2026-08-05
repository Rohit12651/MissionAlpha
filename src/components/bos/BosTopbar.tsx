// B1 — the topbar every BOS page wears: eyebrow over H1 on the left, status chips and
// an optional live clock on the right (master spec §2).
//
// The clock is INFORMATION, not motion: it re-renders one text node once a second and
// animates nothing, so no reduced-motion or ≤240ms rule applies to it. The interval is
// only created when `clock` is on, and is always cleared on unmount.

import { memo, useEffect, useState, type ReactNode } from "react";

export interface BosTopbarProps {
  /** Mono uppercase context line, e.g. "AGENT NETWORK · WAAHYU". */
  eyebrow: string;
  /** The page's H1 — the ONE h1 on the page. */
  title: string;
  /** Right-hand status chips (already-styled nodes, e.g. .helm-chip spans). */
  chips?: ReactNode;
  /** Show the ticking wall clock beside the chips. */
  clock?: boolean;
}

const timeOf = (d: Date) =>
  d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function Clock() {
  const [now, setNow] = useState(() => timeOf(new Date()));
  useEffect(() => {
    const id = setInterval(() => setNow(timeOf(new Date())), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="bos-deck-clock helm-mono" title="Local time">
      {now}
    </span>
  );
}

export const BosTopbar = memo(function BosTopbar({ eyebrow, title, chips, clock = false }: BosTopbarProps) {
  return (
    <header className="bos-deck-topbar">
      <div className="min-w-0">
        <p className="bos-deck-eyebrow helm-mono">{eyebrow}</p>
        <h1 className="bos-deck-h1">{title}</h1>
      </div>
      <div className="bos-deck-topbar-right">
        {chips}
        {clock && <Clock />}
      </div>
    </header>
  );
});
