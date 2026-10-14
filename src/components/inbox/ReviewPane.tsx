import { useCallback, useEffect, useMemo, useState } from "react";
import {
  TYPED_CONFIRM,
  needsTypedConfirm,
  decidedLabel,
  isApproveBlocked,
  isDesignGate,
  isFailure,
  isJobClarify,
  isQuestion,
  isReadOnly,
  isReleaseGate,
  sourceLabel,
  type DecideVerb,
  type DeliveryChange,
  type DeliveryDetail,
  type DeliveryEdit,
  type DeliveryEditError,
} from "../../lib/inboxClient";
import { parseMentions, type Role } from "../../lib/authClient";
import { DiffEditor } from "./DiffEditor";
import { isSafePrUrl, modeLabel } from "../../lib/workspaceClient";
import { ErrorState } from "./ErrorState";
import { RiskChip } from "./RiskChip";
import { SlaTimer } from "./SlaTimer";
import { inboxKindOf } from "../../lib/inboxTally";
import { stationById, stationInitials } from "../../lib/stationMeta";
import { STORY_STAGES, isGateStage, stageLabel } from "../../lib/storiesClient";
import { trustChip, injectionChip } from "../../lib/externalTrust";

// @mention rendering (P9) — display only. Highlights `@name` tokens in feedback; a
// mention triggers no notification and no side effect. Text-node only (no innerHTML).
function MentionText({ text }: { text: string }) {
  return (
    <>
      {parseMentions(text).map((seg, i) =>
        seg.type === "mention"
          ? <span key={i} className="mono" style={{ color: "var(--brand)" }}>{seg.value}</span>
          : <span key={i}>{seg.value}</span>,
      )}
    </>
  );
}

/*
  Review pane — the decision surface.

  SECURITY (P3 exit criterion): the diff is rendered as TEXT NODES ONLY. Every
  line goes through React's normal child escaping. There is no innerHTML and no
  dangerouslySetInnerHTML anywhere in this file or its siblings — the mockup's
  innerHTML pattern deliberately does not ship. Diff content originates in a
  sandboxed agent's output, so it is untrusted by definition.

  NO TRUNCATION: every change, every line. The 4KB summary cap on the DB column
  does not apply to the change set, which the runtime rebuilds from the on-disk
  patch on GET /inbox/:id.

  Phase G (ADR G-2): the mockup's review card body — card header (kind · ref, title, SLA),
  pills, then per kind: a delivery's summary, reasons, diff boxes, typed APPLY, note and
  Approve / Request changes / Reject; a design gate's spine; a question's numbered
  answers; a failure's lines. The mockup shows the review INLINE at every width (below
  the list under 1100px), so the narrow-viewport modal is gone with it.
*/

/** The mockup's diff line classes: `.a` added, `.d` deleted, `.c` context (headers included). */
export const diffLine = (line: string): "a" | "d" | "c" =>
  line.startsWith("+") && !line.startsWith("+++ ") ? "a" : line.startsWith("-") && !line.startsWith("--- ") ? "d" : "c";

/** A decided delivery's change: the mockup's read-only `.diff` box. */
function DiffBlock({ change }: { change: DeliveryChange }) {
  const lines = useMemo(() => change.patch.split("\n"), [change.patch]);
  return (
    <div className="diff">
      <div className="diff-h"><span className="mono">{change.path}</span><span className="sub">read-only</span></div>
      {/* tabIndex makes the scroll container keyboard-scrollable (a11y for overflow regions). */}
      <pre tabIndex={0} role="group" aria-label={`Diff for ${change.path}`}>
        {lines.map((ln, i) => <span key={i} className={diffLine(ln)}>{ln === "" ? " " : ln}</span>)}
      </pre>
    </div>
  );
}

