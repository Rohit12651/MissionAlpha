/* Hallmark · component: modal detail drawer · genre: technical (operator cockpit)
 * theme: BOSS locked palette (preserved — reuses the story-detail shell, no new tokens)
 * states: default · hover · focus · active · disabled(n/a) · loading · error · empty
 * contrast: paper/paper-dim on deck ≥ 4.5:1 (existing token pairs, unchanged)
 * pre-emit critique: P5 H4 E4 S5 R5 V4
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  fetchJob, resumeJob, statusTone, taskTone, type JobGate, type JobMail, type JobTask,
} from "../../lib/jobsClient";

/*
  Phase 12 / task 12.2 — ONE job, opened from the board.

  READ-ONLY BY CONSTRUCTION. There is not a single control here that drives the swarm: no
  re-run, no re-assign, no cancel. The BOSS's inputs to a job are exactly three — the brief,
  the answers to the Manager's questions, and the one yes/no on the summary — and the last two
  are decided on the gate cards in the Inbox, which already own that ladder with its typed
  confirm and its risk band. A second place to approve is a second place to get it wrong.

  WHAT IT SHOWS, all of it from GET /runtime/jobs/:id:
   · the tasks       — one row each: the seat doing it, its status, the files it changed
   · the open gates  — named, with where to decide them. Never decided here.
   · the thread      — the messages the seats actually exchanged (mailbox.thread)

  Bodies are AGENT-AUTHORED. They render as text nodes, never as markup, and the seat that
  wrote each one is on the row: a message that says "approved by the operator" must be visibly
  something an agent said, not something the board is asserting.
*/

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

function whenLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`;
}

function TaskRow({ t }: { t: JobTask }) {
  return (
    <li className="bos-job-task" data-status={t.status}>
      <span className="bos-job-task-seq helm-mono">{t.seq + 1}</span>
      <span className="min-w-0">
        <span className="bos-job-task-title">{t.title}</span>
        <span className="bos-job-task-meta helm-mono">
          {/* An empty seat is UNASSIGNED. Printing a name here that nobody holds would put a
              worker's name on work nobody is doing. */}
          {t.seat || "unassigned"}
          {t.changedPaths.length > 0 && ` · ${t.changedPaths.join(" · ")}`}
          {t.blockedOn && ` · blocked: ${t.blockedOn}`}
        </span>
      </span>
      <span className="helm-chip" data-tone={taskTone(t.status)}>{t.status}</span>
    </li>
  );
}

function MailRow({ m }: { m: JobMail }) {
  return (
    <li className="bos-job-mail">
      <span className="bos-job-mail-head helm-mono">
        {m.from} → {m.to} · {m.kind} · {whenLabel(m.at)}
      </span>
      {/* A text node. An agent-authored body is never markup. */}
      <span className="bos-job-mail-body">{m.body}</span>
    </li>
  );
}

export interface JobDetailProps {
  jobId: string;
  /** Bumped on every job.changed frame + SSE resync — triggers the authoritative re-read. */
  liveNonce: number;
  onClose: () => void;
  restoreFocusTo: HTMLElement | null;
}

export function JobDetail({ jobId, liveNonce, onClose, restoreFocusTo }: JobDetailProps) {
  const [data, setData] = useState<{ tasks: JobTask[]; gates: JobGate[]; log: JobMail[]; title: string; status: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Phase B · Task 6 — the way back from `blocked`. Approver-only on the server (403 renders
  // as the error line); the control shows whenever the job is blocked so a viewer sees that a
  // next move exists, and the refusal says who may take it.
  const [resuming, setResuming] = useState(false);
  const onResume = async () => {
    setResuming(true);
    try {
      const r = await resumeJob(jobId);
      if (!r.ok) { setError(r.error); return; }
      setError(null);
      setData((d) => (d ? { ...d, status: r.job?.status ?? "planned" } : d));
    } finally { setResuming(false); }
  };
  const [retryNonce, setRetryNonce] = useState(0);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const d = await fetchJob(jobId);
        if (!live) return;
        if (!d.job) { setError("no such job"); return; }
        setError(null);
        setData({ tasks: d.tasks, gates: d.gates, log: d.log, title: d.job.title, status: d.job.status });
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "unreachable");
      }
    })();
    return () => { live = false; };
  }, [jobId, liveNonce, retryNonce]);

  // Escape closes; focus moves to the pane on open and back to the launcher on close. Deps are
  // [jobId] only, so a live re-read cannot re-arm the trap and steal focus mid-scroll.
  useEffect(() => {
    const pane = paneRef.current;
    pane?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseRef.current(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      try { restoreFocusTo?.focus(); } catch { /* the launcher may be gone */ }
    };
  }, [jobId, restoreFocusTo]);

  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);

  return (
    <div className="bos-story-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={paneRef}
        tabIndex={-1}
        className="bos-story-detail"
        role="dialog"
        aria-modal="true"
        aria-label={data ? `Job: ${data.title}` : "Job detail"}
        style={{ animation: `bos-job-in 180ms ${EASE} both` }}
      >
        <header className="bos-story-detail-head">
          <div className="min-w-0">
            <p className="bos-deck-eyebrow helm-mono">JOB · {jobId}</p>
            <h2 className="bos-story-detail-title helm-display">{data?.title ?? "…"}</h2>
          </div>
          <div className="bos-story-detail-head-right">
            {data && <span className="helm-chip" data-tone={statusTone(data.status)}>{data.status}</span>}
            {data?.status === "blocked" && (
              <button type="button" className="helm-btn" data-testid="job-resume" onClick={onResume} disabled={resuming} aria-label="Resume this job — re-plan from blocked">
                {resuming ? "Resuming…" : "Resume"}
              </button>
            )}
            <button type="button" className="helm-btn" data-variant="quiet" onClick={onClose} aria-label="Close job">
              <X size={14} aria-hidden /> Close
            </button>
          </div>
        </header>

        {error && !data ? (
          <p className="bos-story-note helm-mono" data-tone="red">
            job unavailable — {error}{" "}
            <button type="button" className="bos-vault-retry" onClick={retry}>Retry</button>
          </p>
        ) : !data ? (
          <p className="bos-story-note helm-mono">reading…</p>
        ) : (
          <div className="bos-story-detail-body">
            <section aria-labelledby={`jd-tasks-${jobId}`}>
              <h3 id={`jd-tasks-${jobId}`} className="bos-job-h helm-mono">TASKS</h3>
              {data.tasks.length === 0 ? (
                <p className="bos-story-note helm-mono">
                  No tasks yet — the Manager writes them once it has read the brief and the repo.
                </p>
              ) : (
                <ul className="bos-job-tasks" role="list">
                  {data.tasks.map((t) => <TaskRow key={t.id} t={t} />)}
                </ul>
              )}
            </section>

            {data.gates.length > 0 && (
              <section aria-labelledby={`jd-gates-${jobId}`}>
                <h3 id={`jd-gates-${jobId}`} className="bos-job-h helm-mono">WAITING ON YOU</h3>
                <ul className="bos-job-tasks" role="list">
                  {data.gates.map((g) => (
                    <li key={g.id} className="bos-job-task" data-status={g.status}>
                      <span className="min-w-0">
                        <span className="bos-job-task-title">{g.title}</span>
                        {/* Named here, decided in the Inbox — that ladder owns the typed
                            confirm and the risk band, and one decision needs one home. */}
                        <span className="bos-job-task-meta helm-mono">{g.kind} · decide it on the Inbox</span>
                      </span>
                      <span className="helm-chip" data-tone="amber">{g.status}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section aria-labelledby={`jd-thread-${jobId}`}>
              <h3 id={`jd-thread-${jobId}`} className="bos-job-h helm-mono">THREAD</h3>
              {data.log.length === 0 ? (
                <p className="bos-story-note helm-mono">Nothing said yet — seats talk once the work starts.</p>
              ) : (
                <ul className="bos-job-thread" role="list">
                  {data.log.map((m) => <MailRow key={m.id} m={m} />)}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
