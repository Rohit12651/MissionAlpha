// CC-Primitives P5 — station client: typed fetchers over the five gated /runtime
// station routes the P1–P4 backend already serves, plus the PURE layer the station
// UI is actually made of (path builders, the task-id derivation, step ordering, the
// chip/label selectors, the skills reducer). The pure half has zero DOM and zero
// network so it is unit-testable under `node --experimental-strip-types`.
//
// Token pattern is cloned verbatim from inboxClient.ts / kpiClient.ts: same
// same-origin runtime token, same x-runtime-token header, same runtimeUrl() base so
// it works dev-proxied AND packaged.
//
// HONESTY RULES ENFORCED HERE:
//   • `permChipFor` returns null unless a REAL non-default override exists — the card
//     chip is never rendered from a guess, and inheriting the global is not a chip.
//   • `latestTaskIdFor` returns null when the agent has no engine task at all. The
//     Loop section then renders its empty state; a task id is NEVER invented.
//   • `quotaPct` returns null (not 0) when the window has no usable max — an unknown
//     meter reads as unknown, never as "empty".
import { runtimeToken, runtimeUrl } from "./runtimeBase.ts";
import { PERMISSION_MODES, type PermissionMode } from "./agentModes.ts";

// ── wire types — mirror agent-runtime/server.mjs (P1–P4) exactly ──────────────

/** Re-export so station consumers need one import, not two. */
export type PermMode = PermissionMode;
export const PERM_MODES = PERMISSION_MODES;

/** GET /runtime/:agentId/perm-mode. `permMode` is the OVERRIDE (null ⇒ inherits global). */
export interface PermModeDoc {
  agentId: string;
  permMode: PermMode | null;
  /** The runtime-wide mode the override falls back to. Absent on the PUT response. */
  global?: PermMode;
  effective: PermMode;
}

export interface SkillRef {
  id: string;
  label: string;
  desc: string;
}

/** GET /runtime/:agentId/skills. */
export interface SkillsDoc {
  agentId: string;
  skills: string[];
  catalog: SkillRef[];
  error?: string;
}

/** GET/PUT /runtime/:agentId/memory. The PUT response carries `size` only. */
export interface MemoryDoc {
  agentId: string;
  memory?: string;
  size: number;
  max?: number;
  error?: string;
}

/** The read-only guard block behind GET /runtime/:agentId/hooks. */
export interface StationHooks {
  permMode: { effective: PermMode; enginePinned: string };
  toolsMode: string;
  secretScrub: { active: boolean; layers: string[] };
  applyDeny: { active: boolean; pattern: string };
  configGuard: { active: boolean };
  quota: { used: number; max: number; windowMs: number };
}

export interface HooksDoc {
  agentId: string;
  hooks: StationHooks;
}

/** The five loop-step kinds emitted by agent-runtime/loop-steps.mjs. */
export const LOOP_STEP_KINDS = ["think", "tool", "observe", "result", "subagent"] as const;
export type LoopStepKind = (typeof LOOP_STEP_KINDS)[number];

export interface LoopStep {
  seq: number;
  agentId: string;
  kind: LoopStepKind | string;
  tool: string;
  summary: string;
  ts: string | number;
}

export interface LoopStepsDoc {
  taskId: string;
  steps: LoopStep[];
  error?: string;
}

/**
 * One task row from GET /runtime/engine/runs, narrowed to the fields the taskId
 * derivation actually reads. The endpoint returns more; extra keys are ignored.
 */
