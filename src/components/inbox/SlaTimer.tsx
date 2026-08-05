import { useEffect, useState } from "react";
import { formatSla } from "../../lib/inboxClient";

/*
  P6 / ADR-053 — the live SLA countdown.

  Time discipline (program plan point 9): rendered ENTIRELY from the absolute UTC
  deadline the runtime stamped at mint, so there is no server tick and no drift — the
  component just re-reads the local clock once a second. Turns red under one hour;
  shows "SLA expired" past the deadline.

  Motion (emil): the sub-second urgency pulse is decoration and is disabled under
  `prefers-reduced-motion`. The once-a-second countdown update is information, not
  motion, so it keeps ticking either way.
*/

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

export function SlaTimer({
  deadline,
  slaState = null,
  className,
}: {
  deadline: string | null;
  slaState?: "halflife" | "expired" | null;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (!deadline) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [deadline]);

  const view = formatSla(deadline, now);
  if (!view) return null;
  const escalated = view.expired || slaState === "expired";

  return (
    <span
      className={`helm-mono helm-sla${view.hot && !reduced ? " helm-sla-pulse" : ""}${className ? ` ${className}` : ""}`}
      data-hot={view.hot ? "true" : undefined}
      data-expired={escalated ? "true" : undefined}
      role="timer"
      aria-live={view.hot ? "polite" : "off"}
      aria-label={view.expired ? "SLA expired" : `Time remaining, ${view.label.replace("SLA ", "")}`}
      style={{ color: view.hot ? "var(--helm-red)" : "var(--helm-amber)", fontWeight: view.hot ? 600 : 400 }}
    >
      {view.label}
    </span>
  );
}
