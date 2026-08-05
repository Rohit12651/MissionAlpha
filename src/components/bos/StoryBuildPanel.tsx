// Story-Pipeline S6 — the Build panel of the Story detail. Renders the story's per-seat engine
// goals (from GET /runtime/stories/:id build.goals), each with its tasks, their loop steps, and
// the goal roll-up counts. Read-only view of live engine state — every value comes from the
// aggregate; nothing is fabricated. Loop-step summaries are agent output → rendered as TEXT
// NODES ONLY (no innerHTML), matching the ReviewPane diff discipline.

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { taskErrorText, type StoryBuild, type StoryBuildGoal, type StoryLoopStep } from "../../lib/storiesClient";

/** Chip tone for a goal state — done=green, failed=red, running=neutral/brass. */
function goalTone(state: string): "green" | "red" | "brass" {
  if (state === "done") return "green";
  if (state === "failed") return "red";
  return "brass";
}

/** Chip tone for a task status — done=green, failed/cancelled=red, held=amber, else neutral. */
function taskTone(status: string, heldReason: string | null): "green" | "red" | "amber" | "muted" {
  if (status === "done") return "green";
  if (status === "failed" || status === "cancelled") return "red";
  if (heldReason) return "amber";
  return "muted";
}

const STEP_LABEL: Record<string, string> = {
  think: "think",
  tool: "tool",
  subagent: "subagent",
  observe: "observe",
  result: "result",
};

function LoopStepRow({ step }: { step: StoryLoopStep }) {
  const kind = STEP_LABEL[step.kind] ?? step.kind;
  return (
    <li className="bos-story-step" data-kind={step.kind}>
      <span className="bos-story-step-kind helm-mono">{kind}</span>
      {step.tool && <span className="bos-story-step-tool helm-mono">{step.tool}</span>}
      <span className="bos-story-step-summary">{step.summary || "—"}</span>
    </li>
  );
}

function GoalCard({ goal }: { goal: StoryBuildGoal }) {
  const [open, setOpen] = useState(true);
  const taskCount = goal.tasks.length;
  const stepCount = goal.tasks.reduce((n, t) => n + t.loopSteps.length, 0);
  return (
    <div className="bos-story-goal" data-state={goal.state}>
      <button
        type="button"
        className="bos-story-goal-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight size={13} aria-hidden className="bos-story-caret" data-open={open ? "true" : undefined} />
        <span className="bos-story-goal-seat helm-display">{goal.seat}</span>
        {goal.tier && <span className="helm-chip" data-tone="muted">{goal.tier}</span>}
        <span className="helm-chip" data-tone={goalTone(goal.state)}>{goal.state}</span>
        <span className="bos-story-goal-meta helm-mono">
          {taskCount} task{taskCount === 1 ? "" : "s"} · {stepCount} step{stepCount === 1 ? "" : "s"}
        </span>
      </button>

      {open && (
        <div className="bos-story-goal-body">
          {goal.steps.length > 0 && (
            <ol className="bos-story-goal-steps">
              {goal.steps.map((s, i) => (
                <li key={i} className="bos-story-goal-step helm-mono">{s}</li>
              ))}
            </ol>
          )}

          {taskCount === 0 ? (
            <p className="bos-story-note helm-mono">No tasks enqueued yet.</p>
          ) : (
            goal.tasks.map((t) => (
              <div key={t.taskId} className="bos-story-task">
                <div className="bos-story-task-head">
                  <span className="helm-chip" data-tone={taskTone(t.status, t.heldReason)}>{t.status}</span>
                  {t.engineState && <span className="bos-story-task-meta helm-mono">{t.engineState}</span>}
                  {t.heldReason && <span className="helm-chip" data-tone="amber">held · {t.heldReason}</span>}
                  {t.attempts > 0 && <span className="bos-story-task-meta helm-mono">attempt {t.attempts}</span>}
                  {t.branch && <span className="bos-story-task-meta helm-mono" title={t.branch}>{t.branch}</span>}
                </div>
                {taskErrorText(t.error) && <p className="bos-story-note helm-mono" data-tone="red">{taskErrorText(t.error)}</p>}
                {t.loopSteps.length > 0 ? (
                  <ul className="bos-story-steps" aria-label="Loop steps">
                    {t.loopSteps.map((s) => <LoopStepRow key={s.seq} step={s} />)}
                  </ul>
                ) : (
                  <p className="bos-story-note helm-mono">No loop steps recorded yet.</p>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function StoryBuildPanel({ build }: { build: StoryBuild }) {
  if (!build || build.total === 0) {
    return (
      <p className="bos-story-note helm-mono">
        No build goals yet — they are enqueued when the story reaches Build.
      </p>
    );
  }
  const { counts } = build;
  return (
    <div className="bos-story-build">
      <div className="bos-story-build-counts">
        <span className="helm-chip" data-tone="green">{counts.done} done</span>
        <span className="helm-chip" data-tone="brass">{counts.running} running</span>
        <span className="helm-chip" data-tone={counts.failed ? "red" : "muted"}>{counts.failed} failed</span>
        <span className="bos-story-task-meta helm-mono">{build.total} goal{build.total === 1 ? "" : "s"}</span>
      </div>
      {build.goals.map((g) => <GoalCard key={g.goalId} goal={g} />)}
    </div>
  );
}
