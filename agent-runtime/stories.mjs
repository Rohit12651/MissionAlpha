// Story-Pipeline S1 — the story core + its CLOSED stage machine.
//
// A Story is the unit of the SE team's SDLC: one idea walked from intake to accept
// through eight ordered stages. This module owns the PURE, CLOSED-ENUM stage logic +
// the durable story index + an append-only per-story transition log. It is the spine
// every later phase (S2 requirements/design, S3 plan/build, S4 gates, S5 ship+watch)
// hangs artifacts and gates off — so its invariants are load-bearing.
//
// It is deliberately NOT a workflow engine:
//   • stage is an 8-value ordered enum (STORY_STAGES) — never a caller string. A ninth
//     stage is a migration + an amendment, not a caller choice. advance() only ever
//     moves to the IMMEDIATE next stage; there is no skip-ahead. reject() only ever
//     moves to a stage's ENUMERATED earlier back-target (STORY_BACK) — no arbitrary
//     jump, forward or backward. Every transition throws a status-coded error on an
//     illegal move, so a crafted request produces a readable 409, never a silent write.
//   • status is a 5-value closed enum (STORY_STATUSES), CHECK-pinned in the schema.
//     S1's own writers only ever produce `active`, `shipped` (landing on the terminal
//     `accept` stage) and — on rework bounce — `active`. `waiting-you` (S2, a pending
//     clarify question), `blocked` (S3, N terminal build failures) and terminal
//     `rejected` (a BOSS abandon) are RESERVED for the phase that fills them — the
//     same disclosed-gap convention the SSE catalog uses for its reserved names.
//   • EVERY transition appends ONE story_log row with a per-story-monotonic seq, inside
//     the SAME transaction as the story-row write — the log can never disagree with the
//     row it describes.
//
// SECURITY (S1 is an intake phase — sr-security concern):
//   • UNTRUSTED intake text (title, idea) and transition metadata (event, ref, reason)
//     are scrubbed with the server's SHARED scrub AT REST and again on egress, and
//     LENGTH-CAPPED — a secret-shaped idea never persists, and an unbounded paste never
//     lands. No second SECRET_RE lives here.
//   • ids are SERVER-MINTED (`story_` + 8 random bytes = 64 bits) — never caller input,
//     so id can never widen a scope or spoof another story.
//   • Every statement is parameterized; this module interpolates nothing into SQL.
//   • emit-on-persist: the function that writes the story is the function that emits
//     `story.changed` — identity only ({id, stage}); the title/idea/spec stay behind
//     the auth-gated GET, mirroring the vault.written / loop.step rationale (a bus
//     frame reaches every connected seat).

import { randomBytes } from "node:crypto";

/**
 * The CLOSED, ORDERED stage machine (locked concept, 2026-08-04): Idea → Requirements
 * → Design → Plan → Build → Review+QA → Deploy+Watch → Accept. Order IS the forward
 * advance: advance() moves stage[i] → stage[i+1] and nothing else. `accept` is the
 * terminal — advancing from it is illegal (there is no i+1).
 */
export const STORY_STAGES = Object.freeze([
  "idea",
  "requirements",
  "design",
  "plan",
  "build",
  "review-qa",
  "deploy-watch",
  "accept",
]);
const STAGE_SET = new Set(STORY_STAGES);
const TERMINAL_STAGE = STORY_STAGES[STORY_STAGES.length - 1]; // 'accept'
const FIRST_STAGE = STORY_STAGES[0]; // 'idea'

/**
 * The CLOSED reject map: for each stage, the ENUMERATED earlier stage(s) a reject may
 * bounce a story back to for rework. A reject to any stage NOT listed here is a 409 —
 * there are no arbitrary back-jumps. `idea` has no earlier stage, so it is absent (a
 * reject at intake is illegal). Each entry is an array so a later phase can widen a
 * stage's legal targets (e.g. S5's release gate) with a data change, not a rule change.
 */
export const STORY_BACK = Object.freeze({
  requirements: Object.freeze(["idea"]),
  design: Object.freeze(["requirements"]),
  plan: Object.freeze(["design"]),
  build: Object.freeze(["plan"]),
  "review-qa": Object.freeze(["build"]),
  "deploy-watch": Object.freeze(["review-qa"]),
  accept: Object.freeze(["deploy-watch"]),
});

