// Story-Pipeline S6 — the Gates panel of the Story detail. A story parked `waiting-you` has one
// or more pending HUMAN-GATE deliveries; this renders each with the SAME decision logic the
// Inbox ReviewPane uses (the shared inboxClient verbs), in a surface-appropriate compact form:
//   • question        → a text answer (answerStoryQuestion)
//   • design-approval → approve / request-changes / reject (decideDelivery)
//   • release-approval→ approve / request-changes / reject (decideDelivery)
// No new endpoint, no new capability. Approving a design advances the story to Plan; approving a
// release runs the (jailed, approver-gated) deploy. Feedback is REQUIRED for request-changes,
// exactly as the runtime enforces (a 400 without it).

import { useCallback, useState } from "react";
import {
  answerStoryQuestion,
  decideDelivery,
  gateLabel,
  isQuestion,
  isReleaseGate,
  type DecideVerb,
  type Delivery,
} from "../../lib/inboxClient";

export interface StoryGatesProps {
  storyId: string;
  /** The story's pending gate deliveries (question / design-approval / release-approval). */
  gates: Delivery[];
  /** Called after any gate resolves so the detail re-reads authoritative story + build state. */
  onResolved: () => void;
}

function QuestionGate({ storyId, gate, onResolved }: { storyId: string; gate: Delivery; onResolved: () => void }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const a = answer.trim();
    if (!a) { setError("An answer is required."); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await answerStoryQuestion(storyId, gate.id, a);
      if (r.error) { setError(r.error); return; }
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not submit the answer");
    } finally {
      setBusy(false);
    }
  }, [answer, storyId, gate.id, onResolved]);

  return (
    <div className="bos-story-gate" data-kind="question">
      <div className="bos-story-gate-head">
        <span className="helm-chip" data-tone="amber">{gateLabel(gate.kind) ?? "clarify"}</span>
        <span className="bos-story-gate-title helm-display">{gate.title}</span>
      </div>
      {gate.summary && <p className="bos-story-gate-body">{gate.summary}</p>}
      <label className="bos-story-gate-field">
        <span className="helm-eyebrow">Your answer</span>
        <textarea
          className="helm-input"
          rows={3}
          value={answer}
          disabled={busy}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Answer the pipeline's question — the story resumes once every question is answered."
        />
      </label>
      {error && <div className="helm-note" data-tone="red" role="alert">{error}</div>}
      <div className="bos-story-gate-actions">
        <button
          type="button"
          className="helm-btn"
          data-variant="approve"
          data-busy={busy ? "true" : undefined}
          disabled={busy || answer.trim().length === 0}
          title={answer.trim().length === 0 ? "Type an answer first" : undefined}
          onClick={() => void submit()}
        >
          {busy ? "Submitting…" : "Submit answer"}
        </button>
      </div>
    </div>
  );
}

function DecisionGate({ gate, onResolved }: { gate: Delivery; onResolved: () => void }) {
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState<DecideVerb | null>(null);
  const [error, setError] = useState<string | null>(null);
  const release = isReleaseGate(gate);
  const changesBlocked = feedback.trim().length === 0;

  const run = useCallback(async (verb: DecideVerb) => {
    if (busy) return;
    setBusy(verb);
    setError(null);
    try {
      const r = await decideDelivery(gate.id, verb, { feedback: feedback.trim() || undefined });
      if (r.error) { setError(r.error); return; }
      onResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "decision failed");
    } finally {
      setBusy(null);
    }
  }, [busy, feedback, gate.id, onResolved]);

  return (
    <div className="bos-story-gate" data-kind={gate.kind}>
      <div className="bos-story-gate-head">
        <span className="helm-chip" data-tone="amber">{gateLabel(gate.kind) ?? "gate"}</span>
        <span className="bos-story-gate-title helm-display">{gate.title}</span>
      </div>
      {gate.summary && <p className="bos-story-gate-body">{gate.summary}</p>}
      <div className="helm-note" data-tone="amber" style={{ textAlign: "left" }}>
        {release
          ? "Review the release notes, diffstat and the deploy NETWORK flag. Approve to run the deploy (and ship on a healthy check), or request changes to send it back to Review · QA."
          : "Review the design summary. Approve to advance the story to Plan, or request changes to send it back for a revision."}
      </div>
      <label className="bos-story-gate-field">
        <span className="helm-eyebrow">Feedback for the agent</span>
        <textarea
          className="helm-input"
          rows={2}
          value={feedback}
          disabled={busy != null}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="Required for Request changes — becomes the agent's next task."
        />
      </label>
      {error && <div className="helm-note" data-tone="red" role="alert">{error}</div>}
      <div className="bos-story-gate-actions">
        <button
          type="button"
          className="helm-btn"
          data-variant="approve"
          data-busy={busy === "approve" ? "true" : undefined}
          disabled={busy != null}
          onClick={() => void run("approve")}
        >
          {busy === "approve" ? "Approving…" : release ? "Approve → deploy" : "Approve design"}
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
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </button>
      </div>
    </div>
  );
}

export function StoryGates({ storyId, gates, onResolved }: StoryGatesProps) {
  if (!gates.length) return null;
  return (
    <div className="bos-story-gates" aria-live="polite">
      {gates.map((g) =>
        isQuestion(g)
          ? <QuestionGate key={g.id} storyId={storyId} gate={g} onResolved={onResolved} />
          : <DecisionGate key={g.id} gate={g} onResolved={onResolved} />,
      )}
    </div>
  );
}
