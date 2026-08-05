// CC-Primitives P5 — stationClient: the pure layer (path builders, task-id derivation,
// step ordering, chip/label selectors, the skills reducer, the quota meter) plus the
// URL/verb/body contract of every fetcher, exercised against a stubbed global fetch.
// Zero DOM, so it runs under `node --experimental-strip-types`.
//
// These pin the honest-numbers contract at the client edge: no fabricated task id, no
// chip without a real override, and an unknown quota renders unknown (never 0%).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MEMORY_MAX,
  ENGINE_RUNS_PATH,
  MAX_STATION_SKILLS,
  PERM_CHIP_LABEL,
  attachableSkills,
  getEngineRuns,
  getHooks,
  getLoopSteps,
  getMemory,
  getPermMode,
  getSkills,
  hooksPath,
  isDangerMode,
  isPermMode,
  isSubagentStep,
  latestTaskIdFor,
  memoryErrorMessage,
  memoryPath,
  permChipFor,
  permModePath,
  putMemory,
  putPermMode,
  putSkills,
  quotaPct,
  skillLabel,
  skillsPath,
  sortSteps,
  stepsPath,
  toggleSkill,
  windowLabel,
  type EngineTask,
  type LoopStep,
  type SkillRef,
} from "../stationClient.ts";

// ── path builders ────────────────────────────────────────────────────────────
test("path builders hit the exact gated routes the runtime serves", () => {
  assert.equal(permModePath("ceo"), "/runtime/ceo/perm-mode");
  assert.equal(skillsPath("ceo"), "/runtime/ceo/skills");
  assert.equal(memoryPath("ceo"), "/runtime/ceo/memory");
  assert.equal(hooksPath("ceo"), "/runtime/ceo/hooks");
  assert.equal(ENGINE_RUNS_PATH, "/runtime/engine/runs");
});

test("path builders encode an agent id rather than splicing it raw into the path", () => {
  assert.equal(permModePath("a/b"), "/runtime/a%2Fb/perm-mode");
  assert.equal(skillsPath("../etc"), "/runtime/..%2Fetc/skills");
});

test("stepsPath puts the task id in the query the server actually reads", () => {
  assert.equal(stepsPath("task_abc123"), "/runtime/engine/steps?taskId=task_abc123");
  assert.equal(stepsPath("a b"), "/runtime/engine/steps?taskId=a%20b");
});

// ── perm-mode selectors ──────────────────────────────────────────────────────
test("isPermMode accepts only the three server modes", () => {
  assert.equal(isPermMode("default"), true);
  assert.equal(isPermMode("acceptEdits"), true);
  assert.equal(isPermMode("bypassPermissions"), true);
  assert.equal(isPermMode("plan"), false, "plan is UI-only and must never be sent");
  assert.equal(isPermMode(null), false);
  assert.equal(isPermMode(undefined), false);
});

test("permChipFor renders a chip ONLY for a real non-default override", () => {
  assert.equal(permChipFor(null), null, "inheriting the global is not a chip");
  assert.equal(permChipFor(undefined), null, "unknown is not a chip");
  assert.equal(permChipFor("default"), null, "an override equal to the safe default is not a chip");
  assert.deepEqual(permChipFor("acceptEdits"), { label: PERM_CHIP_LABEL.acceptEdits, tone: "accent-cyan" });
});

test("permChipFor puts bypass on the EXISTING danger/amber token", () => {
  assert.deepEqual(permChipFor("bypassPermissions"), { label: PERM_CHIP_LABEL.bypassPermissions, tone: "blocked-amber" });
});

test("isDangerMode flags bypass alone", () => {
  assert.equal(isDangerMode("bypassPermissions"), true);
  assert.equal(isDangerMode("acceptEdits"), false);
  assert.equal(isDangerMode("default"), false);
});