/**
 * The CLOSED status set (CHECK-pinned in migration v15). See the header for which
 * phase owns each value; S1 writes only `active` and `shipped`.
 */
export const STORY_STATUSES = Object.freeze([
  "active",       // in flight
  "waiting-you",  // RESERVED (S2) — a clarify question is pending the BOSS
  "blocked",      // RESERVED (S3) — build failed past the retry budget
  "shipped",      // reached the terminal `accept` stage
  "rejected",     // RESERVED (S5) — a BOSS abandon (terminal)
]);

// Length caps. title/idea are the only intake fields S1 sets; the rest are here so the
// caps are ONE source of truth as later phases fill spec/answers/etc.
export const MAX_STORY_TITLE = 200;
export const MAX_STORY_IDEA = 10_000;
export const MAX_STORY_SPEC = 32_768;
export const MAX_STORY_ANSWERS = 32_768;
const MAX_EVENT = 64;   // a short transition verb ('advance', 'requirements-drafted', …)
const MAX_REF = 512;    // an artifact ref / reason line — a pointer, never a document
const DEFAULT_VENTURE = "waahyu";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
// PHASE 3 — handback caps. Untrusted agent text, so bounded in BOTH dimensions: a long
// array of long strings is the same unbounded-paste problem as one long string.
const MAX_AGENT_ID = 64;
const MAX_EVIDENCE = 10;
const MAX_EVIDENCE_ITEM = 200;

// Strip C0/C1 control chars (preserving tab/newline/CR — an idea is a document) before
// scrub+cap, exactly as vault.mjs does — a stray control char corrupts what a human reads.
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

// A status-coded error the route maps straight to an HTTP code (400 bad input, 404
// unknown id, 409 illegal transition). Carrying the code on the error keeps the store
// the single source of the verdict while advance()/reject() stay "throws on illegal".
class StoryError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "StoryError";
    this.status = status;
  }
}
const bad = (m) => new StoryError(400, m);
const missing = (m) => new StoryError(404, m);
const illegal = (m) => new StoryError(409, m);

