// B1 — the topbar every BOS page wears. Phase G (ADR G-2): the approved mockup's `.ptop`
// verbatim — eyebrow, display H1, the script tagline, then status chips and the clock.
//
// The clock is INFORMATION, not motion: it re-renders one text node once a second and
// animates nothing, so no reduced-motion or ≤240ms rule applies to it. The interval is
// only created when `clock` is on, and is always cleared on unmount.

import { memo, useEffect, useState, type ReactNode } from "react";

export interface BosTopbarProps {
  /** Context line above the title; `.eyebrow` uppercases it (mockup: "<Page> · <scope>"). */
  eyebrow: string;
  /** The page's H1 — the ONE h1 on the page. */
  title: string;
  /** The mockup's handwritten line under the title. */
  tagline?: string;
  /** id for the h1, so the page's <section aria-labelledby> can name itself. */
  headingId?: string;
  /** Right-hand status chips (`.chip` spans). */
  chips?: ReactNode;
  /** Show the ticking wall clock beside the chips. */
  clock?: boolean;
}

const two = (n: number) => String(n).padStart(2, "0");
const timeOf = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;

function Clock() {
  const [now, setNow] = useState(() => timeOf(new Date()));
  useEffect(() => {
    const id = setInterval(() => setNow(timeOf(new Date())), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="clock" title="Local time">{now}</span>;
}

export const BosTopbar = memo(function BosTopbar({ eyebrow, title, tagline, headingId, chips, clock = false }: BosTopbarProps) {
  return (
    <div className="ptop">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1 id={headingId}>{title}</h1>
        {tagline && <p className="script ptag">{tagline}</p>}
      </div>
      {(chips || clock) && (
        <div className="chips">
          {chips}
          {clock && <Clock />}
        </div>
      )}
    </div>
  );
});