// ── loop steps ───────────────────────────────────────────────────────────────
const step = (seq: number, kind = "think", tool = ""): LoopStep => ({
  seq, kind, tool, agentId: "ceo", summary: `s${seq}`, ts: 1_700_000_000_000 + seq,
});

test("sortSteps orders oldest → newest by seq", () => {
  const out = sortSteps([step(3), step(1), step(2)]);
  assert.deepEqual(out.map((s) => s.seq), [1, 2, 3]);
});

test("sortSteps drops duplicate seqs, keeping the later (re-fetched) row", () => {
  const replayed = { ...step(2), summary: "stale" };
  const refetched = { ...step(2), summary: "fresh" };
  const out = sortSteps([replayed, step(1), refetched]);
  assert.deepEqual(out.map((s) => s.seq), [1, 2]);
  assert.equal(out[1].summary, "fresh");
});

test("sortSteps discards rows without a usable seq rather than reordering around them", () => {
  const bad = { ...step(1), seq: Number.NaN };
  assert.deepEqual(sortSteps([bad, step(5)]).map((s) => s.seq), [5]);
  assert.deepEqual(sortSteps([] as LoopStep[]), []);
});

test("isSubagentStep identifies the Task/Agent spawn kind", () => {
  assert.equal(isSubagentStep(step(1, "subagent")), true);
  assert.equal(isSubagentStep(step(1, "tool")), false);
});

// ── task-id derivation ───────────────────────────────────────────────────────
const task = (taskId: string, agentId: string, status: string, updatedAt?: string): EngineTask => ({
  taskId, agentId, status, updatedAt,
});

test("latestTaskIdFor returns null when the station has no engine task — never invents one", () => {
  assert.equal(latestTaskIdFor([], "ceo"), null);
  assert.equal(latestTaskIdFor(undefined, "ceo"), null);
  assert.equal(latestTaskIdFor([task("task_aaa111", "architect", "claimed")], "ceo"), null);
});

test("latestTaskIdFor ignores rows whose id the steps endpoint would reject", () => {
  assert.equal(latestTaskIdFor([task("goal_123", "ceo", "claimed")], "ceo"), null);
  assert.equal(latestTaskIdFor([task("task_zz", "ceo", "claimed")], "ceo"), null, "too short / non-hex");
});

// Ids are hex on purpose — `task_<hex>` is the only shape the steps endpoint accepts.
test("latestTaskIdFor prefers live work over a finished run", () => {
  const tasks = [
    task("task_fee001", "ceo", "done", "2026-08-04T10:00:00Z"), // finished, newer
    task("task_add001", "ceo", "claimed", "2026-08-04T09:00:00Z"), // running, older
  ];
  assert.equal(latestTaskIdFor(tasks, "ceo"), "task_add001", "an older running task still outranks a newer finished one");
});

test("latestTaskIdFor ranks claimed > held > queued", () => {
  const tasks = [
    task("task_c0ffee", "ceo", "queued", "2026-08-04T12:00:00Z"),
    task("task_deadbe", "ceo", "held", "2026-08-04T11:00:00Z"),
    task("task_abcdef", "ceo", "claimed", "2026-08-04T10:00:00Z"),
  ];
  assert.equal(latestTaskIdFor(tasks, "ceo"), "task_abcdef");
});

test("latestTaskIdFor breaks a rank tie on the most recently touched task", () => {
  const tasks = [
    task("task_0a0001", "ceo", "done", "2026-08-04T08:00:00Z"),
    task("task_0b0002", "ceo", "done", "2026-08-04T18:00:00Z"),
  ];
  assert.equal(latestTaskIdFor(tasks, "ceo"), "task_0b0002");
});

