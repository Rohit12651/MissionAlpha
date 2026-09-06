// Story-Pipeline S6 — the Stories page (nav id `stories`). The primary pipeline surface: the SE
// team's SDLC as a kanban by stage. Eight columns (idea → accept), each story a card in its
// stage column with a status chip; the two human-gate columns (Design / Ship) read amber. A
// "New story" form mints a story at the idea stage; clicking a card opens the full StoryDetail.
//
// LAZY BY CONSTRUCTION: App imports this with React.lazy, so neither it nor StoryDetail /
// StoryBuildPanel / StoryGates is in the main index chunk.
//
// HONEST BY CONSTRUCTION: the board renders `{ stories }` from GET /runtime/stories — never a
// fabricated list. Empty pipeline → an honest empty note. LIVE: `liveNonce` (bumped by the App
// on every story.changed frame + SSE resync) drives the authoritative re-read; no polling.

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import {
  columns,
  createStory,
  listStories,
  openQuestionCount,
  statusLabel,
  statusTone,
  whenLabel,
  type Story,
} from "../../lib/storiesClient";
import { useCoalescedNonce } from "../../lib/useCoalescedNonce";
import { BosTopbar } from "./BosTopbar";
import { JobBoard } from "../board/JobBoard";
import type { RuntimeEvent } from "../../lib/useRuntimeEvents";
import { StoryDetail } from "./StoryDetail";

export interface StoriesPageProps {
  /** The venture scope from the sidebar switcher; null = all ventures. Stories are pipeline-wide
   *  (the runtime does not scope the list by venture), so this drives the eyebrow label only. */
  venture: string | null;
  /** Bumped on every story.changed frame + SSE resync — triggers the authoritative re-read. */
  liveNonce: number;
  /** 12.2 — bumped on every job.changed frame + SSE resync. Separate from `liveNonce` on
   *  purpose: a story frame must not re-read the job board, and vice versa. */
  jobNonce?: number;
  /** 12.2 — forwarded to the board's RosterStrip, which reacts to `roster.changed` (a hire). */
  lastEvent?: RuntimeEvent | null;
}

// Memoized so a single story's frame (one changed card) does not re-render every other card in
// the board. `onOpen` is the stable `setOpenId` setter, so the default shallow compare holds.
const StoryCard = memo(function StoryCard({ story, onOpen }: { story: Story; onOpen: (id: string) => void }) {
  const openQs = openQuestionCount(story.answers);
  return (
    <button type="button" className="bos-story-card" data-status={story.status} onClick={() => onOpen(story.id)}>
      <span className="bos-story-card-title helm-display">{story.title}</span>
      <span className="bos-story-card-foot">
        <span className="helm-chip" data-tone={statusTone(story.status)}>{statusLabel(story.status)}</span>
        {openQs > 0 && <span className="helm-chip" data-tone="amber">{openQs} question{openQs === 1 ? "" : "s"}</span>}
        <span className="bos-story-card-when helm-mono">{whenLabel(story.updatedAt)}</span>
      </span>
    </button>
  );
});

