// Story-Pipeline S1 — the story core store: migration v15, the CLOSED 8-stage machine
// (forward advance + reject-to-enumerated-back-stage), per-story-monotonic transition
// log, scrub-at-rest + on egress, length caps, and emit-on-persist `story.changed`.
//
// The HTTP surface (auth gates, 400/404/409 verdicts, SSE) is proven in
// stories-http.test.mjs. This file pins the pure store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.mjs";
import {
  createStories,
  STORY_STAGES,
  STORY_STATUSES,
  STORY_BACK,
  MAX_STORY_TITLE,
  MAX_STORY_IDEA,
} from "../stories.mjs";

const SECRET_RE = /sk-ant-[A-Za-z0-9_-]{6,}/g;
const scrub = (s) => (typeof s === "string" ? s.replace(SECRET_RE, "[redacted-secret]") : s);

// Run fn, return the error it threw (assert.throws itself returns undefined, so it
// cannot assert on the thrown error's .status code — this can).
function grab(fn) {
  try { fn(); } catch (e) { return e; }
  throw new assert.AssertionError({ message: "expected the call to throw, but it did not" });
}

function harness(over = {}) {
  const root = mkdtempSync(join(tmpdir(), "ma-stories-"));
  const h = openDb({ path: join(root, "data", "mission.db") });
  const events = { emitted: [], emit(name, data) { this.emitted.push({ name, data }); } };
  const s = createStories({ db: h.db, scrub, emit: (n, d) => events.emit(n, d), ...over });
  return { root, h, s, events, cleanup: () => { h.close(); rmSync(root, { recursive: true, force: true }); } };
}

// walk a story forward from its current stage to the terminal, returning the last story.
function advanceToTerminal(s, id) {
  let story = s.getStory(id);
  while (story.stage !== STORY_STAGES[STORY_STAGES.length - 1]) {
    story = s.advance(id, {});
  }
  return story;
}

// ── migration v15 ─────────────────────────────────────────────────────────────
test("db reaches v19 and the stories + story_log tables exist with the right columns", () => {
  const { h, cleanup } = harness();
  try {
    assert.ok(h.version() >= 19, `expected >= v19, got ${h.version()}`);
    const scols = h.db.prepare("PRAGMA table_info(stories)").all().map((c) => c.name).sort();
    assert.deepEqual(scols, ["answers", "created_at", "design_ref", "id", "idea", "spec", "stage", "status", "title", "updated_at", "venture"]);
    // AUTONOMY PHASE 3 (v19) — the four structured-handback columns. ADD COLUMN only, so
    // every pre-v19 row survives with NULLs, which is the honest value for a transition
    // that never carried them.
    const lcols = h.db.prepare("PRAGMA table_info(story_log)").all().map((c) => c.name).sort();
    assert.deepEqual(lcols, ["by_agent", "event", "evidence", "from_stage", "ref", "seq", "stage", "story_id", "to_agent", "ts"]);
  } finally { cleanup(); }
});

test("the stage CHECK constraint refuses a stage outside the closed enum", () => {
  const { h, cleanup } = harness();
  try {
    assert.throws(
      () => h.db.prepare("INSERT INTO stories(id,title,idea,stage,status,created_at,updated_at) VALUES('x','t','i','not-a-stage','active',1,1)").run(),
      /CHECK/,
    );
  } finally { cleanup(); }
});

// ── create ────────────────────────────────────────────────────────────────────
test("createStory seeds stage 'idea' / status 'active', mints a story_ id, and logs seq 1 'create'", () => {
  const { s, events, cleanup } = harness();
  try {
    const story = s.createStory({ title: "Add dark mode", idea: "Users want a dark theme toggle." });
    assert.match(story.id, /^story_[0-9a-f]{16}$/, "server-minted unguessable id");
    assert.equal(story.stage, "idea");
    assert.equal(story.status, "active");
    assert.equal(story.title, "Add dark mode");
    assert.equal(story.spec, null);
    assert.equal(story.designRef, null);
    assert.equal(story.venture, "waahyu");
    assert.equal(typeof story.createdAt, "number");

    const log = s.getLog(story.id);
    assert.equal(log.length, 1);
    assert.deepEqual({ seq: log[0].seq, stage: log[0].stage, event: log[0].event }, { seq: 1, stage: "idea", event: "create" });

    const changed = events.emitted.filter((e) => e.name === "story.changed");
    assert.equal(changed.length, 1, "one story.changed on create");
    assert.deepEqual(changed[0].data, { id: story.id, stage: "idea" }, "identity-only payload");
  } finally { cleanup(); }
});

