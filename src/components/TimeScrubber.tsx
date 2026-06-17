import { useCallback, useEffect, useMemo, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Radio, Play, Pause, History } from "lucide-react";
import type { FeedEvent, Heartbeat } from "../data/types";
import { tok } from "../lib/agentMeta";
import { timeBounds, timelineMarkers, type MarkerKind } from "../lib/replay";
import { useTick } from "../lib/ticker";

// A3 — Time Scrubber. A docked horizontal timeline under the MissionStrip. Drag
// the playhead to rewind the board to any past moment; markers annotate
// scheduler ticks (muted), stall pages (red) and awaiting-you moments (gold).
// LIVE returns to now. Emil motion: ≤300ms ease-out, GPU transform/opacity only,
// reduced-motion disables auto-play but keeps manual scrub. OKLCH tokens only.

const EASE = [0.22, 1, 0.36, 1] as const;

const MARKER_TOKEN: Record<MarkerKind, string> = {
  tick: "muted",
  stall: "stale-red",
  await: "ceo-gold",
  strategy: "done-green",
};

// Auto-play: advance 1 timeline-minute per 0.5s of real time.
const PLAY_STEP_MS = 60_000;
const PLAY_INTERVAL_MS = 500;
// Keyboard step = 1% of the span; large step (Shift) = 10%.
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatAgo(deltaMs: number): string {
  const sec = Math.max(0, Math.floor(deltaMs / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function TimeScrubber({
  heartbeats,
  feed,
  replayMs,
  playing,
  onScrub,
  onLive,
  onTogglePlay,
}: {
  heartbeats: Heartbeat[];
  feed: FeedEvent[];
  /** null = LIVE; a number = pinned past moment. */
  replayMs: number | null;
  playing: boolean;
  onScrub: (ms: number) => void;
  onLive: () => void;
  onTogglePlay: () => void;
}) {
  const reduce = useReducedMotion();
  // endMs tracks "now" via the shared 1s tick so the bar keeps growing while
  // replaying — but the playhead stays pinned at replayMs until LIVE.
  const nowMs = useTick();
  const bounds = useMemo(
    () => timeBounds(heartbeats, feed, nowMs),
    [heartbeats, feed, nowMs],
  );
  const markers = useMemo(
    () => timelineMarkers(heartbeats, feed),
    [heartbeats, feed],
  );
  const span = Math.max(1, bounds.endMs - bounds.startMs);

  const live = replayMs === null;
  // The actual position rendered: now when live, else the pinned moment (clamped
  // into bounds in case history scrolled the start forward).
  const posMs = live ? bounds.endMs : clamp(replayMs, bounds.startMs, bounds.endMs);
  const pct = ((posMs - bounds.startMs) / span) * 100;

  const trackRef = useRef<HTMLDivElement>(null);

  // ── Auto-play loop (disabled under reduced-motion) ────────────────────────
  useEffect(() => {
    if (!playing || live || reduce) return;
    const id = setInterval(() => {
      onScrub(replayMs! + PLAY_STEP_MS);
    }, PLAY_INTERVAL_MS);
    return () => clearInterval(id);
  }, [playing, live, reduce, replayMs, onScrub]);

  // When auto-play reaches the live edge, snap to LIVE + stop.
  useEffect(() => {
    if (playing && !live && replayMs! >= bounds.endMs) onLive();
  }, [playing, live, replayMs, bounds.endMs, onLive]);

  const scrubToClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      onScrub(Math.round(bounds.startMs + ratio * span));
    },
    [bounds.startMs, span, onScrub],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubToClientX(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (e.buttons === 0) return; // only while dragging
    scrubToClientX(e.clientX);
  };

  const step = span / 100;
  const onKeyDown = (e: React.KeyboardEvent) => {
    let next: number | null = null;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowDown":
        next = posMs - (e.shiftKey ? step * 10 : step);
        break;
      case "ArrowRight":
      case "ArrowUp":
        next = posMs + (e.shiftKey ? step * 10 : step);
        break;
      case "Home":
        next = bounds.startMs;
        break;
      case "End":
        onLive();
        e.preventDefault();
        return;
      default:
        return;
    }
    e.preventDefault();
    const clamped = clamp(next, bounds.startMs, bounds.endMs);
    if (clamped >= bounds.endMs) onLive();
    else onScrub(Math.round(clamped));
  };

  const readout = live
    ? "LIVE"
    : `REPLAY · ${formatAgo(bounds.endMs - posMs)} (${formatClock(posMs)})`;

  return (
    <section
      aria-label="Time scrubber — replay the swarm"
      className="sticky top-2 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-panel border border-border bg-panel/70 px-3 py-2.5 backdrop-blur-md sm:px-4"
    >
      {/* LIVE / REPLAY control */}
      <button
        type="button"
        onClick={onLive}
        aria-pressed={live}
        className="inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold outline-none transition-colors focus-visible:ring-2"
        style={{
          borderColor: live ? tok("done-green") : tok("border"),
          color: live ? tok("done-green") : tok("muted"),
          backgroundColor: live
            ? `color-mix(in oklch, ${tok("done-green")} 12%, transparent)`
            : "transparent",
          boxShadow: live ? `0 0 12px -3px ${tok("done-green")}` : undefined,
        }}
        title={live ? "Showing the swarm live" : "Return to live"}
      >
        {live ? (
          <Radio size={13} aria-hidden />
        ) : (
          <History size={13} aria-hidden />
        )}
        {live ? "LIVE" : "Return to LIVE"}
      </button>

      {/* Play / pause (manual scrub still works; reduced-motion hides this) */}
      {!reduce && (
        <button
          type="button"
          onClick={onTogglePlay}
          disabled={live}
          aria-label={playing ? "Pause replay" : "Play replay"}
          className="inline-flex shrink-0 items-center justify-center rounded-full border border-border p-1.5 text-muted outline-none transition-colors hover:text-text focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40"
          title={live ? "Scrub into the past to play back" : playing ? "Pause" : "Play"}
        >
          {playing ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}
        </button>
      )}

      {/* Readout */}
      <span
        className="shrink-0 font-mono text-xs tabular-nums"
        style={{ color: live ? tok("done-green") : tok("ceo-gold") }}
        role="status"
        aria-live="polite"
      >
        {readout}
      </span>

      {/* Timeline track + slider */}
      <div className="flex min-w-[220px] flex-1 items-center gap-3">
        <span className="hidden font-mono text-[10px] text-muted sm:inline">
          {formatClock(bounds.startMs)}
        </span>
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="Replay position"
          aria-valuemin={bounds.startMs}
          aria-valuemax={bounds.endMs}
          aria-valuenow={Math.round(posMs)}
          aria-valuetext={readout}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          className="relative h-9 flex-1 cursor-pointer touch-none select-none rounded-md outline-none focus-visible:ring-2"
        >
          {/* baseline track */}
          <span
            className="pointer-events-none absolute left-0 right-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full"
            style={{ backgroundColor: tok("border") }}
            aria-hidden
          />
          {/* elapsed fill */}
          <span
            className="pointer-events-none absolute left-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full"
            style={{
              width: `${pct}%`,
              backgroundColor: live ? tok("done-green") : tok("ceo-gold"),
              opacity: 0.85,
            }}
            aria-hidden
          />
          {/* markers */}
          {markers.map((m, i) => {
            const mPct = clamp(((m.timeMs - bounds.startMs) / span) * 100, 0, 100);
            const c = tok(MARKER_TOKEN[m.kind]);
            return (
              <span
                key={`${m.timeMs}-${m.kind}-${i}`}
                className="pointer-events-none absolute top-1/2 h-3 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{
                  left: `${mPct}%`,
                  backgroundColor: c,
                  boxShadow: m.kind === "tick" ? undefined : `0 0 5px ${c}`,
                  opacity: m.kind === "tick" ? 0.5 : 0.95,
                }}
                title={`${m.label} · ${formatClock(m.timeMs)}`}
              />
            );
          })}
          {/* playhead */}
          <motion.span
            className="pointer-events-none absolute top-1/2 h-5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              backgroundColor: live ? tok("done-green") : tok("ceo-gold"),
              boxShadow: `0 0 10px ${live ? tok("done-green") : tok("ceo-gold")}`,
            }}
            animate={{ left: `${pct}%` }}
            transition={
              reduce ? { duration: 0 } : { duration: 0.18, ease: EASE }
            }
            aria-hidden
          />
        </div>
        <span className="hidden font-mono text-[10px] text-muted sm:inline">now</span>
      </div>
    </section>
  );
}
