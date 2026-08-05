import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { Brain, Wrench, Eye, CheckCircle2, GitBranch } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import { compactAge } from "../../lib/formatRelative";
import { useTick } from "../../lib/ticker";
import type { RuntimeEvent } from "../../lib/useRuntimeEvents";
import {
  getEngineRuns,
  getLoopSteps,
  isSubagentStep,
  latestTaskIdFor,
  sortSteps,
  stepKindLabel,
  type LoopStep,
} from "../../lib/stationClient.ts";

// CC-Primitives P5 — the Loop stream. A station's engine turn, replayed oldest →
// newest from the auth-gated GET /runtime/engine/steps.
//
// The `loop.step` frame is IDENTITY-ONLY by design (agent-runtime/loop-steps.mjs:
// summaries stay behind the gated GET because a bus frame reaches every seat), so
// this component RE-FETCHES on frame rather than reconstructing a row from payload.
//
// TASK ID: derived, never invented. GET /runtime/engine/runs → the station's tasks →
// `latestTaskIdFor` picks the most active, most recently touched one. No task ⇒ the
// empty state, full stop.

const KIND_ICON: Record<string, typeof Brain> = {
  think: Brain,
  tool: Wrench,
  observe: Eye,
  result: CheckCircle2,
  subagent: GitBranch,
};

// Existing OKLCH tokens only — no new palette.
const KIND_TONE: Record<string, string> = {
  think: "muted",
  tool: "accent-cyan",
  observe: "muted",
  result: "done-green",
  subagent: "factory-violet",
};

const isoOf = (ts: string | number): string | null => {
  if (typeof ts === "number" && Number.isFinite(ts)) return new Date(ts).toISOString();
  return typeof ts === "string" && ts ? ts : null;
};

function StepRow({ step, nowMs }: { step: LoopStep; nowMs: number }) {
  const sub = isSubagentStep(step);
  const tone = tok(KIND_TONE[String(step.kind)] ?? "muted");
  const Icon = KIND_ICON[String(step.kind)] ?? Brain;
  return (
    <li
      className="flex items-start gap-2 py-1 font-mono text-[11px] leading-snug"
      // Sub-agent turns are the station's children — indented and carried on their own
      // accent so a nested spawn is legible without a second mechanism.
      style={sub ? { paddingLeft: 14, borderLeft: `1px solid color-mix(in oklch, ${tone} 40%, transparent)` } : undefined}
    >
      <span className="mt-[2px] shrink-0" style={{ color: tone }} aria-hidden>
        <Icon size={11} />
      </span>
      <span className="shrink-0 uppercase tracking-wide" style={{ color: tone, opacity: 0.85 }}>
        {stepKindLabel(step.kind)}
      </span>
      {step.tool && (
        <span
          className="shrink-0 rounded px-1 text-[10px]"
          style={{ color: tok("accent-cyan"), backgroundColor: `color-mix(in oklch, ${tok("accent-cyan")} 12%, transparent)` }}
        >
          {step.tool}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-text/80" title={step.summary}>
        {step.summary || "—"}
      </span>
      <span className="shrink-0 tabular-nums text-[10px] text-muted">{compactAge(isoOf(step.ts), nowMs)}</span>
    </li>
  );
}

export function LoopStream({ agentId, lastEvent }: { agentId: string; lastEvent?: RuntimeEvent | null }) {
  const reduce = useReducedMotion();
  const nowMs = useTick();
  const [taskId, setTaskId] = useState<string | null>(null);
  const [steps, setSteps] = useState<LoopStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped when a frame says a DIFFERENT task is now running (re-derive the id), and
  // when a frame lands on the task already open (re-read its steps).
  const [runsNonce, setRunsNonce] = useState(0);
  const [stepNonce, setStepNonce] = useState(0);
  const seenRef = useRef<RuntimeEvent | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors `taskId` so the re-derive below can tell "same task, new step" from
  // "new task" without putting taskId in its own dependency list (which would
  // re-derive on every id change and loop).
  const taskIdRef = useRef<string | null>(null);

  // ── derive the task id (never invent one) ───────────────────────────────────
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    getEngineRuns()
      .then((r) => {
        if (!live) return;
        const id = latestTaskIdFor(r?.tasks, agentId);
        // Re-derived to the SAME task ⇒ the steps effect will not re-run on its own,
        // so nudge it here or the row list would stay on the pre-frame snapshot.
        if (id && id === taskIdRef.current) setStepNonce((n) => n + 1);
        taskIdRef.current = id;
        setTaskId(id);
        if (!id) { setSteps([]); setLoading(false); }
      })
      .catch(() => {
        if (!live) return;
        taskIdRef.current = null;
        setTaskId(null);
        setSteps([]);
        setLoading(false);
        setError("could not read the engine queue");
      });
    return () => { live = false; };
  }, [agentId, runsNonce]);

  // ── read the task's steps ───────────────────────────────────────────────────
  useEffect(() => {
    if (!taskId) return;
    let live = true;
    setLoading(true);
    getLoopSteps(taskId)
      .then((r) => {
        if (!live) return;
        setSteps(sortSteps(r?.steps ?? []));
        setError(r?.error ? "could not read this turn" : null);
        setLoading(false);
      })
      .catch(() => {
        if (!live) return;
        setSteps([]);
        setLoading(false);
        setError("could not read this turn");
      });
    return () => { live = false; };
  }, [taskId, stepNonce]);

  // ── SSE: `loop.step` is identity-only → re-fetch, never reconstruct ─────────
  // 400ms TRAILING debounce (react-review HIGH-2; same rationale as QueueStrip): a
  // chatty turn emits several frames per second — a burst collapses into ONE re-read.
  useEffect(() => {
    if (!lastEvent || lastEvent.name !== "loop.step") return;
    if (seenRef.current === lastEvent) return; // one frame, one reaction
    seenRef.current = lastEvent;
    const d = lastEvent.data as { agentId?: unknown; taskId?: unknown };
    if (d.agentId !== agentId) return;
    const frameTask = typeof d.taskId === "string" ? d.taskId : null;
    const bump = frameTask && frameTask !== taskId ? setRunsNonce : setStepNonce;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { bump((n) => n + 1); }, 400);
  }, [lastEvent, agentId, taskId]);
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  // Newest step visible. Instant when the operator asked for reduced motion.
  const scrollToNewest = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [reduce]);
  useEffect(() => { scrollToNewest(); }, [steps.length, scrollToNewest]);

  const ordered = steps;

  if (!taskId) {
    return (
      <p className="text-[12px] text-muted">
        {loading ? "reading the engine queue…" : error ? error : "no engine turns yet"}
      </p>
    );
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 font-mono text-[10px] text-muted">
        <span className="truncate" title={taskId}>{taskId}</span>
        <span className="ml-auto tabular-nums">{ordered.length} step{ordered.length === 1 ? "" : "s"}</span>
      </div>
      {error && (
        <p className="mb-1.5 text-[11px]" style={{ color: tok("stale-red") }} role="alert">{error}</p>
      )}
      <ol
        ref={listRef}
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Engine loop steps"
        className="flex max-h-64 flex-col overflow-y-auto"
        style={{ overscrollBehavior: "contain" }}
      >
        {ordered.length === 0 ? (
          <li className="py-1 text-[12px] text-muted">{loading ? "reading this turn…" : "no engine turns yet"}</li>
        ) : (
          ordered.map((s) => <StepRow key={s.seq} step={s} nowMs={nowMs} />)
        )}
      </ol>
    </div>
  );
}
