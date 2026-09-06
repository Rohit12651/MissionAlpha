import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  TYPED_CONFIRM,
  needsTypedConfirm,
  decidedLabel,
  isApproveBlocked,
  isDesignGate,
  isFailure,
  isGate,
  isQuestion,
  isReadOnly,
  isReleaseGate,
  riskLabel,
  riskTone,
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
import { trustChip, injectionChip } from "../../lib/externalTrust";

// @mention rendering (P9) — display only. Highlights `@name` tokens in feedback; a
// mention triggers no notification and no side effect. Text-node only (no innerHTML).
function MentionText({ text }: { text: string }) {
  return (
    <>
      {parseMentions(text).map((seg, i) =>
        seg.type === "mention"
          ? <span key={i} className="helm-mono" style={{ color: "var(--helm-brass)" }}>{seg.value}</span>
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

  a11y: on narrow viewports the pane is a modal dialog (focus trapped, ESC closes,
  focus restored). On desktop it is an inline region beside the list — a focus trap
  there would be an a11y bug, so it is deliberately NOT applied.
*/

function diffLineClass(line: string): string {
  if (line.startsWith("--- ") || line.startsWith("+++ ")) return "helm-diff-file";
  if (line.startsWith("@@")) return "helm-diff-meta";
  if (line.startsWith("+")) return "helm-diff-add";
  if (line.startsWith("-")) return "helm-diff-del";
  return "";
}

function DiffBlock({ change }: { change: DeliveryChange }) {
  const lines = useMemo(() => change.patch.split("\n"), [change.patch]);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="helm-mono text-[11px]" style={{ color: "var(--helm-brass)" }}>
        {change.path}
        <span style={{ color: "var(--helm-paper-faint)" }}> · {change.status}</span>
      </span>
      {/* tabIndex makes the scroll container keyboard-scrollable (a11y for overflow regions). */}
      <pre className="helm-diff" tabIndex={0} role="group" aria-label={`Diff for ${change.path}`}>
        {lines.map((ln, i) => (
          <span key={i} className={diffLineClass(ln)} style={{ display: "block" }}>
            {ln === "" ? " " : ln}
          </span>
        ))}
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
  /** Modal presentation (narrow viewports): traps focus, ESC closes. */
  overlay?: boolean;
  onClose?: () => void;
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
}

export function ReviewPane({
  delivery,
  loading,
  error,
  onRetry,
  onDecide,
  overlay,
  onClose,
  role = null,
  approvers = [],
  onAssign,
  onAnswer,
}: ReviewPaneProps) {
  const [feedback, setFeedback] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState<DecideVerb | null>(null);
  const [decideError, setDecideError] = useState<string | null>(null);
  // S2 — the question-gate answer control's own transient state.
  const [answerText, setAnswerText] = useState("");
  const [answering, setAnswering] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  // Phase 4 — the operator's in-progress revision, keyed by path. A path is present here
  // only once it has been touched; `openEditor` is the single path whose textarea is open
  // (one at a time, so a 320px pane is never a stack of editors).
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [openEditor, setOpenEditor] = useState<string | null>(null);
  // Per-file refusals from the last decision, so each one renders on the field it names.
  const [editErrors, setEditErrors] = useState<DeliveryEditError[]>([]);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

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

  // ESC closes in overlay mode; focus is trapped and then restored.
  useEffect(() => {
    if (!overlay) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const node = paneRef.current;
    node?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose?.();
        return;
      }
      if (e.key !== "Tab" || !node) return;
      const f = node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      restoreRef.current?.focus?.();
    };
  }, [overlay, onClose, id]);

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

  const body = (() => {
    if (loading && !delivery) {
      return (
        <div className="helm-note" role="status" aria-live="polite">
          Loading the change set…
        </div>
      );
    }
    if (error && !delivery) return <ErrorState message={error} onRetry={onRetry} />;
    if (!delivery) {
      return <div className="helm-note">Select a delivery to review it.</div>;
    }

    const band = delivery.risk.band;
    const pending = delivery.status === "pending";
    // P4 — a failure Delivery ("agent stuck") has no diff to approve. Its two verbs
    // are the SAME ones the runtime already implements — request_changes (the feedback
    // becomes the agent's next task via engine.enqueueGoal) and reject (cancel the
    // stuck task) — relabelled for what they mean here. No new endpoint, no new
    // capability, no Approve→apply path on a row with nothing to apply.
    const failure = isFailure(delivery);
    // S2 — a HUMAN-GATE delivery. A `question` is ANSWERED (a text answer, not a decision);
    // a `design-approval` is DECIDED with the same approve / request-changes / reject verbs
    // (the runtime routes the decision back to the Story). Neither is a code diff, so the
    // high-band typed-confirm friction and the diff pane do not apply.
    const gate = isGate(delivery);
    const question = isQuestion(delivery);
    const designGate = isDesignGate(delivery);
    // S5 — the release-accept gate. Decided (approve → run the deploy; request-changes/reject →
    // bounce the story back to review-qa). The summary carries the release notes + diffstat +
    // task list + the deploy NETWORK flag, so the deciding human sees whether the deploy has egress.
    const releaseGate = isReleaseGate(delivery);
    // P7 — external ingestion. A claude-code session is READ-ONLY (no decide action);
    // a github-pr decision posts to GitHub (surfaced below the diff + as a PR link).
    const readOnly = isReadOnly(delivery);
    // P9 — a viewer sees everything but cannot decide (the server also refuses a direct
    // decide). null role = solo, which keeps full powers. `canAssign` gates the picker.
    const canDecide = role !== "viewer";
    const canAssign = canDecide && !!onAssign && approvers.length > 0;
    const isGithub = delivery.source === "github-pr";
    const meta = delivery.externalMeta ?? null;
    const prUrl = isGithub ? meta?.url ?? delivery.prUrl : delivery.prUrl;
    // The gate is live NOW even though P2 always writes a null band: the moment
    // ADR-053 (P6) writes band==="high", Approve is already locked behind the
    // typed confirmation. No P6 edit to this component is required. The predicate
    // itself is pure + unit-tested (inboxClient.isApproveBlocked).
    const approveKind = { designGate: Boolean(designGate), failure: Boolean(failure) };
    // One source of truth, two questions: does this delivery HAVE a confirmation step, and
    // is it still outstanding. The field is rendered from the first, the button from the
    // second — rendering both from the second made the input unmount as you typed into it.
    const confirmRequired = needsTypedConfirm(band, approveKind);
    const approveBlocked = isApproveBlocked(band, typed, approveKind);
    // R10 / R12 — advisory markers off externalMeta. This pane is where the operator
    // actually READS the untrusted text, so the injection marker matters more here than on
    // the list row.
    const trust = trustChip(meta?.trust);
    const inject = injectionChip(meta?.injectFlags);
    const changesBlocked = feedback.trim().length === 0; // runtime 400s without feedback

    return (
      <>
        <h2 className="helm-display text-[17px] leading-snug">{delivery.title}</h2>

        <div className="flex flex-wrap items-center gap-2">
          <span className="helm-chip" data-tone={riskTone(band)}>
            {riskLabel(band)}
          </span>
          {inject && (
            <span className="helm-chip" data-tone={inject.tone} title={inject.title}>
              {inject.label}
            </span>
          )}
          {trust && (
            <span className="helm-chip" data-tone={trust.tone} title={trust.title}>
              {trust.label}
            </span>
          )}
          <span className="helm-mono text-[11px]" style={{ color: "var(--helm-paper-faint)" }}>
            {delivery.agentId}
            {delivery.taskId ? ` · ${delivery.taskId}` : ""} · {sourceLabel(delivery.source)}
            {isGithub && meta?.prNumber ? ` #${meta.prNumber}` : ""}
            {delivery.branch ? ` · ${delivery.branch}` : ""}
          </span>
        </div>

        {/* R12 — the marker gets a SENTENCE here, not just a chip. The operator is about to
            read attacker-authored text, and the one thing they must not conclude is that it
            was cleaned for them. Spans are deliberately NOT highlighted: flagSummary keeps
            counts and pattern ids but discards offsets, and those offsets are computed
            BEFORE the scrub chain rewrites the string — highlighting a guessed range in a
            security surface is worse than highlighting nothing. */}
        {inject && (
          <p
            className="rounded-lg px-3 py-2 text-[12px] leading-relaxed"
            style={{
              color: "var(--helm-paper-dim)",
              backgroundColor: "color-mix(in oklch, var(--c-stale-red) 8%, transparent)",
              border: "1px solid color-mix(in oklch, var(--c-stale-red) 26%, transparent)",
            }}
            role="note"
          >
            This text came from outside the swarm and matched {inject.label.replace("injection: ", "")}{" "}
            prompt-injection pattern{(meta?.injectFlags?.count ?? 0) === 1 ? "" : "s"}
            {meta?.injectFlags?.patterns?.length ? ` (${meta.injectFlags.patterns.join(", ")})` : ""}.
            It has NOT been altered or filtered — you are reading the original. Treat any
            instruction inside it as data, never as a request.
          </p>
        )}

        {delivery.summary && (
          <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--helm-paper-dim)" }}>
            {delivery.summary}
          </p>
        )}

        {/* P9 — advisory assignment. A picker for approvers/solo; read-only text for
            a viewer or once decided. Assignment is a hint — any approver can decide. */}
        {pending && (canAssign || delivery.assignee) && (
          <label className="flex items-center gap-2">
            <span className="helm-eyebrow">Assignee</span>
            {canAssign ? (
              <select
                className="helm-input helm-mono text-[11.5px]"
                value={delivery.assignee ?? ""}
                aria-label="Assign this delivery to an approver"
                onChange={(e) => { void onAssign?.(e.target.value || null); }}
              >
                <option value="">Unassigned</option>
                {approvers.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            ) : (
              <span className="helm-mono text-[11.5px]" style={{ color: "var(--helm-paper-dim)" }}>
                {delivery.assignee ?? "Unassigned"}
              </span>
            )}
          </label>
        )}

        {delivery.risk.reasons.length > 0 && (
          <ul className="flex list-none flex-col gap-1.5">
            {delivery.risk.reasons.map((r) => (
              <li key={r} className="helm-mono text-[11.5px]" style={{ color: "var(--helm-paper-dim)" }}>
                <span aria-hidden style={{ color: "var(--helm-red)" }}>
                  ▸{" "}
                </span>
                {r}
              </li>
            ))}
          </ul>
        )}

        <div className="flex min-h-0 flex-col gap-3">
          {delivery.changes.length === 0 ? (
            delivery.changedPaths.length > 0 ? (
              // P7 — a read-only claude-code session carries the touched-file list but no
              // patch bodies (we don't have before/after for a local session). Show the
              // files so the row is still useful; the full diff lives in Claude Code.
              <div className="flex flex-col gap-1.5">
                <span className="helm-eyebrow">Files touched ({delivery.changedPaths.length})</span>
                <ul className="flex list-none flex-col gap-1">
                  {delivery.changedPaths.map((p) => (
                    <li key={p} className="helm-mono text-[11.5px]" style={{ color: "var(--helm-paper-dim)" }}>{p}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="helm-note" data-tone={failure ? "red" : gate ? "amber" : undefined}>
                {failure
                  ? "This agent could not finish. No changes were produced — read the classified error above, then dispatch a fix or dismiss it."
                  : question
                    ? "A clarify question from the pipeline. Answer it below — the story resumes once every question is answered."
                    : designGate
                      ? "A design gate. Review the design summary above, then approve to advance the story to Plan, or request changes to send it back for a revision."
                      : releaseGate
                        ? "A release gate. Review the release notes, diffstat and the deploy NETWORK flag above, then approve to run the deploy (and ship on a healthy check), or request changes to send it back to Review-QA."
                        : "No file changes on this delivery — nothing to diff."}
              </div>
            )
          ) : (
            delivery.changes.map((c) =>
              // Phase 4 — a PENDING code delivery is editable; a decided one is a record
              // and must stay read-only. The read-only path is the original DiffBlock,
              // byte-for-byte, so nothing about a decided delivery's rendering changed.
              pending ? (
                <DiffEditor
                  key={c.path}
                  change={c}
                  draft={drafts[c.path]}
                  editing={openEditor === c.path}
                  disabled={busy != null}
                  // Structured, not a string prefix match: the runtime returns
                  // `editErrors: [{path, message}]`, so a reworded server message cannot
                  // silently downgrade this to a pane-level banner.
                  errorMessage={errorFor(c.path)}
                  onToggleEdit={toggleEditor}
                  onChange={setDraft}
                  onRevert={revertDraft}
                />
              ) : (
                <DiffBlock key={c.path} change={c} />
              ),
            )
          )}
          {/* ONE pane-level live region for the edit count — the quantity the operator
              actually needs before pressing Approve. Per-file flags are visual only; a
              live region per file announces on every mount and says nothing useful. */}
          {pending && pendingEdits.length ? (
            <p className="helm-edit-note" role="status">
              {`${pendingEdits.length} file${pendingEdits.length === 1 ? "" : "s"} edited. Approving sends your text.`}
            </p>
          ) : null}
        </div>

        {!pending ? (
          <div
            className="helm-note"
            data-tone={delivery.status === "rejected" ? "red" : "green"}
            role="status"
          >
            {decidedLabel(delivery.status)}
            {delivery.decidedBy ? ` · by ${delivery.decidedBy}` : ""}
            {/* P5 — WHERE the change actually went. Rendered from the persisted
                `mode`, so it survives a reload and never guesses. */}
            {delivery.mode ? ` · ${modeLabel(delivery.mode, delivery.branch)}` : ""}
            {delivery.feedback ? <> · “<MentionText text={delivery.feedback} />”</> : ""}
            {/* P5 mode='pr' OR P7 github-pr both carry a GitHub PR link. */}
            {(delivery.mode === "pr" || isGithub) && isSafePrUrl(prUrl) && (
              <>
                {" · "}
                <a
                  href={prUrl as string}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2"
                  style={{ color: "var(--helm-brass)" }}
                  onClick={(e) => {
                    // Electron denies window.open AND non-loopback navigation, so the
                    // packaged app routes through the main-process bridge, whose own
                    // allowlist (https + github.com) is re-checked there.
                    if (window.missionAlpha?.openExternal) {
                      e.preventDefault();
                      void window.missionAlpha.openExternal(prUrl as string);
                    }
                  }}
                >
                  view pull request
                </a>
              </>
            )}
          </div>
        ) : readOnly ? (
          // P7 — a claude-code session is READ-ONLY in v1: no decide buttons, just a note.
          <div className="helm-note" role="status">
            Read-only — this Claude Code session is shown for visibility. Decide it in Claude Code.
          </div>
        ) : !canDecide ? (
          // P9 — a viewer sees the Inbox but cannot decide (the server also refuses a
          // direct decide). No approve/reject/request-changes controls are rendered.
          <div className="helm-note" role="status">
            Viewer — read only. You can review this delivery, but only an approver can decide it.
          </div>
        ) : question ? (
          // S2 — a clarify question is ANSWERED (a text answer), not decided. No approve/reject
          // verbs apply here; the answer route resolves the gate and resumes the story.
          <div className="flex flex-col gap-2">
            {onAnswer ? (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="helm-eyebrow">Your answer</span>
                  <textarea
                    className="helm-input"
                    rows={3}
                    value={answerText}
                    onChange={(e) => setAnswerText(e.target.value)}
                    placeholder="Answer the pipeline's question — the story resumes once every question is answered."
                    disabled={answering}
                  />
                </label>
                {answerError && (
                  <div className="helm-note" data-tone="red" role="alert">{answerError}</div>
                )}
                <div className="mt-auto flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="helm-btn"
                    data-variant="approve"
                    data-busy={answering ? "true" : undefined}
                    disabled={answering || answerText.trim().length === 0}
                    title={answerText.trim().length === 0 ? "Type an answer first" : undefined}
                    onClick={() => void submitAnswer()}
                  >
                    {answering ? "Submitting…" : "Submit answer"}
                  </button>
                </div>
              </>
            ) : (
              <div className="helm-note" role="status">This clarify question is read-only here.</div>
            )}
          </div>
        ) : (
          <>
            {/* P7 — a github-pr decision posts OUTBOUND to GitHub, not into your local tree. */}
            {isGithub && (
              <div className="helm-note" role="note">
                Approving posts a review to GitHub{meta?.prNumber ? ` (PR #${meta.prNumber})` : ""} — the change lands there, not in your working tree.
                {isSafePrUrl(prUrl) && (
                  <>
                    {" · "}
                    <a
                      href={prUrl as string}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2"
                      style={{ color: "var(--helm-brass)" }}
                      onClick={(e) => {
                        if (window.missionAlpha?.openExternal) {
                          e.preventDefault();
                          void window.missionAlpha.openExternal(prUrl as string);
                        }
                      }}
                    >
                      view pull request
                    </a>
                  </>
                )}
              </div>
            )}
            {confirmRequired && (
              <div className="helm-confirm">
                <b>High-risk change.</b> Type <b>{TYPED_CONFIRM}</b> to enable Approve.
                <input
                  className="helm-input helm-mono mt-2"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={`Type ${TYPED_CONFIRM} to confirm…`}
                  aria-label={`Type ${TYPED_CONFIRM} to enable approval`}
                  aria-invalid={typed.length > 0 && typed !== TYPED_CONFIRM}
                  disabled={busy != null}
                />
              </div>
            )}

            <label className="flex flex-col gap-1.5">
              <span className="helm-eyebrow">Feedback for the agent</span>
              <textarea
                className="helm-input"
                rows={2}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="Required for Request changes — becomes the agent's next task. Use @name to mention a teammate."
                disabled={busy != null}
              />
              {parseMentions(feedback).some((s) => s.type === "mention") && (
                <span className="helm-mono text-[11px]" style={{ color: "var(--helm-paper-faint)" }}>
                  Mentions: {parseMentions(feedback).filter((s) => s.type === "mention").map((s) => s.value).join(" ")}
                </span>
              )}
            </label>

            {decideError && (
              <div className="helm-note" data-tone="red" role="alert">
                {decideError}
              </div>
            )}

            <div className="mt-auto flex flex-wrap gap-2">
              {failure ? (
                <>
                  <button
                    type="button"
                    className="helm-btn"
                    data-variant="changes"
                    data-busy={busy === "request_changes" ? "true" : undefined}
                    disabled={changesBlocked || busy != null}
                    title={changesBlocked ? "Describe the fix first — it becomes the agent's next task" : undefined}
                    onClick={() => void run("request_changes")}
                  >
                    {busy === "request_changes" ? "Dispatching…" : "Dispatch fix"}
                  </button>
                  <button
                    type="button"
                    className="helm-btn"
                    data-variant="reject"
                    data-busy={busy === "reject" ? "true" : undefined}
                    disabled={busy != null}
                    onClick={() => void run("reject")}
                  >
                    {busy === "reject" ? "Dismissing…" : "Dismiss"}
                  </button>
                </>
              ) : (
                <>
              <button
                type="button"
                className="helm-btn"
                data-variant="approve"
                data-busy={busy === "approve" ? "true" : undefined}
                disabled={approveBlocked || busy != null}
                title={approveBlocked ? `Type ${TYPED_CONFIRM} above to enable` : undefined}
                onClick={() => void run("approve")}
              >
                {busy === "approve"
                  ? (designGate ? "Approving…" : "Applying…")
                  : designGate
                    ? "Approve design"
                    : pendingEdits.length
                      // The label states what will actually land. "Approve → apply" on a
                      // set of edited files would understate the action.
                      // "Approve WITH n edits": on a 5-file delivery, "Approve 2 edits"
                      // reads as "2 files will land". All of them land; 2 carry an edit.
                      ? `Approve with ${pendingEdits.length} edit${pendingEdits.length === 1 ? "" : "s"} → apply`
                      : "Approve → apply"}
              </button>
              <button
                type="button"
                className="helm-btn"
                data-variant="changes"
                data-busy={busy === "request_changes" ? "true" : undefined}
                disabled={changesBlocked || busy != null}
                title={changesBlocked ? "Write feedback first" : undefined}
                onClick={() => void run("request_changes")}
              >
                {busy === "request_changes" ? "Sending…" : "Request changes"}
              </button>
              <button
                type="button"
                className="helm-btn"
                data-variant="reject"
                data-busy={busy === "reject" ? "true" : undefined}
                disabled={busy != null}
                onClick={() => void run("reject")}
              >
                {busy === "reject" ? "Discarding…" : "Reject"}
              </button>
                </>
              )}
            </div>
          </>
        )}
      </>
    );
  })();

  const pane = (
    <div
      ref={paneRef}
      tabIndex={-1}
      className="helm-pane min-h-[420px]"
      role={overlay ? "dialog" : "region"}
      aria-modal={overlay ? true : undefined}
      aria-label="Delivery review"
    >
      {overlay && (
        <button
          type="button"
          className="helm-btn self-end"
          data-variant="quiet"
          onClick={onClose}
          aria-label="Close review"
        >
          <X size={14} aria-hidden /> Close
        </button>
      )}
      {body}
    </div>
  );

  if (!overlay) return pane;
  return (
    <div
      className="fixed inset-0 z-[70] overflow-y-auto p-3"
      style={{ background: "rgba(6,10,18,0.7)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      {pane}
    </div>
  );
}
