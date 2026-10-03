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
import {
  STORY_GATE_STAGES,
  STORY_STAGES,
  agoLabel,
  columns,
  createStory,
  listStories,
  openQuestionCount,
  stageLabel,
  type Story,
} from "../../lib/storiesClient";
import { useCoalescedNonce } from "../../lib/useCoalescedNonce";
import { BosTopbar } from "./BosTopbar";
import { JobBoard } from "../board/JobBoard";
import { StoryDetail } from "./StoryDetail";
import { Kcol } from "./Kcol";

export interface StoriesPageProps {
  /** The venture scope from the sidebar switcher; null = all ventures. Stories are pipeline-wide
   *  (the runtime does not scope the list by venture), so this drives the eyebrow label only. */
  venture: string | null;
  /** Bumped on every story.changed frame + SSE resync — triggers the authoritative re-read. */
  liveNonce: number;
  /** 12.2 — bumped on every job.changed frame + SSE resync. Separate from `liveNonce` on
   *  purpose: a story frame must not re-read the job board, and vice versa. */
  jobNonce?: number;
}

// The mockup's status chip tone: waiting-you warn, shipped ok; the app adds blocked/rejected.
const STATUS_CHIP: Record<string, string> = { "waiting-you": "chip warn", shipped: "chip ok", blocked: "chip bad", rejected: "chip bad" };

// Memoized so a single story's frame (one changed card) does not re-render every other card in
// the board. `onOpen` is the stable `setOpenId` setter, so the default shallow compare holds.
// Phase G (ADR G-2): the mockup's `.kcard`. D-7: a story has no owner field, so the owner's
// avatar and name read "—" (an honest unknown, same shape); the time is the real updatedAt.
const StoryCard = memo(function StoryCard({ story, onOpen }: { story: Story; onOpen: (id: string) => void }) {
  const openQs = openQuestionCount(story.answers);
  return (
    <button type="button" className={story.status === "waiting-you" ? "kcard active-glow" : "kcard"} onClick={() => onOpen(story.id)}>
      <span className="meta">
        <span className="mono">{story.id}</span>
        <span className={STATUS_CHIP[story.status] ?? "chip"}>{story.status}</span>
        {openQs > 0 && <span className="chip warn" data-app-only="open-questions">{`${openQs} question${openQs === 1 ? "" : "s"}`}</span>}
      </span>
      <h3>{story.title}</h3>
      <span className="meta"><span className="ava" aria-hidden="true" style={{ width: 22, height: 22, fontSize: ".5rem" }}>—</span>{`— · ${agoLabel(story.updatedAt)}`}</span>
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
    <div className="card" role="group" aria-label="New story" data-app-only="new-story" style={{ marginBottom: 16 }}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="field">
          <label className="label" htmlFor="ns-title">Title</label>
          <input id="ns-title" className="field-ta" value={title} disabled={busy} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="What is the story?" />
        </div>
        <div className="field">
          <label className="label" htmlFor="ns-idea">Idea</label>
          <textarea id="ns-idea" className="field-ta" rows={3} value={idea} disabled={busy} maxLength={10000} onChange={(e) => setIdea(e.target.value)}
            placeholder="Describe the change the team should build; requirements will be clarified from here." />
        </div>
        {error && <p className="sub" role="alert" style={{ color: "var(--bad-ink)", margin: 0 }}>{error}</p>}
        <div className="row">
          <button type="button" className="btn btn-primary" aria-busy={busy || undefined} disabled={busy || !title.trim() || !idea.trim()} onClick={() => void submit()}>
            {busy ? "Creating…" : "Create story"}
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export function StoriesPage({ venture, liveNonce, jobNonce = 0 }: StoriesPageProps) {
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
  const gates = STORY_GATE_STAGES.map(stageLabel);

  // Phase G (ADR G-2): the mockup's Stories page — the Stories | Jobs segment, then the board.
  return (
    <section className="page" aria-labelledby="h-stories">
      {/* Background is inert while the dialog is open (bg is not inert under aria-modal alone).
          display:contents keeps the layout identical — the wrapper generates no box. */}
      <div style={{ display: "contents" }} inert={openId ? true : undefined}>
      <BosTopbar
        eyebrow={`Stories · ${venture ?? "All ventures"}`}
        title="Stories"
        tagline="every story, where it is right now"
        headingId="h-stories"
        clock
        chips={
          <>
            {/* A tablist, not two buttons: arrow keys and the aria roles are what make this
                usable without a mouse. */}
            <div className="seg" role="tablist" aria-label="Stories or jobs">
              {(["stories", "jobs"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  id={`bos-tab-${t}`}
                  aria-selected={tab === t}
                  aria-pressed={tab === t}
                  aria-controls={`bos-panel-${t}`}
                  tabIndex={tab === t ? 0 : -1}
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
            </div>
            {tab === "stories" && (
              <button type="button" className="pill" data-app-only="new-story" aria-expanded={formOpen} onClick={() => setFormOpen((o) => !o)}>New story</button>
            )}
          </>
        }
      />

      {tab === "jobs" ? (
        <div role="tabpanel" id="bos-panel-jobs" aria-labelledby="bos-tab-jobs">
          {/* There is no "New job" button on purpose: a Job is created by describing it to the
              Tech Lead in chat, the one door. A second way in would be a second thing to keep honest. */}
          <JobBoard liveNonce={jobNonce} />
        </div>
      ) : (
        <div role="tabpanel" id="bos-panel-stories" aria-labelledby="bos-tab-stories">
          {formOpen && <NewStoryForm onCreated={onCreated} onCancel={() => setFormOpen(false)} />}
          <p className="sub" style={{ margin: "0 0 10px" }}>{`${STORY_STAGES.length} stages · two are yours: ${gates.join(" and ")}`}</p>
          {error ? (
            <div className="empty-note"><span className="script">Not reachable.</span><br />{"The runtime did not answer. "}<button type="button" className="linkish" onClick={refetch}>Retry</button></div>
          ) : stories === null ? (
            <div className="empty-note" role="status">Reading the pipeline…</div>
          ) : total === 0 && !formOpen ? (
            <div className="empty-note"><span className="script">No stories yet.</span><br />Start one with New story. The team clarifies, designs, builds, tests and ships it, pausing only at your two gates.</div>
          ) : (
            <div className="kb-scroll">
              <div className="kb" aria-label="Stories by stage">
                {cols.map((c) => (
                  <Kcol key={c.stage} label={c.label} gate={c.isGate} count={c.stories.length}>
                    {c.stories.map((st) => <StoryCard key={st.id} story={st} onOpen={openStory} />)}
                  </Kcol>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      </div>

      {tab === "stories" && openId && <StoryDetail key={openId} storyId={openId} liveNonce={liveNonce} onClose={closeDetail} restoreFocusTo={launcherRef.current} />}
    </section>
  );
}
