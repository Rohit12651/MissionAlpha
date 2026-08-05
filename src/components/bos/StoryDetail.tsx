// Story-Pipeline S6 — the Story detail overlay. Opens over the board (focus-trapped dialog, ESC
// closes, focus restored) and shows one story end to end:
//   • Spine tracker — the 8 stages as a progress spine; done checked, current highlighted, the
//     two human gates (design / ship) amber; the current node pulses while `waiting-you`
//     (reduced-motion respected). role=list with per-step aria state.
//   • Gates panel — the story's pending human gates with inline answer/approve actions
//     (StoryGates, reusing the Inbox verbs).
//   • Clarify Q&A — the requirements clarify thread (story.answers), threaded.
//   • Build panel — per-seat engine goals + tasks + loop steps (StoryBuildPanel).
//   • Timeline — the story_log transitions, each with its artifact ref.
// LIVE: re-reads on `liveNonce` (bumped by the App on every story.changed frame + SSE resync).
// All agent-authored text (idea, summaries, loop steps, refs) renders as TEXT NODES — no innerHTML.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, Check } from "lucide-react";
import {
  clarifyThread,
  getStory,
  spineFor,
  statusLabel,
  statusTone,
  stageLabel,
  whenLabel,
  type StoryDetail as StoryDetailData,
  type SpineNode,
} from "../../lib/storiesClient";
import { isGate, listInbox, type Delivery } from "../../lib/inboxClient";
import { useCoalescedNonce } from "../../lib/useCoalescedNonce";
import { StoryBuildPanel } from "./StoryBuildPanel";
import { StoryGates } from "./StoryGates";

export interface StoryDetailProps {
  storyId: string;
  onClose: () => void;
  /** Bumped on every story.changed frame + SSE resync — triggers the authoritative re-read. */
  liveNonce: number;
  /**
   * The element to restore focus to on close (the launcher card). Captured by the parent at
   * click time — BEFORE the board goes `inert` (an inert subtree blurs its focused descendant,
   * so capturing `document.activeElement` here on mount would record `<body>`, not the card).
   */
  restoreFocusTo?: HTMLElement | null;
}

/** The empty Build aggregate, shown while a story has not reached Build yet. */
const EMPTY_BUILD: StoryDetailData["build"] = { goals: [], counts: { done: 0, failed: 0, running: 0 }, total: 0 };

function SpineNodeView({ node, position, total }: { node: SpineNode; position: number; total: number }) {
  const tone = node.rejected ? "rejected" : node.isGate ? "gate" : "auto";
  const stateText =
    node.state === "done" ? "complete" : node.state === "current" ? (node.awaitingYou ? "awaiting you" : "in progress") : "not started";
  return (
    <li
      className="bos-story-spine-node"
      data-state={node.state}
      data-tone={tone}
      data-awaiting={node.awaitingYou ? "true" : undefined}
      aria-current={node.state === "current" ? "step" : undefined}
    >
      <span className="bos-story-spine-dot" aria-hidden>
        {node.state === "done" ? <Check size={12} /> : <span className="bos-story-spine-num">{position}</span>}
      </span>
      <span className="bos-story-spine-label">
        {node.label}
        {node.isGate && <span className="bos-story-spine-gate helm-mono">gate</span>}
      </span>
      {/* Screen-reader-only state so the spine is legible without the visual. */}
      <span className="sr-only">{`Stage ${position} of ${total}: ${node.label} — ${stateText}${node.isGate ? ", human gate" : ""}`}</span>
    </li>
  );
}

