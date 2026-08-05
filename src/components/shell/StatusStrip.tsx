import { useEffect, useState } from "react";
import { runtimeToken } from "../../lib/runtimeToken";
import { runtimeUrl, type PreflightResult } from "../../lib/runtimeBase";
import { getQuota, type QuotaStatus } from "../../lib/quotaClient";
import { tok } from "../../lib/agentMeta";

/*
  Bottom status strip (F4) — Docker-Desktop-style footer telling the operator
  the swarm's health at a glance: runtime up? · Docker present? · quota window.
  Reuses the mockup `.ma-chip` pill + the green/amber/red status tokens. Polls
  GET /runtime/health (via runtimeUrl so it works dev-proxy AND packaged) and
  /runtime/quota every few seconds; Docker comes from the preflight push (prop)
  since it's a one-shot host check, not a live signal.

  a11y: the strip is an aria-live status region; each chip carries an explicit
  aria-label (the colored dot alone is never the only signal). Chips are inert
  text, not buttons — nothing here is interactive, so no focus management.
*/

const POLL_MS = 5000;

type Tone = "done-green" | "blocked-amber" | "stale-red" | "muted";

function Chip({
  tone,
  label,
  ariaLabel,
  mono,
}: {
  tone: Tone;
  label: string;
  ariaLabel: string;
  mono?: boolean;
}) {
  const c = tok(tone);
  return (
    <span
      className={`ma-chip${mono ? " font-mono" : ""}`}
      style={{
        color: c,
        borderColor: `color-mix(in oklch, ${c} 30%, var(--c-border))`,
      }}
      aria-label={ariaLabel}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: c }}
        aria-hidden
      />
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
}

export function StatusStrip({ preflight, pendingDeliveries, liveConnected }: StatusStripProps) {
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

  // Runtime chip — unknown (probing) reads amber, up = green, down = red.
  const runtimeTone: Tone =
    runtimeUp == null ? "blocked-amber" : runtimeUp ? "done-green" : "stale-red";
  const runtimeLabel =
    runtimeUp == null ? "runtime…" : runtimeUp ? "runtime up" : "runtime down";

  // Docker — preflight is one-shot; absent (dev) reads as a neutral unknown.
  const dockerKnown = preflight != null;
  const dockerOn = preflight?.docker === true;
  const dockerTone: Tone = !dockerKnown
    ? "muted"
    : dockerOn
      ? "done-green"
      : "blocked-amber";
  const dockerLabel = !dockerKnown
    ? "docker —"
    : dockerOn
      ? "docker ready"
      : "docker off";
  const dockerAria = !dockerKnown
    ? "Docker status unknown"
    : dockerOn
      ? "Docker daemon reachable; sandboxed exec available"
      : "Docker daemon not reachable; chat works but sandboxed exec is disabled";

  // Quota — green normally, amber as it nears the cap, red when the brake is on.
  let quotaTone: Tone = "muted";
  let quotaLabel = "quota —";
  let quotaAria = "Quota status unknown";
  if (quota) {
    const ratio = quota.max > 0 ? quota.count / quota.max : 0;
    quotaTone = quota.paused ? "stale-red" : ratio >= 0.8 ? "blocked-amber" : "done-green";
    quotaLabel = `quota ${quota.count}/${quota.max}`;
    quotaAria = quota.paused
      ? `Quota brake engaged: ${quota.count} of ${quota.max} calls in window`
      : `Quota ${quota.count} of ${quota.max} calls in window`;
  }

  return (
    <footer
      className="relative z-20 flex shrink-0 items-center gap-2 border-t border-border px-4 text-muted"
      style={{ height: "var(--statusbar-h)" }}
      role="status"
      aria-live="polite"
      aria-label="System status"
    >
      <Chip tone={runtimeTone} label={runtimeLabel} ariaLabel={`Agent runtime ${runtimeLabel}`} />
      <Chip tone={dockerTone} label={dockerLabel} ariaLabel={dockerAria} />
      <Chip tone={quotaTone} label={quotaLabel} ariaLabel={quotaAria} mono />
      {/* P3 — Inbox pressure + bus health. Both are SSE-driven; neither adds a poll. */}
      {pendingDeliveries !== undefined && (
        <Chip
          tone={pendingDeliveries > 0 ? "blocked-amber" : "done-green"}
          label={`inbox ${pendingDeliveries}`}
          ariaLabel={
            pendingDeliveries > 0
              ? `${pendingDeliveries} deliveries awaiting your decision`
              : "Inbox clear; nothing awaiting your decision"
          }
          mono
        />
      )}
      {liveConnected !== undefined && (
        <Chip
          tone={liveConnected ? "done-green" : "blocked-amber"}
          label={liveConnected ? "live" : "live off"}
          ariaLabel={
            liveConnected
              ? "Live event stream connected"
              : "Live event stream offline; the app is falling back to polling"
          }
        />
      )}
      <span className="ml-auto hidden text-[10px] tracking-wide opacity-70 sm:inline">
        MissionAlpha · local swarm
      </span>
    </footer>
  );
}
