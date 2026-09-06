// D6 — THE CONTROL THE STORIES SURFACE NEVER HAD.
//
// `POST /runtime/stories/:id/advance` has existed since S1 and nothing in the app ever
// called it: `storiesClient.ts` had no caller, and the only path that advanced a story was
// approving a design gate in the Inbox — stage 3 of 8. A story created through the UI
// therefore sat at `idea` forever. Verified live on 2026-08-24: the detail overlay's only
// control was "Close", and the smoke-test story had to be advanced with curl.
//
// WHERE A BUTTON IS AND IS NOT RIGHT (manualAdvance owns the rule, this only renders it):
// the pipeline drives itself between gates, so a control belongs only where the operator
// really is the missing input — nothing has started, or a stage failed and someone has to
// say "again". Offering one beside a stage that is mid-flight would invite a second
// dispatch of a turn already running on a live model.
//
// The runtime answers as soon as the stage is ENTERED, not when the agent finishes — a real
// stage takes 2 to 5 minutes on this install — so the success state says "running", never
// "done". Claiming completion at dispatch time is the same lie this program spent a session
// removing from the pipeline itself.
import { useState } from "react";
import { Play, RotateCw } from "lucide-react";
import { advanceStory, manualAdvance, stageLabel, type Story } from "../../lib/storiesClient";

export interface StoryAdvanceProps {
  story: Story;
  /** Called after a successful dispatch so the overlay re-reads authoritative state. */
  onAdvanced: () => void;
}

type Phase = { kind: "idle" } | { kind: "sending" } | { kind: "sent"; stage: string } | { kind: "error"; message: string };

export function StoryAdvance({ story, onAdvanced }: StoryAdvanceProps) {
  const action = manualAdvance(story);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  if (!action) return null;

  const busy = phase.kind === "sending";

  async function run() {
    setPhase({ kind: "sending" });
    try {
      const r = await advanceStory(story.id);
      // The route answers 200 with a typed body for refusals too (an illegal transition, a
      // stage already in flight). Rendering "started" on one of those would be the same
      // false-success the pipeline itself was fixed for, so every shape is read.
      if (r.error) { setPhase({ kind: "error", message: String(r.error) }); return; }
      if (r.failed) { setPhase({ kind: "error", message: "the stage ran and failed — see Collaboration below" }); return; }
      if (r.skipped) { setPhase({ kind: "error", message: r.reason || "the runtime declined to advance this story" }); return; }
      setPhase({ kind: "sent", stage: r.story?.stage || story.stage });
      onAdvanced();
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : "the runtime is unreachable" });
    }
  }

  return (
    <section className="bos-story-advance" aria-label="Pipeline control">
      <div className="bos-story-advance-copy">
        <p className="bos-story-advance-title">{action.label}</p>
        <p className="bos-story-advance-hint">{action.hint}</p>
      </div>
      <button
        type="button"
        className="helm-btn"
        data-variant={action.kind === "start" ? "primary" : "quiet"}
        onClick={run}
        disabled={busy}
        aria-busy={busy || undefined}
      >
        {action.kind === "start" ? <Play size={14} aria-hidden /> : <RotateCw size={14} aria-hidden />}
        {busy ? "dispatching…" : action.label}
      </button>
      {/* One live region for every outcome, so a screen reader hears the result of the
          press rather than only seeing a button that stopped being busy. */}
      <p className="bos-story-advance-note helm-mono" role="status" aria-live="polite" data-tone={phase.kind === "error" ? "red" : undefined}>
        {phase.kind === "sending" && "handing the story to its next seat…"}
        {phase.kind === "sent" && `running — ${stageLabel(phase.stage)} is in flight. A stage takes a few minutes; this view updates itself.`}
        {phase.kind === "error" && `could not advance — ${phase.message}`}
      </p>
    </section>
  );
}