export function StoryDetail({ storyId, onClose, liveNonce, restoreFocusTo }: StoryDetailProps) {
  const [data, setData] = useState<StoryDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [gates, setGates] = useState<Delivery[]>([]);

  const paneRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // Latest onClose kept in a ref so the focus-trap effect (below) never lists it as a dep — a new
  // onClose identity per parent render must NOT re-run focus capture/restore. See HIGH fix.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  // The launcher to restore focus to on close, captured by the parent at click time (pre-inert).
  // A ref (initial value only) so it is pinned at mount and unaffected by later prop identity.
  const restoreTargetRef = useRef(restoreFocusTo);

  // Coalesce the live nonce: an SSE story.changed storm collapses to ONE re-read (see coalesce.ts).
  const liveTick = useCoalescedNonce(liveNonce);

  // ── authoritative read (story + log + build) ────────────────────────────────
  useEffect(() => {
    const ctrl = new AbortController();
    let live = true;
    setError(null);
    getStory(storyId, ctrl.signal)
      .then((r) => {
        if (!live) return;
        if (r && (r as { error?: string }).error) { setData(null); setError((r as { error?: string }).error ?? "not found"); }
        else { setData(r); setError(null); }
      })
      // An aborted in-flight read (cleanup) lands here with live=false → swallowed, no toast.
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : "request failed"); });
    return () => { live = false; ctrl.abort(); };
  }, [storyId, liveTick, retryNonce]);

  // ── the story's pending gate deliveries (filtered from the Inbox) ────────────
  useEffect(() => {
    const ctrl = new AbortController();
    let live = true;
    listInbox({ limit: 100 }, ctrl.signal)
      .then((r) => {
        if (!live) return;
        const mine = (r.deliveries ?? []).filter((d) => d.storyId === storyId && d.status === "pending" && isGate(d));
        setGates(mine);
      })
      .catch(() => { if (live) setGates([]); });
    return () => { live = false; ctrl.abort(); };
  }, [storyId, liveTick, retryNonce]);

  const onResolved = useCallback(() => setRetryNonce((n) => n + 1), []);

  // ── overlay a11y: focus trap + ESC + restore ────────────────────────────────
  useEffect(() => {
    // Prefer the parent-captured launcher (survives the board going inert); fall back to the
    // current activeElement for any caller that does not pass one.
    restoreRef.current = restoreTargetRef.current ?? (document.activeElement as HTMLElement | null);
    const node = paneRef.current;
    node?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onCloseRef.current(); return; }
      if (e.key !== "Tab" || !node) return;
      const f = node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      restoreRef.current?.focus?.();
    };
    // Deps are [storyId] ONLY: focus capture/restore runs on mount + story switch, never on a
    // live re-render. onClose is read through onCloseRef so its changing identity cannot re-arm
    // the trap (which would steal focus mid-typing + corrupt restoreRef). See HIGH fix.
  }, [storyId]);

  const story = data?.story ?? null;
  const spine = useMemo(() => (story ? spineFor(story) : []), [story]);
  const thread = useMemo(() => clarifyThread(story?.answers ?? null), [story?.answers]);

  return (
    <div
      className="bos-story-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={paneRef}
        tabIndex={-1}
        className="bos-story-detail"
        role="dialog"
        aria-modal="true"
        aria-label={story ? `Story: ${story.title}` : "Story detail"}
      >
        <header className="bos-story-detail-head">
          <div className="min-w-0">
            <p className="bos-deck-eyebrow helm-mono">STORY · {stageLabel(story?.stage ?? "idea").toUpperCase()}</p>
            <h2 className="bos-story-detail-title helm-display">{story?.title ?? "…"}</h2>
          </div>
          <div className="bos-story-detail-head-right">
            {story && <span className="helm-chip" data-tone={statusTone(story.status)}>{statusLabel(story.status)}</span>}
            <button type="button" className="helm-btn" data-variant="quiet" onClick={onClose} aria-label="Close story">
              <X size={14} aria-hidden /> Close
            </button>
          </div>
        </header>

        {error && !story ? (
          <p className="bos-story-note helm-mono" data-tone="red">
            story unavailable — {error}{" "}
            <button type="button" className="bos-vault-retry" onClick={() => setRetryNonce((n) => n + 1)}>Retry</button>
          </p>
        ) : !story ? (
          <p className="bos-story-note helm-mono">reading…</p>
        ) : (
          <div className="bos-story-detail-body">
            {/* ── spine tracker ── */}
            <ol
              className="bos-story-spine"
              role="list"
              aria-label={`Pipeline progress — currently ${stageLabel(story.stage)}`}
            >
              {spine.map((n, i) => (
                <SpineNodeView key={n.stage} node={n} position={i + 1} total={spine.length} />
              ))}
            </ol>

            {/* ── pending gates (answer / approve inline) ── */}
            {gates.length > 0 && (
              <section className="bos-story-section" aria-label="Pending gates">
                <h3 className="bos-story-section-h helm-eyebrow">Needs you</h3>
                <StoryGates storyId={story.id} gates={gates} onResolved={onResolved} />
              </section>
            )}

            {/* ── the idea + stage refs ── */}
            <section className="bos-story-section" aria-label="Story brief">
              <h3 className="bos-story-section-h helm-eyebrow">Brief</h3>
              <p className="bos-story-idea">{story.idea || "—"}</p>
              <div className="bos-story-refs">
                {story.spec && <span className="bos-story-ref helm-mono">requirements · {story.spec}</span>}
                {story.designRef && <span className="bos-story-ref helm-mono">design · {story.designRef}</span>}
              </div>
            </section>

            {/* ── clarify Q&A thread ── */}
            {thread.length > 0 && (
              <section className="bos-story-section" aria-label="Clarify questions">
                <h3 className="bos-story-section-h helm-eyebrow">Clarify · Q&amp;A</h3>
                <ul className="bos-story-thread">
                  {thread.map((e) => (
                    <li key={e.id} className="bos-story-qa">
                      <p className="bos-story-q"><span className="bos-story-qa-tag helm-mono" data-role="q">Q</span>{e.q}</p>
                      {e.a !== null ? (
                        <p className="bos-story-a"><span className="bos-story-qa-tag helm-mono" data-role="a">A</span>{e.a}</p>
                      ) : (
                        <p className="bos-story-a" data-open="true"><span className="bos-story-qa-tag helm-mono" data-role="open">A</span><span className="helm-mono" style={{ color: "var(--helm-amber)" }}>awaiting your answer</span></p>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* ── build panel ── */}
            <section className="bos-story-section" aria-label="Build">
              <h3 className="bos-story-section-h helm-eyebrow">Build</h3>
              <StoryBuildPanel build={data?.build ?? EMPTY_BUILD} />
            </section>

            {/* ── transition timeline ── */}
            {(data?.log?.length ?? 0) > 0 && (
              <section className="bos-story-section" aria-label="Timeline">
                <h3 className="bos-story-section-h helm-eyebrow">Timeline</h3>
                <ol className="bos-story-log">
                  {(data?.log ?? []).map((l) => (
                    <li key={l.seq} className="bos-story-log-row">
                      <span className="helm-chip" data-tone="muted">{stageLabel(l.stage)}</span>
                      <span className="bos-story-log-event helm-mono">{l.event}</span>
                      {l.ref && <span className="bos-story-log-ref helm-mono">{l.ref}</span>}
                      <span className="bos-story-log-ts helm-mono">{whenLabel(l.ts)}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
