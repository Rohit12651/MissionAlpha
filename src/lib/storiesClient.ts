// Story-Pipeline S6 — Stories client: typed fetchers over the vite-proxied /runtime/stories
// routes the S1–S5 backend serves, plus the PURE view-model the Stories board + detail are
// made of (stage spine, status tone, answer-thread fold). The pure half has zero DOM and zero
// network so it is unit-testable under `node --experimental-strip-types`.
//
// Token pattern is cloned verbatim from outputsClient.ts: same same-origin runtime token, same
// x-runtime-token header, same runtimeUrl() base (dev-proxied AND packaged).
//
// HONEST BY CONSTRUCTION: the board renders `{ stories }` from GET /runtime/stories and the
// detail renders `{ story, log, build }` from GET /runtime/stories/:id — never a fabricated
// list. An empty pipeline renders an honest empty state, not a placeholder story. The two human
// gates (design-approval, release-accept) are surfaced as amber on the spine — a mapping this
// module owns (STORY_GATE_STAGES), pinned by a unit test.

import { runtimeToken, runtimeUrl } from "./runtimeBase.ts";

// ── stage machine (mirrors agent-runtime/stories.mjs STORY_STAGES) ────────────
export const STORY_STAGES = [
  "idea",
  "requirements",
  "design",
  "plan",
  "build",
  "review-qa",
  "deploy-watch",
  "accept",
] as const;
export type StoryStage = (typeof STORY_STAGES)[number];

export const STORY_STATUSES = ["active", "waiting-you", "blocked", "shipped", "rejected"] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];

/**
 * The two HUMAN GATES on the spine, rendered amber and distinct from the auto stages.
 * `design` is the design-approval gate (TAP 1); `deploy-watch` is where the release-accept
 * gate (TAP 2 / "Ship") lands before a deploy executes. Pinned by a unit test against the
 * program's "two human taps" invariant.
 */
export const STORY_GATE_STAGES: readonly StoryStage[] = ["design", "deploy-watch"];
export const isGateStage = (stage: string): boolean => STORY_GATE_STAGES.includes(stage as StoryStage);

/** Short human label per stage — the spine + column headers read from this. */
const STAGE_LABEL: Record<StoryStage, string> = {
  idea: "Idea",
  requirements: "Requirements",
  design: "Design",
  plan: "Plan",
  build: "Build",
  "review-qa": "Review · QA",
  "deploy-watch": "Ship · Watch",
  accept: "Accept",
};
export const stageLabel = (stage: string): string =>
  STAGE_LABEL[stage as StoryStage] ?? String(stage);

