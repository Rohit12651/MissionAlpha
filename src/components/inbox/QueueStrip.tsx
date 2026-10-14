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

  // Phase G: APP-ONLY (the mockup's Queue card counts inbox items; this one is the agent
  // runtime's task queue), restyled in the mockup's `.card` / `.chip` vocabulary.
  const tone = (t: "ok" | "warn" | "bad" | null) => (t ? `chip ${t}` : "chip");
  return (
    <section className="card qstrip" data-app-only="work-queue" aria-label="Agent work queue" style={{ marginBottom: 16 }}>
      <div className="card-h" style={{ marginBottom: 8 }}>
        <span className="sub">Work queue</span>
        <span className="pills" role="status" aria-live="polite">
          {idle ? (
            <span className="chip">idle · nothing queued</span>
          ) : (
            <>
              <span className={tone(counts.running ? "ok" : null)}>{`${counts.running} running`}</span>
              <span className={tone(counts.queued ? "warn" : null)}>{`${counts.queued} queued`}</span>
              {counts.retrying > 0 && <span className="chip warn">{`${counts.retrying} retrying`}</span>}
              {counts.failed > 0 && <span className="chip bad">{`${counts.failed} failed`}</span>}
            </>
          )}
          {maxInflight != null && (
            <span className="chip" title="Shared concurrency budget across chat, run and the autonomous engine">
              {`${inflight ?? 0}/${maxInflight} slots`}
            </span>
          )}
        </span>
      </div>

      {chips.length > 0 && (
        <ul className="pills" aria-label="Per-agent queue depth" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {chips.map((c) => (
            <li key={c.agentId} className={tone(c.failed ? "bad" : c.running ? "ok" : "warn")}>
              {`${c.agentId} · ${[c.running ? `${c.running} run` : "", c.queued ? `${c.queued} wait` : "", c.retrying ? `${c.retrying} retry` : "", c.failed ? `${c.failed} fail` : ""].filter(Boolean).join(" ")}`}
            </li>
          ))}
        </ul>
      )}

      {/* WHY the work is failing, not merely how much of it: the engine's own sentence. */}
      {reasons.length > 0 && (
        <ul className="list" aria-label="Why work is failing" style={{ marginTop: 8, gap: 4 }}>
          {reasons.map((r) => (
            <li key={`${r.kind} ${r.detail ?? ""}`} className="feed-row" style={{ gridTemplateColumns: "auto minmax(0,1fr)" }}>
              <span className="chip bad">{`${r.kind}${r.count > 1 ? ` ×${r.count}` : ""}`}</span>
              {r.detail && <span className="mono" style={{ overflowWrap: "anywhere" }} title={r.detail}>{r.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
