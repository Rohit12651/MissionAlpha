import { useEffect, useState } from "react";
import { runtimeToken } from "../../lib/runtimeToken";
import { runtimeUrl, type PreflightResult } from "../../lib/runtimeBase";
import { getQuota, type QuotaStatus } from "../../lib/quotaClient";
import type { BreakerSummary } from "../../lib/breakerModel";

/*
  Bottom status strip (F4) — Docker-Desktop-style footer telling the operator
  the swarm's health at a glance: runtime up? · Docker present? · quota window.
  Phase G: the approved mockup's `.strip` + `.chip` markup (ADR G-2). Polls
  GET /runtime/health (via runtimeUrl so it works dev-proxy AND packaged) and
  /runtime/quota every few seconds; Docker comes from the preflight push (prop)
  since it's a one-shot host check, not a live signal.

  a11y: the strip is an aria-live status region; each chip carries an explicit
  aria-label (the colored dot alone is never the only signal). Chips are inert
  text, not buttons — nothing here is interactive, so no focus management.
*/

const POLL_MS = 5000;

type Tone = "ok" | "warn" | "bad" | "muted";

/* Phase G (ADR G-2): the mockup's `.strip` chips verbatim — `chip <tone>` + `dot <tone>`.
   The mockup draws a neutral chip (no tone, no dot) for quota and breaker when healthy;
   the warn/bad looks are the mockup's own chip vocabulary for states it never showed. */
function Chip({ tone, dot, live, label, ariaLabel }: {
  tone: Tone | null;
  dot?: boolean;
  live?: boolean;
  label: string;
  ariaLabel: string;
}) {
  return (
    <span className={tone && tone !== "muted" ? `chip ${tone}` : "chip"} aria-label={ariaLabel}>
      {dot && <span className={`dot ${tone ?? "muted"}${live ? " live" : ""}`} />}
      {label}
    </span>
  );
}

export interface StatusStripProps {
  /** Latest preflight push from the electron bridge; undefined in dev/vite. */
  preflight?: PreflightResult;
  /**
   * P3: Deliveries awaiting a decision, pushed over SSE (never polled). Undefined
   * when the VITE_INBOX flag is off — the strip then renders exactly as before.
   */
  pendingDeliveries?: number;
  /** P3: SSE bus health. Undefined ⇒ the chip is not rendered at all. */
  liveConnected?: boolean;
  /**
   * MUNDER-ADOPTION A2: the runaway-breaker summary, folded from `breaker.state`
   * frames in App's single SSE subscription. Undefined (flag off, or no frame yet)
   * ⇒ the chip is not rendered — the strip stays exactly as before.
   */
  breaker?: BreakerSummary;
}

export function StatusStrip({ preflight, pendingDeliveries, liveConnected, breaker }: StatusStripProps) {
  const [runtimeUp, setRuntimeUp] = useState<boolean | null>(null);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const token = await runtimeToken();
        const r = await fetch(runtimeUrl("/runtime/health"), {
          headers: { "x-runtime-token": token },
          cache: "no-store",
        });
        if (!cancelled) setRuntimeUp(r.ok);
      } catch {
        if (!cancelled) setRuntimeUp(false);
      }
      try {
        const q = await getQuota();
        if (!cancelled) setQuota(q);
      } catch {
        /* leave last value */
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Runtime chip — unknown (probing) reads warn, up = ok, down = bad.
  const runtimeTone: Tone = runtimeUp == null ? "warn" : runtimeUp ? "ok" : "bad";
  const runtimeLabel = runtimeUp == null ? "runtime…" : runtimeUp ? "runtime up" : "runtime down";

  // Docker — preflight is one-shot; absent (browser/dev) is an honest unknown, never "up".
  const dockerKnown = preflight != null;
  const dockerOn = preflight?.docker === true;
  const dockerTone: Tone = !dockerKnown ? "muted" : dockerOn ? "ok" : "warn";
  const dockerLabel = !dockerKnown ? "docker —" : dockerOn ? "docker" : "docker off";
  const dockerAria = !dockerKnown
    ? "Docker status unknown"
    : dockerOn
      ? "Docker daemon reachable; sandboxed exec available"
      : "Docker daemon not reachable; chat works but sandboxed exec is disabled";

  // Quota — neutral normally, warn as it nears the cap, bad when the brake is on.
  let quotaTone: Tone | null = null;
  let quotaLabel = "quota —";
  let quotaAria = "Quota status unknown";
  if (quota) {
    const ratio = quota.max > 0 ? quota.count / quota.max : 0;
    quotaTone = quota.paused ? "bad" : ratio >= 0.8 ? "warn" : null;
    quotaLabel = `quota ${quota.count}/${quota.max}`;
    quotaAria = quota.paused
      ? `Quota brake engaged: ${quota.count} of ${quota.max} calls in window`
      : `Quota ${quota.count} of ${quota.max} calls in window`;
  }

  return (
    <footer className="strip" role="status" aria-live="polite" aria-label="System status">
      <Chip tone={runtimeTone} dot label={runtimeLabel} ariaLabel={`Agent runtime ${runtimeLabel}`} />
      <Chip tone={dockerTone} dot={dockerKnown} label={dockerLabel} ariaLabel={dockerAria} />
      <Chip tone={quotaTone} label={quotaLabel} ariaLabel={quotaAria} />
      {/* D-7 — every pending inbox item; SSE-driven, adds no poll. */}
      {pendingDeliveries !== undefined && (
        <Chip
          tone={pendingDeliveries > 0 ? "warn" : null}
          label={`inbox ${pendingDeliveries}`}
          ariaLabel={pendingDeliveries > 0 ? `${pendingDeliveries} items awaiting your decision` : "Inbox clear; nothing awaiting your decision"}
        />
      )}
      {/* D-4 — bound to the real event stream; the mockup's paused look is "live off" here. */}
      {liveConnected !== undefined && (
        <Chip
          tone={liveConnected ? "ok" : "warn"}
          dot
          live={liveConnected}
          label={liveConnected ? "live" : "live off"}
          ariaLabel={liveConnected ? "Live event stream connected" : "Live event stream offline; the app is falling back to polling"}
        />
      )}
      {breaker !== undefined && (
        <Chip
          tone={breaker.degraded === 0 ? null : breaker.worst === "stopped" ? "bad" : "warn"}
          label={breaker.degraded === 0 ? "breaker closed" : `breaker ${breaker.degraded} ${breaker.worst}`}
          ariaLabel={
            breaker.degraded === 0
              ? "Runaway breaker: all agents healthy"
              : `Runaway breaker: ${breaker.degraded} agent(s) degraded, worst level ${breaker.worst}. Constrained agents are refused new turns until they recover.`
          }
        />
      )}
      {/* The mockup's "· example data" is a mockup disclaimer; in the app it would be false. */}
      <span className="right">MissionAlpha · local swarm</span>
    </footer>
  );
}