test("latestTaskIdFor falls back to createdAt, then to a deterministic id", () => {
  assert.equal(
    latestTaskIdFor(
      [
        { taskId: "task_c00001", agentId: "ceo", status: "done", createdAt: "2026-08-04T01:00:00Z" },
        { taskId: "task_c00002", agentId: "ceo", status: "done", createdAt: "2026-08-04T02:00:00Z" },
      ],
      "ceo",
    ),
    "task_c00002",
  );
  // Fully tied (no timestamps at all) → highest id, so re-fetches agree regardless of
  // the order the server happened to return the array in.
  assert.equal(
    latestTaskIdFor([task("task_bbb222", "ceo", "done"), task("task_aaa111", "ceo", "done")], "ceo"),
    "task_bbb222",
  );
});

// ── skills reducer ───────────────────────────────────────────────────────────
const cat: SkillRef[] = [
  { id: "research", label: "Research", desc: "web + docs" },
  { id: "writing", label: "Writing", desc: "long form" },
];

test("toggleSkill attaches and detaches immutably", () => {
  const a: string[] = [];
  const b = toggleSkill(a, "research");
  assert.deepEqual(b, ["research"]);
  assert.deepEqual(a, [], "the input list is never mutated");
  assert.deepEqual(toggleSkill(b, "research"), []);
});

test("toggleSkill refuses to exceed the server cap rather than sending a 400", () => {
  const full = Array.from({ length: MAX_STATION_SKILLS }, (_, i) => `s${i}`);
  assert.deepEqual(toggleSkill(full, "one-more"), full, "an attach at the cap is a no-op");
  assert.equal(toggleSkill(full, "s0").length, MAX_STATION_SKILLS - 1, "a detach at the cap still works");
});

test("toggleSkill ignores an empty id", () => {
  assert.deepEqual(toggleSkill(["a"], ""), ["a"]);
});

test("attachableSkills lists only the catalog entries not already attached", () => {
  assert.deepEqual(attachableSkills(cat, ["research"]).map((s) => s.id), ["writing"]);
  assert.deepEqual(attachableSkills(cat, []).map((s) => s.id), ["research", "writing"]);
});

test("skillLabel resolves via the catalog and falls back to the raw id", () => {
  assert.equal(skillLabel(cat, "research"), "Research");
  assert.equal(skillLabel(cat, "mystery"), "mystery", "an uncataloged id still renders, never blank");
});

// ── guards ───────────────────────────────────────────────────────────────────
test("quotaPct returns a clamped fill for a real window", () => {
  assert.equal(quotaPct(0, 10), 0);
  assert.equal(quotaPct(5, 10), 0.5);
  assert.equal(quotaPct(20, 10), 1, "over-cap clamps rather than overflowing the bar");
});

test("quotaPct returns null — not 0 — when the window is unusable", () => {
  assert.equal(quotaPct(1, 0), null);
  assert.equal(quotaPct(1, -5), null);
  assert.equal(quotaPct(Number.NaN, 10), null);
  assert.equal(quotaPct(-1, 10), null);
});

test("windowLabel renders seconds/minutes/hours, and — for nonsense", () => {
  assert.equal(windowLabel(30_000), "30s");
  assert.equal(windowLabel(300_000), "5m");
  assert.equal(windowLabel(7_200_000), "2h");
  assert.equal(windowLabel(0), "—");
  assert.equal(windowLabel(Number.NaN), "—");
});

// ── memory (CC-Primitives P6) ─────────────────────────────────────────────────
test("DEFAULT_MEMORY_MAX mirrors the server's station-memory.mjs MEMORY_MAX", () => {
  assert.equal(DEFAULT_MEMORY_MAX, 8000);
});

test("memoryErrorMessage maps the generic approver-gate 403 to a station-memory sentence", () => {
  assert.equal(memoryErrorMessage("forbidden — approver role required"), "approver seat required");
});

test("memoryErrorMessage passes a real 400 body through untouched", () => {
  assert.equal(memoryErrorMessage("memory too long (max 8000 chars)"), "memory too long (max 8000 chars)");
  assert.equal(memoryErrorMessage("invalid agentId"), "invalid agentId");
});