export interface EngineTask {
  taskId: string;
  agentId: string;
  status: string;
  engineState?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface EngineRunsDoc {
  tasks: EngineTask[];
}

// ── route builders (pure) ────────────────────────────────────────────────────
const seg = (agentId: string) => encodeURIComponent(String(agentId));

export const permModePath = (agentId: string): string => `/runtime/${seg(agentId)}/perm-mode`;
export const skillsPath = (agentId: string): string => `/runtime/${seg(agentId)}/skills`;
export const memoryPath = (agentId: string): string => `/runtime/${seg(agentId)}/memory`;
export const hooksPath = (agentId: string): string => `/runtime/${seg(agentId)}/hooks`;
export const ENGINE_RUNS_PATH = "/runtime/engine/runs";

/** GET /runtime/engine/steps?taskId=… — the server rejects anything but `task_<hex>`. */
export const stepsPath = (taskId: string): string =>
  `/runtime/engine/steps?taskId=${encodeURIComponent(String(taskId))}`;

// ── perm-mode selectors (pure) ───────────────────────────────────────────────
const PERM_SET = new Set<string>(PERMISSION_MODES);

/** True only for a real server permission mode. */
export function isPermMode(v: unknown): v is PermMode {
  return typeof v === "string" && PERM_SET.has(v);
}

/** Sentence-case labels for the segmented control. */
export const PERM_LABEL: Record<PermMode, string> = {
  default: "Ask first",
  acceptEdits: "Accept edits",
  bypassPermissions: "Bypass",
};

/** The one-word mono form the card chip uses (density: 9–10px). */
export const PERM_CHIP_LABEL: Record<PermMode, string> = {
  default: "ask",
  acceptEdits: "edits",
  bypassPermissions: "bypass",
};

export const PERM_HINT: Record<PermMode, string> = {
  default: "Prompt before every tool call",
  acceptEdits: "Auto-accept edits, prompt for other tools",
  bypassPermissions: "No permission prompts at all",
};

/**
 * The card chip. Rendered ONLY for a real non-default override — inheriting the
 * global mode is not a chip, and an unknown/absent value is not a chip either. The
 * `bypassPermissions` tone reuses the EXISTING danger/amber token; nothing new.
 */
export function permChipFor(override: PermMode | null | undefined): { label: string; tone: string } | null {
  if (!isPermMode(override) || override === "default") return null;
  return {
    label: PERM_CHIP_LABEL[override],
    tone: override === "bypassPermissions" ? "blocked-amber" : "accent-cyan",
  };
}

/** The only mode that needs a second, deliberate tap before it is sent. */
export const isDangerMode = (m: PermMode): boolean => m === "bypassPermissions";

// ── loop steps (pure) ────────────────────────────────────────────────────────

/**
 * Order a step list oldest → newest by `seq`, dropping duplicate seqs (a replayed
 * frame + a re-fetch can overlap) and any row without a usable seq. Ascending on
 * purpose: the stream reads like a transcript and the view scrolls to the bottom.
 */
export function sortSteps(steps: readonly LoopStep[]): LoopStep[] {
  if (!Array.isArray(steps)) return [];
  const bySeq = new Map<number, LoopStep>();
  for (const s of steps) {
    const n = Number(s?.seq);
    if (!Number.isFinite(n)) continue;
    bySeq.set(n, s); // last write wins — a re-fetch is more authoritative than a replay
  }
  return [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);
}

/** Claude's own sub-agent spawn (Task/Agent tool) — indented, own accent. */
export const isSubagentStep = (s: LoopStep): boolean => s?.kind === "subagent";

/** Short label for a step kind; unknown kinds pass through rather than vanish. */
export function stepKindLabel(kind: string): string {
  return String(kind ?? "").trim() || "step";
}

// ── task-id derivation (pure) ────────────────────────────────────────────────
// Activity rank over agent-runtime/queue.mjs statuses. Non-terminal work outranks a
// finished run, so the Loop section shows what the station is doing NOW; among equals
// the most recently touched task wins.
const STATUS_RANK: Record<string, number> = { claimed: 3, held: 2, queued: 1 };
const rankOf = (t: EngineTask) => STATUS_RANK[String(t?.status)] ?? 0;
const timeOf = (t: EngineTask) => {
  const u = Date.parse(String(t?.updatedAt ?? ""));
  if (!Number.isNaN(u)) return u;
  const c = Date.parse(String(t?.createdAt ?? ""));
  return Number.isNaN(c) ? 0 : c;
};

/**
 * The station's current-or-last engine task, or NULL when it has none. Null is the
 * honest answer that drives the Loop empty state — a task id is never fabricated, and
 * a malformed id is dropped rather than sent to a server that would 400 it.
 */
export function latestTaskIdFor(tasks: readonly EngineTask[] | undefined, agentId: string): string | null {
  if (!Array.isArray(tasks) || !agentId) return null;
  const mine = tasks.filter(
    (t) => t && t.agentId === agentId && /^task_[0-9a-f]{6,}$/i.test(String(t.taskId ?? "")),
  );
  if (!mine.length) return null;
  let best = mine[0];
  for (const t of mine.slice(1)) {
    const dr = rankOf(t) - rankOf(best);
    if (dr > 0) { best = t; continue; }
    if (dr < 0) continue;
    const dt = timeOf(t) - timeOf(best);
    if (dt > 0) { best = t; continue; }
    // Fully tied (same rank, same/absent timestamps) → highest id, so the choice is
    // deterministic across re-fetches rather than dependent on server array order.
    if (dt === 0 && String(t.taskId) > String(best.taskId)) best = t;
  }
  return best.taskId;
}

// ── skills (pure) ────────────────────────────────────────────────────────────
/** agent-runtime/station-skills.mjs MAX_SKILLS — the server 400s past this. */
export const MAX_STATION_SKILLS = 12;

/**
 * Attach/detach one skill, returning a NEW list. At the cap an attach is a no-op
 * (the picker disables at the cap too) so the client never sends a list the server
 * would reject — a silent 400 would look like a lost click.
 */
export function toggleSkill(list: readonly string[], id: string, max = MAX_STATION_SKILLS): string[] {
  const cur = Array.isArray(list) ? list : [];
  if (!id) return [...cur];
  if (cur.includes(id)) return cur.filter((s) => s !== id);
  if (cur.length >= max) return [...cur];
  return [...cur, id];
}

/** Catalog entries not yet attached, in catalog order. */
export function attachableSkills(catalog: readonly SkillRef[], attached: readonly string[]): SkillRef[] {
  const have = new Set(attached ?? []);
  return (catalog ?? []).filter((s) => s && !have.has(s.id));
}

/** Resolve an attached id to its catalog entry; unknown ids still render by id. */
export function skillLabel(catalog: readonly SkillRef[], id: string): string {
  return (catalog ?? []).find((s) => s.id === id)?.label || id;
}

// ── guards (pure) ────────────────────────────────────────────────────────────
/**
 * Quota fill 0..1, or NULL when the window has no usable max. Null renders as an
 * unknown meter — a fabricated 0% would read as "plenty of headroom".
 */
export function quotaPct(used: number, max: number): number | null {
  const u = Number(used);
  const m = Number(max);
  if (!Number.isFinite(u) || !Number.isFinite(m) || m <= 0 || u < 0) return null;
  return Math.min(1, u / m);
}

/** "5m" / "90s" / "2h" for the quota window. Non-finite input reads as "—". */
export function windowLabel(ms: number): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const s = Math.round(n / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

// ── memory (pure) ────────────────────────────────────────────────────────────
// CC-Primitives P6 — the Vault's station memory editor. GET /memory always carries a
// real `max` (server sends 8000); this is only the fallback until that first GET lands.
export const DEFAULT_MEMORY_MAX = 8000;

// The one generic string every approver-gated route in server.mjs returns on a 403
// (routeNeedsApprover). Not agentId-specific and not memory-specific — it is the same
// literal for perm-mode, skills, memory, vault writes, everything.
const APPROVER_REQUIRED_ERROR = "forbidden — approver role required";

/**
 * Friendly text for a memory PUT failure. The 403 gate string is an internal-reads-as
 * detail ("forbidden — approver role required"), so it maps to the sentence the panel
 * actually shows; every 400 body from station-memory.mjs (invalid id / not a string /
 * over cap) is already written for a human and passes through untouched.
 */
export function memoryErrorMessage(raw: string | null | undefined): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s === APPROVER_REQUIRED_ERROR) return "approver seat required";
  return s || "could not save — the server did not say why";
}