export interface ReviewPaneProps {
  delivery: DeliveryDetail | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /**
   * Phase 4 — `edits` carries the operator's revision of the proposal (full file bodies,
   * not a patch) and is only ever passed with `approve`. Absent ⇒ a plain approve, which
   * behaves exactly as it did before Phase 4.
   */
  onDecide: (
    verb: DecideVerb,
    feedback?: string,
    edits?: DeliveryEdit[],
  ) => Promise<{ ok: boolean; error?: string; editErrors?: DeliveryEditError[] }>;
  /**
   * P9 — the current user's role, or null when solo (0/1 account, full powers). A
   * 'viewer' sees the Inbox but no decide controls, and the server rejects a direct
   * decide anyway. `approvers` populates the assignee picker; `onAssign` sets it.
   */
  role?: Role | null;
  approvers?: string[];
  onAssign?: (assignee: string | null) => Promise<{ ok: boolean; error?: string }>;
  /**
   * S2 — answer a `question` gate. Given the typed answer, resolves the question via the
   * story answer route; the InboxPanel refreshes on success. Absent ⇒ no answer control is
   * rendered (a question gate then simply shows its text).
   */
  onAnswer?: (answer: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * #4 — a JOB's clarify gate carries several questions, answered together through the job's
   * own answer route. `jobQuestions` is null while the job is being read.
   */
  jobQuestions?: string[] | null;
  onAnswerJob?: (texts: string[]) => Promise<{ ok: boolean; error?: string }>;
}

export function ReviewPane({
  delivery,
  loading,
  error,
  onRetry,
  onDecide,
  role = null,
  approvers = [],
  onAssign,
  onAnswer,
  jobQuestions = null,
  onAnswerJob,
}: ReviewPaneProps) {
  const [feedback, setFeedback] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<DecideVerb | null>(null);
  const [decideError, setDecideError] = useState<string | null>(null);
  // S2 — the question-gate answer control's own transient state.
  const [answerText, setAnswerText] = useState("");
  const [answering, setAnswering] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  // #4 — one answer per job question, in the Manager's order.
  const [jobTexts, setJobTexts] = useState<string[]>([]);
  // Phase 4 — the operator's in-progress revision, keyed by path. A path is present here
  // only once it has been touched; `openEditor` is the single path whose textarea is open
  // (one at a time, so a 320px pane is never a stack of editors).
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [openEditor, setOpenEditor] = useState<string | null>(null);
  // Per-file refusals from the last decision, so each one renders on the field it names.
  const [editErrors, setEditErrors] = useState<DeliveryEditError[]>([]);

  const id = delivery?.id ?? null;
  // A new selection resets every transient control — stale feedback must never
  // ride along to a different Delivery.
  useEffect(() => {
    setFeedback("");
    setTyped("");
    setDecideError(null);
    setBusy(null);
    setAnswerText("");
    setAnswering(false);
    setAnswerError(null);
    // Selecting a different Delivery MUST drop any pending edit. Carrying a draft across
    // deliveries would let an operator approve one agent's file with another's text.
    setDrafts({});
    setOpenEditor(null);
    setEditErrors([]);
  }, [id]);

  // Phase 4 — draft handling. Immutable updates throughout: a mutated draft map would
  // not re-render, and a stale render on a control that rewrites source is unacceptable.
  const setDraft = useCallback((path: string, next: string) => {
    setDrafts((prev) => ({ ...prev, [path]: next }));
  }, []);
  const revertDraft = useCallback((path: string) => {
    setDrafts((prev) => {
      const { [path]: _dropped, ...rest } = prev;
      return rest;
    });
  }, []);
  const toggleEditor = useCallback((path: string, next: boolean) => {
    setOpenEditor(next ? path : null);
  }, []);

  /**
   * The edits actually sent with an approve: only files whose draft DIFFERS from the
   * agent's proposal. An untouched (or reverted-to-identical) file must not appear, or a
   * plain approve would start reporting phantom edits — and the runtime would refuse an
   * empty batch.
   */
  const pendingEdits = useMemo<DeliveryEdit[]>(() => {
    if (!delivery?.changes) return [];
    return delivery.changes
      .filter((c) => drafts[c.path] !== undefined && drafts[c.path] !== c.after)
      .map((c) => ({ path: c.path, after: drafts[c.path] as string }));
  }, [delivery?.changes, drafts]);

  const run = useCallback(
    async (verb: DecideVerb) => {
      if (busy) return;
      setBusy(verb);
      setDecideError(null);
      // Edits ride ONLY with approve. The runtime refuses them on any other verb anyway
      // (400), but sending them would be a client bug worth not writing.
      const edits = verb === "approve" && pendingEdits.length ? pendingEdits : undefined;
      const r = await onDecide(verb, feedback.trim() || undefined, edits);
      setBusy(null);
      setEditErrors(r.editErrors ?? []);
      // When the refusal is attributable to a file, it renders ON that file. Repeating it
      // in the pane banner shows the same sentence twice and gives screen readers two
      // role="alert" nodes for one event.
      if (!r.ok) setDecideError(r.editErrors?.length ? null : r.error || "decision failed");
      else setDecideError(null);
    },
    [busy, feedback, onDecide, pendingEdits],
  );

  const errorFor = useCallback(
    (path: string) => editErrors.find((e) => e.path === path)?.message ?? null,
    [editErrors],
  );

  // #4 — a new selection starts with empty answers, one slot per question.
  useEffect(() => { setJobTexts((jobQuestions ?? []).map(() => "")); }, [id, jobQuestions]);

  const submitJobAnswers = useCallback(async () => {
    if (answering || !onAnswerJob) return;
    setAnswering(true);
    setAnswerError(null);
    const r = await onAnswerJob(jobTexts);
    setAnswering(false);
    if (!r.ok) setAnswerError(r.error || "could not submit the answers");
  }, [answering, jobTexts, onAnswerJob]);

  // S2 — submit an answer to a question gate.
  const submitAnswer = useCallback(async () => {
    if (answering || !onAnswer) return;
    const a = answerText.trim();
    if (!a) { setAnswerError("An answer is required."); return; }
    setAnswering(true);
    setAnswerError(null);
    const r = await onAnswer(a);
    setAnswering(false);
    if (!r.ok) setAnswerError(r.error || "could not submit the answer");
  }, [answering, answerText, onAnswer]);


  if (loading && !delivery) return <div className="empty-note" role="status" aria-live="polite">Loading the change set…</div>;
  if (error && !delivery) return <ErrorState message={error} onRetry={onRetry} />;
  if (!delivery) return <div className="empty-note"><span className="script">Pick something.</span><br />Its review opens here.</div>;

  const d = delivery;
  const band = d.risk.band;
  const pending = d.status === "pending";
  const failure = isFailure(d);
  const question = isQuestion(d);
  const designGate = isDesignGate(d);
  const releaseGate = isReleaseGate(d);
  const readOnly = isReadOnly(d);
  // P9 — a viewer sees everything but cannot decide (the server also refuses). null = solo.
  const canDecide = role !== "viewer";
  const canAssign = canDecide && !!onAssign && approvers.length > 0;
  const isGithub = d.source === "github-pr";
  const meta = d.externalMeta ?? null;
  const prUrl = isGithub ? meta?.url ?? d.prUrl : d.prUrl;
  const approveKind = { designGate: Boolean(designGate), failure: Boolean(failure) };
  const confirmRequired = needsTypedConfirm(band, approveKind);
  const approveBlocked = isApproveBlocked(band, typed, approveKind);
  const trust = trustChip(meta?.trust);
  const inject = injectionChip(meta?.injectFlags);
  // The mockup's rule, enforced so the copy is true: a note is needed to send work back.
  const noteMissing = feedback.trim().length === 0;
  const ref = d.storyId ?? d.jobId ?? null;
  const station = stationById(d.agentId)?.name ?? d.agentId;
  const files = d.diffstat.files;
  const openPr = (e: React.MouseEvent) => {
    // Electron denies window.open; the packaged app routes through the main-process bridge,
    // whose own allowlist (https + github.com) is re-checked there.
    if (window.missionAlpha?.openExternal) { e.preventDefault(); void window.missionAlpha.openExternal(prUrl as string); }
  };
  const prLink = isSafePrUrl(prUrl) ? <a href={prUrl as string} target="_blank" rel="noopener noreferrer" onClick={openPr}>view pull request</a> : null;

  const note = (label: string) => (
    <div className="field" style={{ marginTop: 12 }}>
      <label className="label" htmlFor="rv-note">{label}</label>
      <textarea id="rv-note" rows={2} className="field-ta" value={feedback} disabled={busy != null} onChange={(e) => setFeedback(e.target.value)} />
      {parseMentions(feedback).some((m) => m.type === "mention") && (
        <span className="sub" data-app-only="mentions">{`Mentions: ${parseMentions(feedback).filter((m) => m.type === "mention").map((m) => m.value).join(" ")}`}</span>
      )}
      {decideError && <p className="sub" role="alert" style={{ color: "var(--bad-ink)", margin: "4px 0 0" }}>{decideError}</p>}
    </div>
  );

  const decided = !pending ? (
    <div className={d.status === "rejected" ? "alert" : "alert okline"} role="status" style={{ marginTop: 12 }}>
      <span className={d.status === "rejected" ? "dot bad" : "dot ok"} style={{ marginTop: 7 }} />
      <div>
        {decidedLabel(d.status)}
        {d.decidedBy ? ` · by ${d.decidedBy}` : ""}
        {d.mode ? ` · ${modeLabel(d.mode, d.branch)}` : ""}
        {d.feedback ? <> · “<MentionText text={d.feedback} />”</> : null}
        {(d.mode === "pr" || isGithub) && prLink ? <> · {prLink}</> : null}
      </div>
    </div>
  ) : null;

  const changes = d.changes.length === 0 ? (
    d.changedPaths.length > 0 ? (
      // P7 — a read-only Claude Code session carries the touched files but no patch bodies.
      <ul className="list" style={{ gap: 2, marginTop: 12 }} aria-label="Files touched">
        {d.changedPaths.map((p) => <li key={p} className="mono" style={{ fontSize: ".8125rem" }}>{p}</li>)}
      </ul>
    ) : null
  ) : (
    <>
      {d.changes.map((c) => pending ? (
        <DiffEditor key={c.path} change={c} draft={drafts[c.path]} editing={openEditor === c.path} disabled={busy != null}
          errorMessage={errorFor(c.path)} onToggleEdit={toggleEditor} onChange={setDraft} onRevert={revertDraft} />
      ) : <DiffBlock key={c.path} change={c} />)}
      {pending && pendingEdits.length ? (
        <p className="sub" role="status" style={{ margin: "8px 0 0" }}>{`${pendingEdits.length} file${pendingEdits.length === 1 ? "" : "s"} edited. Approving sends your text.`}</p>
      ) : null}
    </>
  );

  const decideRow = (
    <div className="row" style={{ marginTop: 12 }}>
      {failure ? (
        <>
          <button className="btn btn-primary" type="button" disabled={noteMissing || busy != null} aria-busy={busy === "request_changes" || undefined}
            title={noteMissing ? "Describe the fix first: it becomes the agent's next task" : undefined} onClick={() => void run("request_changes")}>
            {busy === "request_changes" ? "Sending back…" : `Send back to ${station}`}
          </button>
          <button className="btn btn-ghost" type="button" disabled={busy != null} aria-busy={busy === "reject" || undefined} onClick={() => void run("reject")}>
            {busy === "reject" ? "Dismissing…" : "Dismiss"}
          </button>
        </>
      ) : designGate ? (
        <>
          <button className="btn btn-primary" type="button" disabled={busy != null} aria-busy={busy === "approve" || undefined} onClick={() => void run("approve")}>
            {busy === "approve" ? "Approving…" : "Approve design"}
          </button>
          <button className="btn btn-ghost" type="button" disabled={noteMissing || busy != null} aria-busy={busy === "request_changes" || undefined}
            title={noteMissing ? "Write a note first" : undefined} onClick={() => void run("request_changes")}>
            {busy === "request_changes" ? "Sending back…" : "Send it back"}
          </button>
          <button className="btn btn-outline" type="button" disabled={noteMissing || busy != null} data-app-only="gate-reject" onClick={() => void run("reject")}>
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </button>
        </>
      ) : (
        <>
          <button className="btn btn-primary" type="button" disabled={approveBlocked || busy != null} aria-busy={busy === "approve" || undefined}
            title={approveBlocked ? `Type ${TYPED_CONFIRM} above to enable` : undefined} onClick={() => void run("approve")}>
            {busy === "approve" ? "Applying…" : pendingEdits.length ? `Approve with ${pendingEdits.length} edit${pendingEdits.length === 1 ? "" : "s"}` : "Approve"}
          </button>
          <button className="btn btn-ghost" type="button" disabled={noteMissing || busy != null} aria-busy={busy === "request_changes" || undefined}
            title={noteMissing ? "Write a note first" : undefined} onClick={() => void run("request_changes")}>
            {busy === "request_changes" ? "Sending…" : "Request changes"}
          </button>
          <button className="btn btn-outline" type="button" disabled={noteMissing || busy != null} aria-busy={busy === "reject" || undefined}
            title={noteMissing ? "Write a note first" : undefined} onClick={() => void run("reject")}>
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </button>
        </>
      )}
    </div>
  );

  let body: React.ReactNode;
  if (!pending) body = <>{d.summary && <p style={{ margin: "0 0 8px" }}>{d.summary}</p>}{changes}{decided}</>;
  else if (readOnly) body = <>{d.summary && <p style={{ margin: "0 0 8px" }}>{d.summary}</p>}{changes}<p className="sub" role="status" style={{ marginTop: 12 }}>Read-only: this Claude Code session is shown for visibility. Decide it in Claude Code.</p></>;
  else if (!canDecide) body = <>{d.summary && <p style={{ margin: "0 0 8px" }}>{d.summary}</p>}{changes}<p className="sub" role="status" style={{ marginTop: 12 }}>Viewer: read only. Only an approver can decide it.</p></>;
  else if (question) {
    const jobMode = isJobClarify(d) && !!onAnswerJob;
    const qs = jobMode ? jobQuestions : [d.summary];
    body = qs === null ? <p className="sub" role="status">Loading the job's questions…</p> : (
      <form className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); void (jobMode ? submitJobAnswers() : submitAnswer()); }}>
        {qs.map((q, n) => (
          <div className="field" key={n}>
            <label className="label" htmlFor={`qa2-${n}`}>{`${n + 1}. ${q}`}</label>
            <textarea id={`qa2-${n}`} rows={2} className="field-ta" disabled={answering}
              value={jobMode ? jobTexts[n] ?? "" : answerText}
              onChange={(e) => (jobMode ? setJobTexts((t) => t.map((v, j) => (j === n ? e.target.value : v))) : setAnswerText(e.target.value))} />
          </div>
        ))}
        {answerError && <p className="sub" role="alert" style={{ color: "var(--bad-ink)", margin: 0 }}>{answerError}</p>}
        <div className="row">
          <button className="btn btn-primary" type="submit" aria-busy={answering || undefined}
            disabled={answering || (jobMode ? jobTexts.some((t) => !t.trim()) : !answerText.trim()) || (!jobMode && (!onAnswer || !!d.jobId))}>
            {answering ? "Sending…" : "Send answers"}
          </button>
        </div>
      </form>
    );
  } else if (designGate) {
    body = (
      <>
        <p style={{ margin: "0 0 12px" }}>{d.summary}</p>
        <div className="spine">
          {STORY_STAGES.map((st) => (
            <span key={st} className={`snode${isGateStage(st) ? " gate" : ""}${st === "design" ? " current" : ""}`}>{stageLabel(st)}</span>
          ))}
        </div>
        {note("Note (needed to send it back)")}
        {decideRow}
      </>
    );
  } else if (failure) {
    body = (
      <>
        <ul className="list" style={{ gap: 4 }}>
          {d.summary.split("\n").filter((l) => l.trim()).map((l, i) => <li key={i} className="mono" style={{ fontSize: ".8125rem" }}>{`✗ ${l}`}</li>)}
        </ul>
        {note("Note for the agent (needed to send it back)")}
        {decideRow}
      </>
    );
  } else {
    body = (
      <>
        <p style={{ margin: "0 0 8px" }}>{d.summary}</p>
        {d.risk.reasons.length > 0 && (
          <ul className="list" style={{ gap: 2 }} aria-label="Why this risk band">
            {d.risk.reasons.map((r) => <li key={r} className="sub" style={{ textTransform: "none", letterSpacing: ".02em", fontSize: ".8125rem" }}>{`▸ ${r}`}</li>)}
          </ul>
        )}
        {isGithub && (
          <p className="sub" role="note" data-app-only="github-note" style={{ margin: "8px 0 0" }}>
            {`Approving posts a review to GitHub${meta?.prNumber ? ` (PR #${meta.prNumber})` : ""}: the change lands there, not in your working tree.`}{prLink ? <> · {prLink}</> : null}
          </p>
        )}
        {releaseGate && !d.changes.length && <p className="sub" style={{ margin: "8px 0 0" }}>A release gate: approve runs the deploy and ships on a healthy check.</p>}
        {changes}
        {confirmRequired && (
          <div className="typed">
            <label className="label" htmlFor="rv-apply">{`High risk · type ${TYPED_CONFIRM} to approve`}</label>
            <input id="rv-apply" className="field-ta" autoComplete="off" aria-describedby="rv-apply-h" value={typed} disabled={busy != null}
              aria-invalid={typed.length > 0 && typed !== TYPED_CONFIRM} onChange={(e) => setTyped(e.target.value)} />
            <span className="sub" id="rv-apply-h">{d.risk.reasons[0] ?? "This change is rated high risk."}</span>
          </div>
        )}
        {note("Note for the team (needed to request changes or reject)")}
        {decideRow}
      </>
    );
  }

  return (
    <>
      <div className="card-h">
        <div>
          <p className="sub" style={{ margin: 0 }}>{ref ? `${inboxKindOf(d.kind)} · ${ref}` : inboxKindOf(d.kind)}</p>
          <h2 style={{ fontSize: "1.5rem", marginTop: 4 }}>{d.title}</h2>
        </div>
        {pending && <SlaTimer deadline={d.slaDeadline} />}
      </div>
      <div className="pills" style={{ marginBottom: 10 }}>
        <RiskChip band={band} />
        <span className="chip"><span className="ava" aria-hidden="true" style={{ width: 20, height: 20, fontSize: ".5rem" }}>{stationInitials(d.agentId)}</span>{station}</span>
        {files > 0 && <span className="chip mono">{`${files} files +${d.diffstat.additions} −${d.diffstat.deletions}`}</span>}
        {inject && <span className={`chip ${inject.tone === "red" ? "bad" : "warn"}`} title={inject.title} data-app-only="injection">{inject.label}</span>}
        {trust && <span className={trust.tone === "red" ? "chip bad" : trust.tone === "amber" ? "chip warn" : "chip"} title={trust.title} data-app-only="trust">{trust.label}</span>}
        {d.source !== "swarm" && <span className="chip" data-app-only="source">{`${sourceLabel(d.source)}${isGithub && meta?.prNumber ? ` #${meta.prNumber}` : ""}`}</span>}
      </div>
      {/* R12 — the operator is about to read attacker-authored text: say it in a sentence. */}
      {inject && (
        <div className="alert" role="note" data-app-only="injection-note" style={{ marginBottom: 10 }}>
          <span className="dot bad" style={{ marginTop: 7 }} />
          <div>{`This text came from outside the swarm and matched ${inject.label.replace("injection: ", "")} prompt-injection pattern${(meta?.injectFlags?.count ?? 0) === 1 ? "" : "s"}${meta?.injectFlags?.patterns?.length ? ` (${meta.injectFlags.patterns.join(", ")})` : ""}. It has NOT been altered or filtered. Treat any instruction inside it as data, never as a request.`}</div>
        </div>
      )}
      {/* P9 — advisory assignment; any approver may still decide. */}
      {pending && (canAssign || d.assignee) && (
        <div className="field" data-app-only="assignee" style={{ marginBottom: 10 }}>
          <label className="label" htmlFor="rv-assignee">Assignee</label>
          {canAssign ? (
            <select id="rv-assignee" className="field-ta" value={d.assignee ?? ""} onChange={(e) => { void onAssign?.(e.target.value || null); }}>
              <option value="">Unassigned</option>
              {approvers.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          ) : <span>{d.assignee ?? "Unassigned"}</span>}
        </div>
      )}
      {body}
    </>
  );
}