test("memoryErrorMessage never renders blank on a malformed/missing body", () => {
  assert.equal(memoryErrorMessage(""), "could not save — the server did not say why");
  assert.equal(memoryErrorMessage(undefined), "could not save — the server did not say why");
  assert.equal(memoryErrorMessage(null), "could not save — the server did not say why");
  assert.equal(memoryErrorMessage("   "), "could not save — the server did not say why");
});

// ── fetchers: URL + verb + body contract ─────────────────────────────────────
interface Call { url: string; method: string; body: string | undefined; headers: Record<string, string> }

function stubFetch(status = 200, payload: unknown = {}): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = mock.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    // The token fetch is an internal detail of runtimeBase; record only station calls.
    if (!url.startsWith("/api/")) {
      calls.push({
        url,
        method: String(init.method ?? "GET"),
        body: typeof init.body === "string" ? init.body : undefined,
        headers: (init.headers ?? {}) as Record<string, string>,
      });
    }
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test("every GET fetcher reads its own route with GET", async () => {
  const f = stubFetch(200, {});
  try {
    await getPermMode("ceo");
    await getSkills("ceo");
    await getMemory("ceo");
    await getHooks("ceo");
    await getLoopSteps("task_abc123");
    await getEngineRuns();
  } finally {
    f.restore();
  }
  assert.deepEqual(
    f.calls.map((c) => `${c.method} ${c.url}`),
    [
      "GET /runtime/ceo/perm-mode",
      "GET /runtime/ceo/skills",
      "GET /runtime/ceo/memory",
      "GET /runtime/ceo/hooks",
      "GET /runtime/engine/steps?taskId=task_abc123",
      "GET /runtime/engine/runs",
    ],
  );
});

test("putPermMode PUTs the permissionMode the server's allowlist expects", async () => {
  const f = stubFetch(200, { agentId: "ceo", permMode: "acceptEdits", effective: "acceptEdits" });
  try {
    await putPermMode("ceo", "acceptEdits");
  } finally {
    f.restore();
  }
  assert.equal(f.calls[0].method, "PUT");
  assert.equal(f.calls[0].url, "/runtime/ceo/perm-mode");
  assert.deepEqual(JSON.parse(f.calls[0].body ?? "{}"), { permissionMode: "acceptEdits" });
});

test("putSkills PUTs the WHOLE list (the route replaces, it does not append)", async () => {
  const f = stubFetch(200, { agentId: "ceo", skills: ["research"] });
  try {
    await putSkills("ceo", ["research"]);
  } finally {
    f.restore();
  }
  assert.equal(f.calls[0].method, "PUT");
  assert.deepEqual(JSON.parse(f.calls[0].body ?? "{}"), { skills: ["research"] });
});

test("putMemory PUTs the raw text — the runtime owns the scrub", async () => {
  const f = stubFetch(200, { agentId: "ceo", size: 4 });
  try {
    await putMemory("ceo", "note");
  } finally {
    f.restore();
  }
  assert.equal(f.calls[0].method, "PUT");
  assert.equal(f.calls[0].url, "/runtime/ceo/memory");
  assert.deepEqual(JSON.parse(f.calls[0].body ?? "{}"), { memory: "note" });
});

test("every station call carries the runtime-token header", async () => {
  const f = stubFetch(200, {});
  try {
    await getHooks("ceo");
  } finally {
    f.restore();
  }
  assert.ok("x-runtime-token" in f.calls[0].headers, "the gated routes reject an unauthenticated read");
});

test("a 400 body is returned to the caller, but a 500 throws", async () => {
  const bad = stubFetch(400, { error: "invalid permissionMode", valid: ["default"] });
  let r;
  try {
    r = await putPermMode("ceo", "acceptEdits");
  } finally {
    bad.restore();
  }
  assert.equal(r?.error, "invalid permissionMode", "a validation body must reach the UI, not throw");

  const boom = stubFetch(500, {});
  try {
    await assert.rejects(() => getHooks("ceo"), /HTTP 500/);
  } finally {
    boom.restore();
  }
});