export function createStories(deps = {}) {
  const db = deps.db;
  if (!db || typeof db.prepare !== "function") throw new Error("createStories: raw db handle required");
  const scrub = typeof deps.scrub === "function" ? deps.scrub : (s) => s;
  const emit = typeof deps.emit === "function" ? deps.emit : () => {};
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  // PHASE 3 TASK 3.1 — the rework-dispatch seam. Fired after a reject COMMITS, with the
  // structured handback. Optional: unset ⇒ pre-Phase-3 behaviour exactly (the story bounces
  // and nothing is dispatched), which is what every existing unit test builds.
  const onHandback = typeof deps.onHandback === "function" ? deps.onHandback : null;
  const log = typeof deps.log === "function" ? deps.log : (m) => console.warn(m);

  // SHARED scrub, then cap — scrub-at-rest AND on egress, exactly like vault.mjs. A
  // secret-shaped idea is redacted before it lands, and a re-emitted secret cannot
  // straddle the cut because the scrub runs BEFORE the slice.
  const clean = (s, cap) => scrub(String(s ?? "").replace(CTRL, "")).slice(0, cap);
  // Egress scrub for a value already capped at rest (belt AND braces — a secret added
  // to the live scrub set AFTER a row was written is still redacted on the way out).
  const out = (s) => (s === null || s === undefined ? null : scrub(String(s)));

  const insStory = db.prepare(
    `INSERT INTO stories(id, title, idea, spec, design_ref, stage, status, answers, venture, created_at, updated_at)
     VALUES(@id, @title, @idea, @spec, @design_ref, @stage, @status, @answers, @venture, @ts, @ts)`,
  );
  const getStoryStmt = db.prepare("SELECT * FROM stories WHERE id = ?");
  const updStageStmt = db.prepare("UPDATE stories SET stage = ?, status = ?, updated_at = ? WHERE id = ?");
  // S2 — the pipeline's in-stage field write (spec/design_ref/answers/status), stage UNCHANGED.
  const updFieldsStmt = db.prepare(
    "UPDATE stories SET status = ?, spec = ?, design_ref = ?, answers = ?, updated_at = ? WHERE id = ?",
  );
  const maxSeqStmt = db.prepare("SELECT MAX(seq) s FROM story_log WHERE story_id = ?");
  // PHASE 3 (migration v19) — the structured handback rides the SAME row. A second log
  // would be a second story about one transition, and the two would eventually disagree.
  const insLog = db.prepare(
    `INSERT INTO story_log(story_id, seq, stage, event, ref, ts, from_stage, by_agent, to_agent, evidence)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const listLogStmt = db.prepare(
    `SELECT seq, stage, event, ref, ts, from_stage, by_agent, to_agent, evidence
     FROM story_log WHERE story_id = ? ORDER BY seq ASC`,
  );
  // PHASE 3 TASK 3.2 — the rework counter is READ FROM THE LOG, not held in memory. The
  // review gate's existing budget lives in a Map that empties on restart, so a story could
  // bounce forever across restarts and the cap would never bite. The log is durable and is
  // already the record of every transition, so counting it is both honest and free.
  const countReworkStmt = db.prepare(
    "SELECT COUNT(*) n FROM story_log WHERE story_id = ? AND event = 'reject' AND stage = ?",
  );

  const newId = () => `story_${randomBytes(8).toString("hex")}`;

  // Row → the client-facing shape, camelCased and scrubbed on the way out. snake_case
  // is the at-rest column convention (v10/v13/v14); the wire shape is camelCase, aliased
  // here exactly as loop-steps.mjs aliases agent_id → agentId.
  function hydrate(row) {
    if (!row) return null;
    return {
      id: row.id,
      title: out(row.title),
      idea: out(row.idea),
      spec: out(row.spec),
      designRef: out(row.design_ref),
      stage: row.stage,
      status: row.status,
      answers: out(row.answers),
      venture: row.venture,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function logRow(r) {
    // PHASE 3 TASK 3.3 — the handback fields are OPTIONAL on the wire: a pre-v19 row, and
    // every non-reject transition, genuinely has none. Emitting `null`s for them would
    // invite the UI to render "from: null → to: null" on an ordinary advance.
    const base = { seq: r.seq, stage: r.stage, event: r.event, ref: out(r.ref), ts: r.ts };
    const handback = {};
    if (r.from_stage) handback.fromStage = r.from_stage;
    if (r.by_agent) handback.byAgent = out(r.by_agent);
    if (r.to_agent) handback.toAgent = out(r.to_agent);
    if (r.evidence) {
      // Stored as JSON. A corrupt value is dropped rather than thrown on: the transition
      // itself is the record that matters, and a bad evidence blob must not make an entire
      // story thread unreadable.
      try {
        const arr = JSON.parse(r.evidence);
        if (Array.isArray(arr) && arr.length) handback.evidence = arr.map((e) => out(e));
      } catch { /* unreadable evidence is no evidence */ }
    }
    return Object.keys(handback).length ? { ...base, ...handback } : base;
  }

  /** How many times this story has already been bounced BACK to `stage`. Durable (task 3.2). */
  function reworkCount(storyId, stage) {
    return Number(countReworkStmt.get(String(storyId ?? ""), String(stage ?? ""))?.n || 0);
  }

  // Append ONE monotonic-seq log row for a story. Caller runs it inside the same txn as
  // the story write, so the log can never describe a transition that did not persist.
  // SESSION 14 — normalise optional forward-transition attribution into the SAME shape
  // appendLog already accepts for handbacks, so there is ONE attribution path, not two.
  // Returns null when neither is supplied, which keeps the columns NULL and the wire clean.
  // Agent ids are server-supplied, but they are capped + scrubbed at rest anyway: this
  // store caps and scrubs everything it writes, and a value that skips that rule today is
  // a value someone routes caller input into tomorrow.
  function attribution(byAgent, toAgent) {
    const by = byAgent ? clean(byAgent, MAX_AGENT_ID) : null;
    const to = toAgent ? clean(toAgent, MAX_AGENT_ID) : null;
    return by || to ? { byAgent: by, toAgent: to } : null;
  }

  function appendLog(storyId, stage, event, ref, ts, handback = null) {
    const seq = Number(maxSeqStmt.get(storyId)?.s || 0) + 1;
    insLog.run(
      storyId, seq, stage, event, ref, ts,
      handback?.fromStage ?? null,
      handback?.byAgent ?? null,
      handback?.toAgent ?? null,
      handback?.evidence ?? null,
    );
    return seq;
  }

  // ── create ────────────────────────────────────────────────────────────────
  // Validates non-empty title + idea (after trim), caps + scrubs both at rest, mints a
  // server id, seeds stage `idea`/status `active`, and logs the `create` transition —
  // all in one txn. Throws a 400 StoryError on bad input.
  function createStory(input = {}) {
    const title = clean(input.title, MAX_STORY_TITLE).trim();
    const idea = clean(input.idea, MAX_STORY_IDEA).trim();
    if (!title) throw bad("title is required");
    if (!idea) throw bad("idea is required");

    const id = newId();
    const ts = now();
    db.transaction(() => {
      insStory.run({
        id,
        title,
        idea,
        spec: null,
        design_ref: null,
        stage: FIRST_STAGE,
        status: "active",
        answers: null,
        venture: DEFAULT_VENTURE,
        ts,
      });
      appendLog(id, FIRST_STAGE, "create", null, ts);
    })();

    emitChanged(id, FIRST_STAGE);
    return getStory(id);
  }

  // ── reads ───────────────────────────────────────────────────────────────────
  function getStory(id) {
    return hydrate(getStoryStmt.get(String(id ?? "")));
  }

  function getLog(id) {
    return listLogStmt.all(String(id ?? "")).map(logRow);
  }

  /** A story plus its full transition log, or null when the id is unknown. */
  function getStoryWithLog(id) {
    const story = getStory(id);
    if (!story) return null;
    return { story, log: getLog(id) };
  }

  function listStories({ stage, status, limit } = {}) {
    const where = [];
    const args = [];
    if (stage !== undefined && stage !== null && stage !== "") {
      if (!STAGE_SET.has(stage)) throw bad(`unknown stage filter: ${stage}`);
      where.push("stage = ?");
      args.push(stage);
    }
    if (status !== undefined && status !== null && status !== "") {
      if (!STORY_STATUSES.includes(status)) throw bad(`unknown status filter: ${status}`);
      where.push("status = ?");
      args.push(status);
    }
    let cap = Number(limit);
    cap = Number.isFinite(cap) && cap > 0 ? Math.min(Math.floor(cap), MAX_LIMIT) : DEFAULT_LIMIT;
    const sql = `SELECT * FROM stories${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`;
    return db.prepare(sql).all(...args, cap).map(hydrate);
  }

  // ── advance ─────────────────────────────────────────────────────────────────
  // The ONLY forward move: stage[i] → stage[i+1]. Illegal (a 409 throw) from the
  // terminal stage or when the id is unknown (a 404). Landing on `accept` sets status
  // `shipped`; every other landing is `active`. Logs the transition (event defaults to
  // `advance`) with an optional artifact ref.
  function advance(id, { event, ref, byAgent, toAgent } = {}) {
    const row = getStoryStmt.get(String(id ?? ""));
    if (!row) throw missing(`unknown story: ${id}`);
    const i = STORY_STAGES.indexOf(row.stage);
    if (i < 0 || i >= STORY_STAGES.length - 1) {
      throw illegal(`no legal advance from stage '${row.stage}'`);
    }
    const next = STORY_STAGES[i + 1];
    const status = next === TERMINAL_STAGE ? "shipped" : "active";
    const ev = clean(event, MAX_EVENT).trim() || "advance";
    const refv = ref === undefined || ref === null || ref === "" ? null : clean(ref, MAX_REF);
    const ts = now();
    // SESSION 14 — WHO handed this on, and to WHOM. Recorded, never inferred: the UI must
    // not guess an author from a stage→seat lookup and present the guess as fact. Both are
    // OPTIONAL — absent leaves the columns NULL and logRow omits the keys entirely, so an
    // unattributed transition is byte-identical to pre-S14 (pinned by ATTR-3).
    const attrib = attribution(byAgent, toAgent);
    db.transaction(() => {
      updStageStmt.run(next, status, ts, row.id);
      appendLog(row.id, next, ev, refv, ts, attrib);
    })();
    emitChanged(row.id, next);
    return getStory(row.id);
  }

  // ── reject ────────────────────────────────────────────────────────────────────
  // A rework bounce: stage → one of its ENUMERATED earlier back-targets (STORY_BACK).
  // A reject to any other stage — including a forward one or an unlisted earlier one —
  // is a 409. The story RESUMES (status `active`); a reject is a bounce-for-rework, not
  // a kill. Logs the transition (event `reject`) with the reason as its ref.
  /**
   * Bounce a story back to an ENUMERATED earlier stage for rework.
   *
   * PHASE 3 TASKS 3.1/3.3/3.4 — this is now the ONE handback choke point.
   *
   * What it used to be: a stage change plus a bare `reason` string. The story bounced and
   * NOBODY PICKED IT UP — the reviewer gate had its own private enqueue, and a reject that
   * arrived through the HTTP route (an operator, or any other agent) moved the stage and
   * stopped there. "Communicate continuously without human intervention" died at exactly
   * that seam.
   *
   * What it is now: the transition persists a STRUCTURED handback in the same row and the
   * same transaction — who sent it back, from where, who is expected to pick it up, why,
   * and what evidence they were looking at — and then fires `onHandback` so the rework is
   * actually dispatched. The seam runs AFTER the transaction commits, so a dispatch fault
   * can never roll back a transition that already happened, and it is isolated for the
   * same reason every other emit-on-persist seam in this codebase is.
   */
  function reject(id, { toStage, reason, byAgent, toAgent, evidence } = {}) {
    const row = getStoryStmt.get(String(id ?? ""));
    if (!row) throw missing(`unknown story: ${id}`);
    const targets = STORY_BACK[row.stage] || [];
    if (!STAGE_SET.has(toStage) || !targets.includes(toStage)) {
      // row.stage is a closed-enum value; the caller-supplied toStage is bounded to 32
      // chars before it is echoed (the route additionally scrubs every 4xx body), so a
      // crafted target can neither balloon nor leak a secret through the verdict.
      throw illegal(`illegal reject from '${row.stage}' to '${String(toStage ?? "").slice(0, 32)}'`);
    }
    const refv = reason === undefined || reason === null || reason === "" ? null : clean(reason, MAX_REF);
    // Untrusted reviewer/agent text: scrubbed and capped at rest exactly like `ref`, and
    // the evidence list is bounded in BOTH dimensions — a long array of long strings is the
    // same unbounded-paste problem as one long string.
    const evList = Array.isArray(evidence)
      ? evidence.map((e) => clean(e, MAX_EVIDENCE_ITEM)).filter(Boolean).slice(0, MAX_EVIDENCE)
      : [];
    const handback = {
      fromStage: row.stage,
      byAgent: byAgent ? clean(byAgent, MAX_AGENT_ID) : null,
      toAgent: toAgent ? clean(toAgent, MAX_AGENT_ID) : null,
      evidence: evList.length ? JSON.stringify(evList) : null,
    };
    const ts = now();
    db.transaction(() => {
      updStageStmt.run(toStage, "active", ts, row.id);
      appendLog(row.id, toStage, "reject", refv, ts, handback);
    })();
    emitChanged(row.id, toStage);
    // AFTER the commit. A handback the rework loop never receives is the defect this task
    // exists to close; a handback that rolls back the transition it describes would be a
    // worse one.
    if (onHandback) {
      try {
        onHandback({
          storyId: row.id,
          fromStage: row.stage,
          toStage,
          byAgent: handback.byAgent,
          toAgent: handback.toAgent,
          reason: refv,
          evidence: evList,
          // Durable, and counted AFTER this row landed — so the first bounce reads 1.
          round: reworkCount(row.id, toStage),
        });
      } catch (e) {
        // The bounce is already durable; a dispatch fault must not un-bounce it. It is
        // logged rather than swallowed, because a story that bounced and was never picked
        // up is exactly the silence this phase is removing.
        log(`[stories] handback dispatch failed for ${row.id} (${row.stage} → ${toStage}): ${e?.message || e}`);
      }
    }
    return getStory(row.id);
  }

  // ── update (S2) ─────────────────────────────────────────────────────────────
  // The pipeline's IN-STAGE field write: set any of status / spec / designRef / answers
  // WITHOUT moving the stage (stage moves are advance()/reject() only, so the closed
  // machine stays the single owner of stage). Every call appends ONE log row (same
  // per-story-monotonic seq, same txn) and emits `story.changed`, so an artifact landing or
  // a status flip to `waiting-you` is as auditable as a stage move. Only the provided fields
  // change; an omitted field (undefined) is left exactly as it was, and an explicit null
  // clears it. All free text is scrubbed + capped at rest, exactly like create/advance.
  //
  // SECURITY: `status` is validated against the closed STORY_STATUSES enum before it lands
  // (a crafted status is a 400, never a free-form write). `spec`/`designRef` hold pipeline-
  // minted REFS (a vault record id), `answers` holds the clarify-Q&A JSON — all scrubbed at
  // rest, all capped, so an agent-authored artifact ref or a BOSS answer can neither balloon
  // the row nor persist a secret.
  function update(id, { status, spec, designRef, answers, event, ref, byAgent, toAgent } = {}) {
    const row = getStoryStmt.get(String(id ?? ""));
    if (!row) throw missing(`unknown story: ${id}`);
    let nextStatus = row.status;
    if (status !== undefined && status !== null && status !== "") {
      if (!STORY_STATUSES.includes(status)) throw bad(`unknown status: ${String(status).slice(0, 32)}`);
      nextStatus = status;
    }
    const nextSpec = spec === undefined ? row.spec : (spec === null ? null : clean(spec, MAX_STORY_SPEC));
    const nextDesign = designRef === undefined ? row.design_ref : (designRef === null ? null : clean(designRef, MAX_REF));
    const nextAnswers = answers === undefined ? row.answers : (answers === null ? null : clean(answers, MAX_STORY_ANSWERS));
    const ev = clean(event, MAX_EVENT).trim() || "update";
    const refv = ref === undefined || ref === null || ref === "" ? null : clean(ref, MAX_REF);
    const ts = now();
    const attrib = attribution(byAgent, toAgent); // S14 — see advance()
    db.transaction(() => {
      updFieldsStmt.run(nextStatus, nextSpec, nextDesign, nextAnswers, ts, row.id);
      appendLog(row.id, row.stage, ev, refv, ts, attrib);
    })();
    emitChanged(row.id, row.stage);
    return getStory(row.id);
  }

  // Identity-only bus frame — never a title/idea (a frame reaches every seat; the
  // content stays behind the auth-gated GET). Best-effort: a persisted write is the
  // source of truth, so a bus hiccup never undoes it.
  function emitChanged(id, stage) {
    try { emit("story.changed", { id, stage }); } catch { /* observational */ }
  }

  // Phase 8 — the mailbox router appends ONE row per delivered (or refused) message so the
  // thread shows the conversation, not just the stage transitions. Deliberately narrow: it
  // can only write `mail` / `mail-refused`, and it reuses appendLog so mail rows share the
  // per-story monotonic seq with every other transition rather than opening a second story.
  const MAIL_LOG_EVENTS = new Set(["mail", "mail-refused", "mail-forged", "mail-invalid"]);
  function appendMailLog(storyId, { event, byAgent, toAgent, ref, ts }) {
    if (!storyId) return null;
    // Task 3 security review (HIGH): the two audit events route() emits for a planted file
    // must persist, or a dropped forgery leaves no trace (addendum #1, observability half).
    if (!MAIL_LOG_EVENTS.has(event)) return null;
    try { if (!getStory(storyId)) return null; } catch { return null; }
    const row = getStory(storyId);
    return appendLog(storyId, row.stage, event, ref ?? null, ts || Date.now(), { byAgent, toAgent });
  }

  return { createStory, getStory, getLog, getStoryWithLog, listStories, advance, reject, update, reworkCount, appendMailLog, StoryError };
}
