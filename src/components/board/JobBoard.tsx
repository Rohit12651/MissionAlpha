/* Hallmark · component: kanban board · genre: technical (operator cockpit)
 * theme: BOSS locked palette (preserved — reuses the story-board geometry, no new tokens)
 * states: default · hover · focus · active · disabled(n/a) · loading · error · empty
 * contrast: paper/paper-dim on deck ≥ 4.5:1 (existing token pairs, unchanged)
 * pre-emit critique: P5 H4 E4 S5 R5 V4
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { columns, fetchJobs, type Job, outcomeLabel, verdictLabel } from "../../lib/jobsClient";
import { agoLabel } from "../../lib/storiesClient";
import { Kcol } from "../bos/Kcol";
import { JobDetail } from "./JobDetail";
import { JiraPicker } from "./JiraPicker";

/*
  Phase 12 / task 12.2 — THE BOARD. The BOSS's window onto the swarm.

  READ-ONLY BY CONSTRUCTION. Nothing here starts, stops, re-assigns or approves anything. The
  only three inputs a Job takes from the BOSS are the brief (given to Ash in chat), the answers
  to the Manager's questions, and the one yes/no on the summary — and the last two are decided
  on the gate cards in the Inbox, which already own that ladder. A board that could also drive
  the swarm would be a second control surface over one lifecycle.

  HONEST BY CONSTRUCTION: the columns render `parseJobs(GET /runtime/jobs)` and nothing else.
  A job carrying a status this build does not know is NOT re-homed into a real column — it goes
  to a clearly-labelled "unknown status" lane. Bucketing it into `blocked` would show the
  operator a status the runtime never said.

  LIVE: `liveNonce` (bumped by the App on every job.changed frame + SSE resync) drives the
  authoritative re-read; no polling. Since 12.2 the runtime emits job.changed on task moves too,
  which is what makes a card's contents live and not just its column.
*/

// The mockup's job tone (JOB_TONE): awaiting-you warn, blocked bad, shipped ok.
const JOB_CHIP: Record<string, string> = { "awaiting-you": "chip warn", blocked: "chip bad", shipped: "chip ok" };

// Phase G (ADR G-2): the mockup's job `.kcard` (jobCard()): id + status chip (+ verdict, ship
// outcome), title, the blocker in the bad ink, then the time. D-7: a job carries no venture
// and no build progress, so the mockup's venture name and progress bar are not drawn.
const JobCard = memo(function JobCard({ job, onOpen }: { job: Job; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      className={job.status === "awaiting-you" ? "kcard active-glow" : "kcard"}
      onClick={() => onOpen(job.id)}
      aria-label={`Job ${job.title}, status ${job.status}${job.shipOutcome ? `, ${outcomeLabel(job.shipOutcome)}` : ""}${job.strategyVerdict ? `, ${verdictLabel(job.strategyVerdict)}` : ""}. Open for tasks and thread.`}
    >
      <span className="meta">
        <span className="mono">{job.id.replace(/^job_/, "")}</span>
        <span className={JOB_CHIP[job.status] ?? "chip"}>{job.status}</span>
        {job.strategyVerdict && <span className="chip" data-testid="strategy-verdict">{verdictLabel(job.strategyVerdict)}</span>}
        {job.shipOutcome && <span className="chip ok" data-testid="ship-outcome">{outcomeLabel(job.shipOutcome)}</span>}
      </span>
      <h3>{job.title}</h3>
      {job.blockedOn && <span className="meta" style={{ color: "var(--bad-ink)" }}>{job.blockedOn}</span>}
      <span className="meta">{agoLabel(job.updatedAt)}</span>
    </button>
  );
});

export interface JobBoardProps {
  /** Bumped on every job.changed frame + SSE resync — drives the authoritative re-read. */
  liveNonce: number;
}

/**
 * The jobs board itself: GET /runtime/jobs → the mockup's `.kb` of job columns, a card opens
 * the job's detail dialog. Shared by the Stories page's Jobs tab and the Missions page's
 * Pipeline view (which, like the mockup, leaves out the Blocked column).
 */
export function JobColumns({ liveNonce, hideBlocked = false }: JobBoardProps & { hideBlocked?: boolean }) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const launcherRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const list = await fetchJobs();
        if (live) { setJobs(list); setError(null); }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "unreachable");
      }
    })();
    return () => { live = false; };
  }, [liveNonce, retryNonce]);

  const openJob = useCallback((id: string) => {
    launcherRef.current = (document.activeElement as HTMLElement) ?? null;
    setOpenId(id);
  }, []);
  const closeDetail = useCallback(() => setOpenId(null), []);
  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);

  const cols = columns(jobs ?? []).filter((c) => !(hideBlocked && c.status === "blocked"));
  const unplaced = columns(jobs ?? []).unplaced ?? [];
  const total = jobs?.length ?? 0;

  return (
    <>
      {/* Background is inert while the dialog is open (bg is not inert under aria-modal alone).
          display:contents keeps the layout identical — the wrapper generates no box. */}
      <div style={{ display: "contents" }} inert={openId ? true : undefined}>
        {error && jobs === null ? (
          <div className="empty-note"><span className="script">Not reachable.</span><br />{`jobs unavailable: ${error} `}<button type="button" className="linkish" onClick={retry}>Retry</button></div>
        ) : jobs === null ? (
          <div className="empty-note" role="status">Reading the jobs…</div>
        ) : total === 0 ? (
          <div className="empty-note"><span className="script">No jobs yet.</span><br />Describe one to the Tech Lead in chat; it comes back to you as one summary and one yes.</div>
        ) : (
          <div className="kb" aria-label="Jobs by status">
            {cols.map((c) => (
              <Kcol key={c.status} label={c.label} gate={c.isGate} count={c.jobs.length}>
                {c.jobs.map((j) => <JobCard key={j.id} job={j} onOpen={openJob} />)}
              </Kcol>
            ))}
            {/* Shown, labelled, never re-homed: a status this build does not know means the
                build is behind the runtime, a fact worth showing. */}
            {unplaced.length > 0 && (
              <Kcol label="Unknown status" count={unplaced.length}>
                {unplaced.map((j) => <JobCard key={j.id} job={j} onOpen={openJob} />)}
              </Kcol>
            )}
          </div>
        )}
      </div>
      {openId && <JobDetail key={openId} jobId={openId} liveNonce={liveNonce} onClose={closeDetail} restoreFocusTo={launcherRef.current} />}
    </>
  );
}

export function JobBoard({ liveNonce }: JobBoardProps) {
  const [jiraOpen, setJiraOpen] = useState(false);
  return (
    <div>
      <div className="card-h" style={{ marginBottom: 10 }}>
        <p className="sub" style={{ margin: 0 }}>Jobs start from a chat with the Tech Lead (Missions). The board has no &quot;new job&quot; button on purpose.</p>
        <button className="btn btn-ghost" type="button" aria-expanded={jiraOpen} style={{ minHeight: 36, padding: "8px 16px" }} onClick={() => setJiraOpen((o) => !o)}>Pick from Jira</button>
      </div>
      {/* 13.2 — the OTHER door into a Job: a ticket that already exists. */}
      {jiraOpen && <JiraPicker liveNonce={liveNonce} />}
      <div className="kb-scroll"><JobColumns liveNonce={liveNonce} /></div>
    </div>
  );
}
