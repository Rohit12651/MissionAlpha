import { useEffect, useRef, useState } from "react";
import { tok } from "../../lib/agentMeta";
import type { RuntimeEvent } from "../../lib/useRuntimeEvents";
import {
  getHooks,
  PERM_LABEL,
  quotaPct,
  windowLabel,
  type StationHooks,
} from "../../lib/stationClient.ts";

// CC-Primitives P5 — the Guards card. READ-ONLY on purpose: the backend exposes no
// write route for these (agent-runtime/server.mjs), because per-station disabling of
// the secret scrub, the apply-deny list or the engine's pinned mode would be a
// security regression, not a feature. This card only tells the truth about what the
// station is actually running under.

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <li className="flex items-baseline gap-2 py-0.5 font-mono text-[11px]">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 flex-1 truncate text-right" style={{ color: tone ? tok(tone) : tok("text") }} title={value}>
        {value}
      </span>
    </li>
  );
}

/** A slim fill bar reusing the existing escalating green → amber → red tokens. */
function QuotaMeter({ used, max, windowMs }: { used: number; max: number; windowMs: number }) {
  const pct = quotaPct(used, max);
  if (pct === null) {
    // Unknown is rendered as unknown — a fabricated 0% would read as "plenty left".
    return <Row label="quota" value="—" tone="muted" />;
  }
  const tone = pct < 0.6 ? "done-green" : pct < 0.85 ? "blocked-amber" : "stale-red";
  const ac = tok(tone);
  return (
    <li className="flex items-center gap-2 py-0.5 font-mono text-[11px]">
      <span className="shrink-0 text-muted">quota</span>
      <div className="ml-auto h-1.5 w-16 shrink-0 overflow-hidden rounded-full" style={{ backgroundColor: tok("bg") }} aria-hidden>
        {/* ui-audit LOW-4: fill the track and scaleX — compositor-friendly, not the
            layout-bound `width`. Reduced-motion is caught by the global CSS net. */}
        <div className="h-full w-full origin-left rounded-full" style={{ transform: `scaleX(${pct})`, backgroundColor: ac, transition: "transform 240ms ease-out" }} />
      </div>
      <span className="shrink-0 tabular-nums" style={{ color: ac }} aria-label={`${used} of ${max} calls used in the last ${windowLabel(windowMs)}`}>
        {used}/{max}
      </span>
      <span className="shrink-0 text-[10px] text-muted">/ {windowLabel(windowMs)}</span>
    </li>
  );
}

export function HooksCard({ agentId, lastEvent }: { agentId: string; lastEvent?: RuntimeEvent | null }) {
  const [hooks, setHooks] = useState<StationHooks | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const seenRef = useRef<RuntimeEvent | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    getHooks(agentId)
      .then((r) => {
        if (!live) return;
        setHooks(r?.hooks ?? null);
        setError(r?.hooks ? null : "could not read the guard state");
        setLoading(false);
      })
      .catch(() => {
        if (!live) return;
        setHooks(null);
        setError("could not read the guard state");
        setLoading(false);
      });
    return () => { live = false; };
  }, [agentId, nonce]);

  // The effective mode reported here moves when the override does — re-read on frame
  // rather than leaving a stale guard readout on screen.
  useEffect(() => {
    if (!lastEvent || lastEvent.name !== "station.perm.changed") return;
    if (seenRef.current === lastEvent) return;
    seenRef.current = lastEvent;
    if ((lastEvent.data as { agentId?: unknown }).agentId !== agentId) return;
    setNonce((n) => n + 1);
  }, [lastEvent, agentId]);

  if (loading) return <p className="text-[12px] text-muted">reading guards…</p>;
  if (!hooks) {
    return (
      <p className="text-[12px]" style={{ color: tok("stale-red") }} role="alert">
        {error ?? "could not read the guard state"}
      </p>
    );
  }

  const scrub = hooks.secretScrub;
  return (
    <ul className="flex flex-col">
      <Row
        label="perm effective"
        value={PERM_LABEL[hooks.permMode.effective] ?? String(hooks.permMode.effective)}
        tone={hooks.permMode.effective === "bypassPermissions" ? "blocked-amber" : "accent-cyan"}
      />
      <Row label="engine pinned" value={String(hooks.permMode.enginePinned)} tone="muted" />
      <Row label="tools mode" value={String(hooks.toolsMode)} />
      <Row
        label="secret scrub"
        value={scrub.active ? `${scrub.layers.length} layers · ${scrub.layers.join(", ")}` : "off"}
        tone={scrub.active ? "done-green" : "stale-red"}
      />
      <Row
        label="apply deny"
        value={hooks.applyDeny.active ? hooks.applyDeny.pattern : "off"}
        tone={hooks.applyDeny.active ? "done-green" : "stale-red"}
      />
      <Row label="config guard" value={hooks.configGuard.active ? "on" : "off"} tone={hooks.configGuard.active ? "done-green" : "stale-red"} />
      <QuotaMeter used={hooks.quota.used} max={hooks.quota.max} windowMs={hooks.quota.windowMs} />
      {error && (
        <li className="pt-1 text-[11px]" style={{ color: tok("stale-red") }} role="alert">{error}</li>
      )}
    </ul>
  );
}