function NewStoryForm({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On success onCreated unmounts this form; guard the trailing setState against that unmount.
  const liveRef = useRef(true);
  useEffect(() => () => { liveRef.current = false; }, []);

  const submit = useCallback(async () => {
    const t = title.trim();
    const i = idea.trim();
    if (!t || !i) { setError("A title and an idea are both required."); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await createStory(t, i);
      if (r.error || !r.story) { setError(r.error || "could not create the story"); return; }
      onCreated(r.story.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      if (liveRef.current) setBusy(false);
    }
  }, [title, idea, onCreated]);

  return (
    <div className="bos-story-newform" role="group" aria-label="New story">
      <label className="bos-story-gate-field">
        <span className="helm-eyebrow">Title</span>
        <input
          className="helm-input"
          value={title}
          disabled={busy}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What is the story?"
          aria-label="Story title"
        />
      </label>
      <label className="bos-story-gate-field">
        <span className="helm-eyebrow">Idea</span>
        <textarea
          className="helm-input"
          rows={3}
          value={idea}
          disabled={busy}
          maxLength={10000}
          onChange={(e) => setIdea(e.target.value)}
          placeholder="Describe the change the team should build — requirements will be clarified from here."
          aria-label="Story idea"
        />
      </label>
      {error && <div className="helm-note" data-tone="red" role="alert">{error}</div>}
      <div className="bos-story-gate-actions">
        <button
          type="button"
          className="helm-btn"
          data-variant="approve"
          data-busy={busy ? "true" : undefined}
          disabled={busy || !title.trim() || !idea.trim()}
          onClick={() => void submit()}
        >
          {busy ? "Creating…" : "Create story"}
        </button>
        <button type="button" className="helm-btn" data-variant="quiet" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function StoriesPage({ venture, liveNonce, jobNonce = 0, lastEvent = null }: StoriesPageProps) {
  // 12.2 — two boards, one deck. Stories are the SDLC pipeline; Jobs are what Ash creates and
  // the Manager runs. They are separate lifecycles with separate stores and separate columns,
  // so they are separate tabs rather than one merged board that would mean neither.
  const [tab, setTab] = useState<"stories" | "jobs">("stories");
  const [stories, setStories] = useState<Story[] | null>(null);
  const [error, setError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  // Coalesce the live nonce: an SSE story.changed storm collapses to ONE board re-read.
  const liveTick = useCoalescedNonce(liveNonce);

  useEffect(() => {
    const ctrl = new AbortController();
    let live = true;
    setError(false);
    listStories({}, ctrl.signal)
      // An aborted in-flight read (cleanup) rejects with live=false → swallowed, no error state.
      .then((r) => { if (live) setStories(r.stories ?? []); })
      .catch(() => { if (live) { setStories(null); setError(true); } });
    return () => { live = false; ctrl.abort(); };
  }, [liveTick, retryNonce]);

  const refetch = useCallback(() => setRetryNonce((n) => n + 1), []);
  // The launcher card, captured at click time — BEFORE the board goes inert (which would blur it).
  // StoryDetail restores focus here on close, so ESC/Close returns the user to the card they opened.
  const launcherRef = useRef<HTMLElement | null>(null);
  const openStory = useCallback((id: string) => {
    launcherRef.current = document.activeElement as HTMLElement | null;
    setOpenId(id);
  }, []);
  // Stable close handler — a fresh identity per render would re-arm StoryDetail's focus trap.
  const closeDetail = useCallback(() => setOpenId(null), []);
  const onCreated = useCallback((id: string) => {
    setFormOpen(false);
    refetch();
    setOpenId(id);
  }, [refetch]);

  const cols = columns(stories ?? []);
  const total = stories?.length ?? 0;
  const scopeLabel = (venture ?? "pipeline").toUpperCase();

  return (
    <div className="bos-deck bos-stories">
      {/* Background is inert while the dialog is open (bg is not inert under aria-modal alone).
          display:contents keeps the flex layout identical — the wrapper generates no box. */}
      <div style={{ display: "contents" }} inert={openId ? true : undefined}>
      <BosTopbar
        eyebrow={`STORIES · ${scopeLabel}`}
        title="Stories"
        chips={
          <>
            {/* A tablist, not two buttons: arrow keys and the aria roles are what make this
                usable without a mouse, and the deck is an operator surface. */}
            <span role="tablist" aria-label="Board" className="bos-job-tabs">
              {(["stories", "jobs"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  id={`bos-tab-${t}`}
                  aria-selected={tab === t}
                  aria-controls={`bos-panel-${t}`}
                  tabIndex={tab === t ? 0 : -1}
                  className="bos-job-tab"
                  onClick={() => setTab(t)}
                  onKeyDown={(e) => {
                    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                    e.preventDefault();
                    const next = tab === "stories" ? "jobs" : "stories";
                    setTab(next);
                    document.getElementById(`bos-tab-${next}`)?.focus();
                  }}
                >
                  {t === "stories" ? "Stories" : "Jobs"}
                </button>
              ))}
            </span>
            {tab === "stories" && stories !== null && (
              <span className="helm-chip" data-tone={total ? "green" : "muted"}>{total} in flight</span>
            )}
            {tab === "stories" && (
              <button
                type="button"
                className="bos-story-new"
                aria-expanded={formOpen}
                onClick={() => setFormOpen((o) => !o)}
              >
                <Plus size={13} aria-hidden /> New story
              </button>
            )}
          </>
        }
      />

      {tab === "jobs" ? (
        <div role="tabpanel" id="bos-panel-jobs" aria-labelledby="bos-tab-jobs">
          {/* There is no "New job" button on purpose: a Job is created by describing it to Ash
              in chat, which is the whole point of the one-door design. A second way in would be
              a second thing to keep honest. */}
          <JobBoard liveNonce={jobNonce} lastEvent={lastEvent} />
        </div>
      ) : (
      <div role="tabpanel" id="bos-panel-stories" aria-labelledby="bos-tab-stories">
      {formOpen && <NewStoryForm onCreated={onCreated} onCancel={() => setFormOpen(false)} />}

      {error ? (
        <p className="bos-story-note helm-mono">
          stories unavailable — runtime not reachable{" "}
          <button type="button" className="bos-vault-retry" onClick={refetch}>Retry</button>
        </p>
      ) : stories === null ? (
        <p className="bos-story-note helm-mono">reading…</p>
      ) : total === 0 && !formOpen ? (
        <p className="bos-story-note helm-mono">
          No stories yet — start one with <b>New story</b> above. The team clarifies requirements,
          designs, builds, tests and ships it, pausing only at the two gates.
        </p>
      ) : (
        <div className="bos-story-board" role="list" aria-label="Stories by stage">
          {cols.map((c) => (
            <section key={c.stage} className="bos-story-col" data-gate={c.isGate ? "true" : undefined} role="listitem">
              <header className="bos-story-col-head">
                <span className="bos-story-col-label helm-mono">{c.label}</span>
                {c.isGate && <span className="bos-story-col-gate helm-mono">gate</span>}
                <span className="bos-story-col-count helm-mono">{c.stories.length}</span>
              </header>
              <div className="bos-story-col-well">
                {c.stories.length === 0 ? (
                  <span className="bos-story-col-empty" aria-hidden>—</span>
                ) : (
                  c.stories.map((s) => <StoryCard key={s.id} story={s} onOpen={openStory} />)
                )}
              </div>
            </section>
          ))}
        </div>
      )}
      </div>
      )}
      </div>

      {tab === "stories" && openId && <StoryDetail key={openId} storyId={openId} liveNonce={liveNonce} onClose={closeDetail} restoreFocusTo={launcherRef.current} />}
    </div>
  );
}