test("createStory rejects empty/whitespace title or idea with a 400 StoryError", () => {
  const { s, cleanup } = harness();
  try {
    for (const bad of [{ title: "", idea: "ok" }, { title: "   ", idea: "ok" }, { title: "ok", idea: "" }, { title: "ok", idea: "   " }, {}]) {
      const err = grab(() => s.createStory(bad));
      assert.equal(err.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
  } finally { cleanup(); }
});

test("createStory caps title at 200 and idea at 10000 chars (truncates, never rejects a long paste)", () => {
  const { s, cleanup } = harness();
  try {
    const story = s.createStory({ title: "T".repeat(500), idea: "I".repeat(50_000) });
    assert.equal(story.title.length, MAX_STORY_TITLE);
    assert.equal(story.idea.length, MAX_STORY_IDEA);
  } finally { cleanup(); }
});

test("createStory scrubs a secret-shaped idea AT REST (never persists the raw value)", () => {
  const { s, h, cleanup } = harness();
  try {
    const story = s.createStory({ title: "leak test", idea: "token is sk-ant-abcdef123456 do not store" });
    assert.ok(!story.idea.includes("sk-ant-abcdef123456"), "scrubbed on egress");
    const raw = h.db.prepare("SELECT idea FROM stories WHERE id = ?").get(story.id).idea;
    assert.ok(!raw.includes("sk-ant-abcdef123456"), "scrubbed AT REST — the raw row carries no secret");
    assert.ok(raw.includes("[redacted-secret]"));
  } finally { cleanup(); }
});

// ── reads ──────────────────────────────────────────────────────────────────────
test("getStory returns null for an unknown id; listStories filters by stage and status", () => {
  const { s, cleanup } = harness();
  try {
    assert.equal(s.getStory("story_deadbeefdeadbeef"), null);
    const a = s.createStory({ title: "A", idea: "idea a" });
    const b = s.createStory({ title: "B", idea: "idea b" });
    s.advance(b.id, {}); // b → requirements

    assert.equal(s.listStories({}).length, 2);
    assert.deepEqual(s.listStories({ stage: "idea" }).map((x) => x.id), [a.id]);
    assert.deepEqual(s.listStories({ stage: "requirements" }).map((x) => x.id), [b.id]);
    assert.equal(s.listStories({ status: "active" }).length, 2);
    assert.equal(s.listStories({ status: "shipped" }).length, 0);
  } finally { cleanup(); }
});

test("listStories throws 400 on an unknown stage or status filter", () => {
  const { s, cleanup } = harness();
  try {
    assert.equal(grab(() => s.listStories({ stage: "nope" })).status, 400);
    assert.equal(grab(() => s.listStories({ status: "nope" })).status, 400);
  } finally { cleanup(); }
});

// ── the full legal lifecycle ─────────────────────────────────────────────────
test("advance walks all 8 stages in order, lands on 'accept' as 'shipped', log seq stays monotonic", () => {
  const { s, cleanup } = harness();
  try {
    const story = s.createStory({ title: "ship it", idea: "the whole pipeline" });
    const seen = [story.stage];
    let cur = story;
    for (let i = 0; i < STORY_STAGES.length - 1; i += 1) {
      cur = s.advance(story.id, {});
      seen.push(cur.stage);
    }
    assert.deepEqual(seen, [...STORY_STAGES], "visited every stage in order");
    assert.equal(cur.stage, "accept");
    assert.equal(cur.status, "shipped", "landing on the terminal stage ships the story");

    const log = s.getLog(story.id);
    assert.equal(log.length, STORY_STAGES.length, "one log row per transition (create + 7 advances)");
    assert.deepEqual(log.map((r) => r.seq), log.map((_, i) => i + 1), "seq is 1..N monotonic, no gaps");
    assert.deepEqual(log.map((r) => r.stage), [...STORY_STAGES], "each row records the stage it landed on");
  } finally { cleanup(); }
});

test("advance records a custom event verb and an artifact ref", () => {
  const { s, cleanup } = harness();
  try {
    const story = s.createStory({ title: "t", idea: "i" });
    s.advance(story.id, { event: "requirements-drafted", ref: "vault:tech/req-1" });
    const last = s.getLog(story.id).at(-1);
    assert.deepEqual({ stage: last.stage, event: last.event, ref: last.ref }, { stage: "requirements", event: "requirements-drafted", ref: "vault:tech/req-1" });
  } finally { cleanup(); }
});

// ── illegal transitions throw 409 ────────────────────────────────────────────
test("advance from the terminal 'accept' stage throws 409", () => {
  const { s, cleanup } = harness();
  try {
    const story = s.createStory({ title: "t", idea: "i" });
    advanceToTerminal(s, story.id);
    assert.equal(grab(() => s.advance(story.id, {})).status, 409);
  } finally { cleanup(); }
});

test("advance / reject on an unknown id throw 404", () => {
  const { s, cleanup } = harness();
  try {
    assert.equal(grab(() => s.advance("story_0000000000000000", {})).status, 404);
    assert.equal(grab(() => s.reject("story_0000000000000000", { toStage: "idea" })).status, 404);
  } finally { cleanup(); }
});

// ── reject bounces to an enumerated earlier stage (rework, status active) ──────
test("reject bounces a story back to its enumerated back-stage and RESUMES it (status active)", () => {
  const { s, events, cleanup } = harness();
  try {
    const story = s.createStory({ title: "t", idea: "i" });
    s.advance(story.id, {}); // → requirements
    s.advance(story.id, {}); // → design
    const bounced = s.reject(story.id, { toStage: "requirements", reason: "spec is ambiguous" });
    assert.equal(bounced.stage, "requirements");
    assert.equal(bounced.status, "active", "a reject is a rework bounce, not a kill");

    const last = s.getLog(story.id).at(-1);
    assert.deepEqual({ stage: last.stage, event: last.event, ref: last.ref }, { stage: "requirements", event: "reject", ref: "spec is ambiguous" });

    const changed = events.emitted.filter((e) => e.name === "story.changed").at(-1);
    assert.deepEqual(changed.data, { id: story.id, stage: "requirements" });
  } finally { cleanup(); }
});

test("reject to an illegal target (forward, self, or unlisted earlier stage) throws 409", () => {
  const { s, cleanup } = harness();
  try {
    const story = s.createStory({ title: "t", idea: "i" });
    s.advance(story.id, {}); // → requirements
    s.advance(story.id, {}); // → design (STORY_BACK.design === ['requirements'])
    assert.equal(grab(() => s.reject(story.id, { toStage: "build" })).status, 409, "no forward jump");
    assert.equal(grab(() => s.reject(story.id, { toStage: "design" })).status, 409, "no self-bounce");
    assert.equal(grab(() => s.reject(story.id, { toStage: "idea" })).status, 409, "no unlisted earlier stage");
    assert.equal(grab(() => s.reject(story.id, { toStage: "not-a-stage" })).status, 409, "no unknown stage");
  } finally { cleanup(); }
});

test("reject at the intake stage 'idea' is illegal (no earlier stage) → 409", () => {
  const { s, cleanup } = harness();
  try {
    const story = s.createStory({ title: "t", idea: "i" });
    assert.equal(grab(() => s.reject(story.id, { toStage: "idea" })).status, 409);
    assert.equal(STORY_BACK.idea, undefined, "idea has no enumerated back-target");
  } finally { cleanup(); }
});

// ── enum integrity (the closed contract) ─────────────────────────────────────
test("STORY_STAGES is the 8-stage closed pipeline and STORY_STATUSES is the 5-value set", () => {
  assert.deepEqual([...STORY_STAGES], ["idea", "requirements", "design", "plan", "build", "review-qa", "deploy-watch", "accept"]);
  assert.deepEqual([...STORY_STATUSES], ["active", "waiting-you", "blocked", "shipped", "rejected"]);
  // every back-target is a real, strictly-earlier stage — no arbitrary jumps encoded
  for (const [from, targets] of Object.entries(STORY_BACK)) {
    for (const to of targets) {
      assert.ok(STORY_STAGES.indexOf(to) < STORY_STAGES.indexOf(from), `${from} → ${to} must be strictly earlier`);
    }
  }
});
