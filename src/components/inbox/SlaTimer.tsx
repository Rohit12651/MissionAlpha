import { useEffect, useState } from "react";
import { slaText } from "../../lib/inboxTally";

/*
  P6 / ADR-053 — the live SLA countdown. Phase G (ADR G-2): the mockup's `.sla` span —
  "SLA mm:ss" in total minutes, "SLA due" once past, `.hot` when the caller says so (the
  list marks under 20 minutes). Rendered ENTIRELY from the absolute UTC deadline the
  runtime stamped at mint, re-reading the local clock once a second: no server tick, no
  drift. The once-a-second update is information, not motion.
*/
export const HOT_MS = 20 * 60_000;

export function SlaTimer({ deadline, hotUnderMs }: { deadline: string | null; hotUnderMs?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [deadline]);
  const text = deadline ? slaText(deadline, now) : null;
  if (!deadline || !text) return null;
  const hot = hotUnderMs !== undefined && Date.parse(deadline) - now < hotUnderMs;
  return (
    <span className={hot ? "sla hot" : "sla"} role="timer" aria-label={text === "SLA due" ? "SLA due" : `Time remaining ${text.replace("SLA ", "")}`}>
      {text}
    </span>
  );
}