// ── wire types (mirror the runtime GET responses exactly) ─────────────────────
export interface Story {
  id: string;
  title: string;
  idea: string;
  spec: string | null;
  designRef: string | null;
  stage: StoryStage;
  status: StoryStatus;
  answers: string | null;
  venture: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StoryLogRow {
  seq: number;
  stage: string;
  event: string;
  ref: string | null;
  ts: number;
}

/** One loop step of a build task — mirrors agent-runtime/loop-steps.mjs list(). */
export interface StoryLoopStep {
  seq: number;
  agentId: string;
  kind: "think" | "tool" | "subagent" | "observe" | "result" | string;
  tool: string;
  summary: string;
  ts: number;
}

/** One build task — mirrors agent-runtime/story-build.mjs aggregate(). */
export interface StoryBuildTask {
  taskId: string;
  stepIndex: number;
  status: string;
  engineState: string | null;
  heldReason: string | null;
  branch: string | null;
  attempts: number;
  result: unknown;
  /** A classified engine error: `{ kind, msg }` (matches the queue's error shape), or null. */
  error: { kind?: string; msg?: string } | null;
  loopSteps: StoryLoopStep[];
}

/** A one-line, render-safe string for a build task's classified error (never an object). */
export function taskErrorText(error: StoryBuildTask["error"]): string | null {
  if (!error || typeof error !== "object") return typeof error === "string" ? error : null;
  const kind = typeof error.kind === "string" ? error.kind : "";
  const msg = typeof error.msg === "string" ? error.msg : "";
  const text = [kind, msg].filter(Boolean).join(" · ");
  return text || null;
}

export type StoryGoalState = "done" | "failed" | "running";

/** One per-seat build goal — mirrors agent-runtime/story-build.mjs aggregate(). */
export interface StoryBuildGoal {
  goalId: string;
  seat: string;
  tier: string | null;
  steps: string[];
  state: StoryGoalState;
  tasks: StoryBuildTask[];
}

export interface StoryBuild {
  goals: StoryBuildGoal[];
  counts: { done: number; failed: number; running: number };
  total: number;
}

/** GET /runtime/stories/:id — the story, its transition log, and the Build panel. */
export interface StoryDetail {
  story: Story;
  log: StoryLogRow[];
  build: StoryBuild;
}

export interface StoriesList {
  stories: Story[];
}

// ── pure view-model ───────────────────────────────────────────────────────────

/** Chip tone per status — amber = needs you, red = blocked/abandoned, green = shipped. */
export function statusTone(status: string): "amber" | "red" | "green" | "brass" | "muted" {
  switch (status) {
    case "waiting-you":
      return "amber";
    case "blocked":
    case "rejected":
      return "red";
    case "shipped":
      return "green";
    case "active":
      return "brass";
    default:
      return "muted";
  }
}

const STATUS_LABEL: Record<StoryStatus, string> = {
  active: "active",
  "waiting-you": "waiting you",
  blocked: "blocked",
  shipped: "shipped",
  rejected: "rejected",
};
export const statusLabel = (status: string): string =>
  STATUS_LABEL[status as StoryStatus] ?? String(status);

export const stageIndex = (stage: string): number => STORY_STAGES.indexOf(stage as StoryStage);

/** One node of the horizontal/vertical progress spine. */
export interface SpineNode {
  stage: StoryStage;
  label: string;
  /** Position relative to the story's current stage. */
  state: "done" | "current" | "todo";
  /** A human gate (design / ship) — rendered amber, distinct from an auto stage. */
  isGate: boolean;
  /** The current node while the story sits `waiting-you` at a gate — pulses amber. */
  awaitingYou: boolean;
  /** The current node of a story the BOSS abandoned. */
  rejected: boolean;
}

/**
 * Fold a story into its 8-node spine. A `shipped` story is all-done. Otherwise every stage
 * before the current is `done`, the current is `current`, the rest are `todo`. `awaitingYou`
 * marks the current node when the story is parked at a gate (`waiting-you`); `rejected` marks
 * the current node of an abandoned story. Pure — no clock, no network.
 */
export function spineFor(story: Pick<Story, "stage" | "status">): SpineNode[] {
  const shipped = story.status === "shipped";
  const rejected = story.status === "rejected";
  const waiting = story.status === "waiting-you";
  const curr = stageIndex(story.stage);
  return STORY_STAGES.map((stage, i) => {
    const isGate = isGateStage(stage);
    let state: SpineNode["state"];
    if (shipped) state = "done";
    else if (i < curr) state = "done";
    else if (i === curr) state = "current";
    else state = "todo";
    return {
      stage,
      label: stageLabel(stage),
      state,
      isGate,
      awaitingYou: waiting && i === curr,
      rejected: rejected && i === curr,
    };
  });
}

/** Bucket a story into its stage column — the board key. */
export const columnFor = (story: Pick<Story, "stage">): StoryStage =>
  (STORY_STAGES.includes(story.stage) ? story.stage : "idea");

/** Group stories by stage into the 8 ordered board columns (newest-updated first per column). */
export interface StoryColumn {
  stage: StoryStage;
  label: string;
  isGate: boolean;
  stories: Story[];
}
export function columns(stories: readonly Story[]): StoryColumn[] {
  const byStage = new Map<StoryStage, Story[]>();
  for (const s of STORY_STAGES) byStage.set(s, []);
  for (const s of stories) byStage.get(columnFor(s))?.push(s);
  for (const list of byStage.values()) list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return STORY_STAGES.map((stage) => ({
    stage,
    label: stageLabel(stage),
    isGate: isGateStage(stage),
    stories: byStage.get(stage) ?? [],
  }));
}

/** One threaded clarify Q&A entry (mirrors the pipeline's answers JSON shape). */
export interface ClarifyEntry {
  id: string;
  q: string;
  a: string | null;
}

/**
 * Fold a story's `answers` JSON into the clarify thread: `{ questions: [{ id, q, a|null }] }`.
 * Anything malformed folds to an empty thread rather than throwing — the field is agent-fed
 * and already scrubbed at rest, but this is belt-and-braces on the render path.
 */
export function clarifyThread(answers: string | null): ClarifyEntry[] {
  if (answers === null || answers === undefined || answers === "") return [];
  try {
    const o = JSON.parse(answers) as { questions?: unknown };
    const list = Array.isArray(o?.questions) ? o.questions : [];
    return list
      .map((raw, i): ClarifyEntry | null => {
        if (!raw || typeof raw !== "object") return null;
        const r = raw as { id?: unknown; q?: unknown; a?: unknown };
        const q = typeof r.q === "string" ? r.q : "";
        if (!q) return null;
        return {
          id: typeof r.id === "string" && r.id ? r.id : `q${i}`,
          q,
          a: typeof r.a === "string" ? r.a : null,
        };
      })
      .filter((e): e is ClarifyEntry => e !== null);
  } catch {
    return [];
  }
}

/** Count of still-open questions on a story (used for the "needs you" cue). */
export const openQuestionCount = (answers: string | null): number =>
  clarifyThread(answers).filter((e) => e.a === null).length;

const pad2 = (n: number): string => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A compact UTC stamp (`Aug 4 · 14:00 UTC`); `—` for a missing/invalid time. */
export function whenLabel(ms: number): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} · ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

