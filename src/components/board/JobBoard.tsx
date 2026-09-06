/* Hallmark · component: kanban board · genre: technical (operator cockpit)
 * theme: BOSS locked palette (preserved — reuses the story-board geometry, no new tokens)
 * states: default · hover · focus · active · disabled(n/a) · loading · error · empty
 * contrast: paper/paper-dim on deck ≥ 4.5:1 (existing token pairs, unchanged)
 * pre-emit critique: P5 H4 E4 S5 R5 V4
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { columns, fetchJobs, statusTone, type Job } from "../../lib/jobsClient";
import type { RuntimeEvent } from "../../lib/useRuntimeEvents";
import { RosterStrip } from "./RosterStrip";
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

const JobCard = memo(function JobCard({ job, onOpen }: { job: Job; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      className="bos-story-card"
      data-status={job.status}
      onClick={() => onOpen(job.id)}
      aria-label={`Job ${job.title}, status ${job.status}. Open for tasks and thread.`}
    >
      <span className="bos-story-card-title helm-display">{job.title}</span>
      <span className="bos-story-card-foot">
        <span className="helm-chip" data-tone={statusTone(job.status)}>{job.status}</span>
        <span className="bos-story-card-when helm-mono">{job.id.replace(/^job_/, "")}</span>
      </span>
    </button>
  );
});

export interface JobBoardProps {
  /** Bumped on every job.changed frame + SSE resync — drives the authoritative re-read. */
  liveNonce: number;
  /** Forwarded to RosterStrip, which reacts to `roster.changed` (a mid-job hire) itself. */
  lastEvent?: RuntimeEvent | null;
}

export function JobBoard({ liveNonce, lastEvent }: JobBoardProps) {
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

  const cols = columns(jobs ?? []);
  const unplaced = cols.unplaced ?? [];
  const total = jobs?.length ?? 0;

  return (
    <div className="bos-job-board-wrap">
      {/* Background is inert while the dialog is open (bg is not inert under aria-modal alone).
          display:contents keeps the flex layout identical — the wrapper generates no box. */}
      <div style={{ display: "contents" }} inert={openId ? true : undefined}>
        {/* The roster, INCLUDING anyone HR hired mid-job. This is the 10.2 component reused, not
            re-implemented: a second hire card is a second thing that can misstate a writeScope. */}
        <RosterStrip lastEvent={lastEvent ?? null} />

        {/* 13.2 — the OTHER door into a Job. Ash takes a brief in words; this takes a ticket
            that already exists. Both end at the same board, and neither drives the swarm. */}
        <JiraPicker liveNonce={liveNonce} />

        {error && jobs === null ? (
          <p className="bos-story-note helm-mono" data-tone="red">
            jobs unavailable — {error}{" "}
            <button type="button" className="bos-vault-retry" onClick={retry}>Retry</button>
          </p>
        ) : jobs === null ? (
          <p className="bos-story-note helm-mono">reading…</p>
        ) : total === 0 ? (
          <p className="bos-story-note helm-mono">
            No jobs yet — describe one to <b>Ash</b> in chat. Ash creates it, the Manager plans it
            and assigns each task by skill, and it comes back to you as one summary and one yes.
          </p>
        ) : (
          <div className="bos-story-board" role="list" aria-label="Jobs by status">
            {cols.map((c) => (
              <section key={c.status} className="bos-story-col" data-gate={c.isGate ? "true" : undefined} role="listitem">
                <header className="bos-story-col-head">
                  <span className="bos-story-col-label helm-mono">{c.label}</span>
                  {c.isGate && <span className="bos-story-col-gate helm-mono">you</span>}
                  <span className="bos-story-col-count helm-mono">{c.jobs.length}</span>
                </header>
                <div className="bos-story-col-well">
                  {c.jobs.length === 0
                    ? <span className="bos-story-col-empty" aria-hidden>—</span>
                    : c.jobs.map((j) => <JobCard key={j.id} job={j} onOpen={openJob} />)}
                </div>
              </section>
            ))}
            {/* Shown, labelled, never re-homed. A status this build does not know means this
                build is behind the runtime — which is a fact worth showing, not hiding. */}
            {unplaced.length > 0 && (
              <section className="bos-story-col" role="listitem">
                <header className="bos-story-col-head">
                  <span className="bos-story-col-label helm-mono">Unknown status</span>
                  <span className="bos-story-col-count helm-mono">{unplaced.length}</span>
                </header>
                <div className="bos-story-col-well">
                  {unplaced.map((j) => <JobCard key={j.id} job={j} onOpen={openJob} />)}
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      {openId && (
        <JobDetail
          key={openId}
          jobId={openId}
          liveNonce={liveNonce}
          onClose={closeDetail}
          restoreFocusTo={launcherRef.current}
        />
      )}
    </div>
  );
}
