import { useEffect, useMemo, useRef, useState } from "react";
import { fetchQueueRuns } from "../../lib/inboxClient";
import {
  EMPTY_QUEUE,
  agentChips,
  applyQueueEvent,
  failureReasons,
  fromSnapshot,
  queueCounts,
  type QueueState,
} from "../../lib/queueModel";
import { useCoalescedNonce } from "../../lib/useCoalescedNonce";
import type { RuntimeEvent } from "../../lib/useRuntimeEvents";

/*
  The live queue strip (P4). Autonomy made visible: what the swarm is chewing on
  right now, with no refresh and no polling.

  DATA FLOW (program plan §2 — push first):
   · mount / SSE resync                 → GET /runtime/engine/runs  (authoritative)
   · task.queued|started|retried|failed → pure reducer (instant, optimistic)
   · any of the above + delivery.*      → 400ms TRAILING debounce → authoritative re-read

  Why the re-read exists: the v1 event catalog is CLOSED and has no success-terminal
  name, so a task reaching DONE/HELD leaves the queue without announcing it. The
  debounce is trailing, so a burst of transitions costs exactly one request and it
  lands after the transitions settle. No timer runs while the bus is quiet.

  All arithmetic lives in src/lib/queueModel.ts (pure, unit-tested) — this component
  only renders it.
*/

const RETRUTH_DEBOUNCE_MS = 400;

export interface QueueStripProps {
  /** Newest catalog event from the app-wide SSE subscription. */
  lastEvent: RuntimeEvent | null;
  /** Bumped on every successful (re)connect — forces an authoritative re-read. */
  resyncNonce: number;
  /**
   * D7 — monotonic count of queue-moving frames, bumped in App through a state UPDATER.
   *
   * `lastEvent` below is a single value slot and SSE delivers bursts inside one chunk, so
   * React's batching kept only the burst's LAST frame — routinely `usage.tick`, which this
   * component ignores. Both the optimistic delta and the trailing re-truth hung off that
   * dropped value, which is why the live strip read "0 running" beside a claimed task and
   * fetched `/runtime/engine/runs` twice in twenty minutes of churn. A counter cannot be
   * batched away, so the authoritative re-read now hangs off THIS instead.
   */
  liveNonce?: number;
}

export function QueueStrip({ lastEvent, resyncNonce, liveNonce = 0 }: QueueStripProps) {
  const [state, setState] = useState<QueueState>(EMPTY_QUEUE);
  const [maxInflight, setMaxInflight] = useState<number | null>(null);
  const [inflight, setInflight] = useState<number | null>(null);
  const [reachable, setReachable] = useState(true);
  const [retruth, setRetruth] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Coalesced so a burst of frames costs ONE authoritative read, not one per frame.
  const settledLive = useCoalescedNonce(liveNonce, RETRUTH_DEBOUNCE_MS);

  // ── authoritative read ────────────────────────────────────────────────────
  useEffect(() => {
    let live = true;
    fetchQueueRuns()
      .then((r) => {
        if (!live) return;
        setState(fromSnapshot(r.tasks ?? []));
        setMaxInflight(typeof r.maxInflight === "number" ? r.maxInflight : null);
        setInflight(typeof r.inflight === "number" ? r.inflight : null);
        setReachable(true);
      })
      .catch(() => {
        if (live) setReachable(false);
      });
    return () => { live = false; };
  }, [resyncNonce, retruth, settledLive]);

  // ── SSE delta + trailing re-truth ─────────────────────────────────────────
  useEffect(() => {
    if (!lastEvent) return;
    setState((prev) => applyQueueEvent(prev, lastEvent));
    const relevant =
      lastEvent.name.startsWith("task.") ||
      lastEvent.name === "delivery.created" ||
      lastEvent.name === "delivery.decided";
    if (!relevant) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setRetruth((n) => n + 1);
    }, RETRUTH_DEBOUNCE_MS);
  }, [lastEvent]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const counts = useMemo(() => queueCounts(state), [state]);
  const chips = useMemo(() => agentChips(state), [state]);
  const reasons = useMemo(() => failureReasons(state), [state]);

  // The runtime answers the Inbox but not the engine route (older build, or the
  // route is gated off): say nothing rather than render a fabricated empty queue.
  if (!reachable) return null;

  const idle = counts.total === 0;

  return (
    <section className="helm-pane mb-4 flex flex-col gap-2.5 p-3" aria-label="Agent work queue">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="helm-eyebrow">Queue</div>
        <div
          className="helm-mono flex flex-wrap items-center gap-1.5 text-[11px]"
          role="status"
          aria-live="polite"
        >
          {idle ? (
            <span className="helm-chip" data-tone="muted">idle — nothing queued</span>
          ) : (
            <>
              <span className="helm-chip" data-tone={counts.running ? "green" : "muted"}>
                {counts.running} running
              </span>
              <span className="helm-chip" data-tone={counts.queued ? "amber" : "muted"}>
                {counts.queued} queued
              </span>
              {counts.retrying > 0 && (
                <span className="helm-chip" data-tone="amber">{counts.retrying} retrying</span>
              )}
              {counts.failed > 0 && (
                <span className="helm-chip" data-tone="red">{counts.failed} failed</span>
              )}
            </>
          )}
          {maxInflight != null && (
            <span
              className="helm-chip"
              data-tone="muted"
              title="Shared concurrency budget across chat, run and the autonomous engine"
            >
              {inflight ?? 0}/{maxInflight} slots
            </span>
          )}
        </div>
      </div>

      {chips.length > 0 && (
        <ul className="flex list-none flex-wrap gap-1.5" aria-label="Per-agent queue depth">
          {chips.map((c) => (
            <li
              key={c.agentId}
              className="helm-chip helm-mono text-[11px]"
              data-tone={c.failed ? "red" : c.running ? "green" : "amber"}
            >
              {c.agentId}
              <span style={{ color: "var(--helm-paper-faint)" }}>
                {" · "}
                {c.running ? `${c.running} run ` : ""}
                {c.queued ? `${c.queued} wait ` : ""}
                {c.retrying ? `${c.retrying} retry ` : ""}
                {c.failed ? `${c.failed} fail` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* WHY the work is failing, not merely how much of it. The engine composes a precise
          sentence for a scope refusal — naming the seat and the paths it may not write —
          and every layer between it and here used to keep only the error CLASS, so the
          operator read `empty-diff` and had to open Stories to learn anything. */}
      {reasons.length > 0 && (
        <ul className="flex list-none flex-col gap-1" aria-label="Why work is failing">
          {reasons.map((r) => (
            <li
              key={`${r.kind} ${r.detail ?? ""}`}
              className="helm-mono flex items-start gap-1.5 text-[11px] leading-snug"
            >
              <span className="helm-chip shrink-0" data-tone="red">
                {r.kind}
                {r.count > 1 ? ` ×${r.count}` : ""}
              </span>
              {r.detail && (
                // Plain text child. `detail` is scrubbed server-side (twice) but is agent-
                // and repo-derived, so it is never interpolated as markup. Clamped to two
                // lines with the full text on hover — truncating in the model would
                // destroy the path the operator actually needs.
                <span
                  className="line-clamp-2 break-all"
                  style={{ color: "var(--helm-paper-faint)" }}
                  title={r.detail}
                >
                  {r.detail}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