// ── fetchers (outputsClient.ts token pattern) ─────────────────────────────────
async function authedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await runtimeToken();
  const r = await fetch(runtimeUrl(path), {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", "x-runtime-token": token, ...(init.headers || {}) },
  });
  // 400/403/404/409 carry a typed JSON body the caller renders; every other non-2xx is transport.
  if (!r.ok && r.status !== 400 && r.status !== 403 && r.status !== 404 && r.status !== 409) {
    throw new Error(`HTTP ${r.status}`);
  }
  return (await r.json()) as T;
}

export interface StoriesQuery {
  stage?: StoryStage;
  status?: StoryStatus;
}

/** GET /runtime/stories?stage=&status= — the whole pipeline, viewer-readable. */
export function listStories(q: StoriesQuery = {}, signal?: AbortSignal): Promise<StoriesList> {
  const p = new URLSearchParams();
  if (q.stage) p.set("stage", q.stage);
  if (q.status) p.set("status", q.status);
  const s = p.toString();
  return authedJson<StoriesList>(`/runtime/stories${s ? `?${s}` : ""}`, { signal });
}

/** GET /runtime/stories/:id — a story, its transition log, and the Build panel. Viewer-readable. */
export const getStory = (id: string, signal?: AbortSignal) =>
  authedJson<StoryDetail & { error?: string }>(`/runtime/stories/${encodeURIComponent(id)}`, { signal });

/** POST /runtime/stories {title, idea} — mint a story at the idea stage. Approver-gated. */
export const createStory = (title: string, idea: string) =>
  authedJson<{ story?: Story; error?: string }>(`/runtime/stories`, {
    method: "POST",
    body: JSON.stringify({ title, idea }),
  });