// ── fetchers (inboxClient.ts token pattern) ──────────────────────────────────
// 400 (invalid mode / unknown skill id / over cap) and 403 (viewer seat on a write)
// carry a JSON body the caller renders as an error state; every other non-2xx is a
// transport-level failure and throws.
const PASSTHROUGH = new Set([400, 403]);

async function authedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await runtimeToken();
  const r = await fetch(runtimeUrl(path), {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", "x-runtime-token": token, ...(init.headers || {}) },
  });
  if (!r.ok && !PASSTHROUGH.has(r.status)) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** GET /runtime/:agentId/perm-mode */
export const getPermMode = (agentId: string) =>
  authedJson<PermModeDoc & { error?: string }>(permModePath(agentId));

/** PUT /runtime/:agentId/perm-mode {permissionMode} — approver-gated. */
export const putPermMode = (agentId: string, permissionMode: PermMode) =>
  authedJson<PermModeDoc & { error?: string; valid?: string[] }>(permModePath(agentId), {
    method: "PUT",
    body: JSON.stringify({ permissionMode }),
  });

/** GET /runtime/:agentId/skills */
export const getSkills = (agentId: string) => authedJson<SkillsDoc>(skillsPath(agentId));

/** PUT /runtime/:agentId/skills {skills} — replaces the whole list. Approver-gated. */
export const putSkills = (agentId: string, skills: readonly string[]) =>
  authedJson<{ agentId?: string; skills?: string[]; error?: string }>(skillsPath(agentId), {
    method: "PUT",
    body: JSON.stringify({ skills: [...skills] }),
  });

/** GET /runtime/:agentId/memory */
export const getMemory = (agentId: string) => authedJson<MemoryDoc>(memoryPath(agentId));

/** PUT /runtime/:agentId/memory {memory} — the server scrubs BEFORE it stores. */
export const putMemory = (agentId: string, memory: string) =>
  authedJson<MemoryDoc>(memoryPath(agentId), {
    method: "PUT",
    body: JSON.stringify({ memory }),
  });

/** GET /runtime/:agentId/hooks — read-only by design; there is no write route. */
export const getHooks = (agentId: string) => authedJson<HooksDoc>(hooksPath(agentId));

/** GET /runtime/engine/steps?taskId=… */
export const getLoopSteps = (taskId: string) => authedJson<LoopStepsDoc>(stepsPath(taskId));

/** GET /runtime/engine/runs — the only source the Loop taskId is derived from. */
export const getEngineRuns = () => authedJson<EngineRunsDoc>(ENGINE_RUNS_PATH);
