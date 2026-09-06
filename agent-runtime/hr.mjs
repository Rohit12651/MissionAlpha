// Phase 10 · task 10.1 — HR. THE ONLY PATH THAT CREATES AN AGENT WITHOUT THE BOSS.
//
// The whole surface, stated once so it can be checked against the code below:
//   • HR reads its OWN mailbox and acts on exactly one kind: `hire-request` from the Manager.
//   • It creates AT MOST ONE worker per request, through factory.createRosterAgent, and the
//     roster's own `add` is what writes it down.
//   • It answers `hire-done` or `hire-failed` — always one of the two, for every request.
//   • It initiates nothing. No request, no agent. Ever.
//
// WHY EVERY REFUSAL IS REPORTED. Phase 9's two worst defects (#29, #30) were both a signal
// that arrived and was then dropped, leaving a job waiting forever on news that had already
// come and gone. A hire that fails silently is that same bug with a bigger blast radius: the
// Manager parks the task on `awaiting-hire` and nothing ever un-parks it. So the reply is not
// a courtesy — it is the thing that keeps the loop alive.
//
// HR IS NOT A ROSTER SEAT. It never spawns and holds no writeScope; it is a runtime function
// with a mailbox identity, exactly like `engine`. server.mjs's `roleOf` resolves the literal
// id `hr` to the role `hr` without a roster member, because roster.json lists agents this app
// DISPATCHES and putting a non-dispatched id there is how a roster stops describing the
// running system (addendum #23 — roster.test LOAD-1 pins it, and caught the first attempt).

import { createRosterAgent } from "./factory.mjs";

/**
 * Ceiling on roster WORKERS. Every hire is a standing cost: a seat the Manager may dispatch,
 * a persona file, and a share of the engine's concurrency. Beyond this the Manager must reuse
 * an existing seat or ask the BOSS — it may not grow the payroll on its own judgement.
 * Counts workers only: stations and the ceo are the org chart, not the budget.
 */
export const WORKER_CAP = 20;

/** Bound on what a single tick will process, so one flood cannot own the heartbeat. */
const MAX_REQUESTS_PER_TICK = 8;

/**
 * @param {object} deps
 * @param {object} deps.roster    the roster store (all/match/add)
 * @param {object} deps.mailbox   the file mailbox (read/send)
 * @param {string} [deps.hrId]    HR's mailbox identity
 * @param {string} [deps.managerId] the ONLY sender HR obeys
 */
export function createHr({ roster, mailbox, hrId = "hr", managerId = "tech-lead", log = () => {} }) {
  if (!roster) throw new Error("createHr: roster required");
  if (!mailbox) throw new Error("createHr: mailbox required");

  const reply = (to, kind, jobId, payload) => {
    try {
      const r = mailbox.send({ from: hrId, to, kind, jobId, body: JSON.stringify(payload) });
      if (r?.error) log({ event: "hr-reply-refused", kind, jobId, error: r.error });
    } catch (e) {
      log({ event: "hr-reply-threw", kind, jobId, error: e?.message ?? String(e) });
    }
  };

  /** PURE-ish. Parse a request body. Fails CLOSED: a body we cannot read is not a guess. */
  function parseRequest(body) {
    let obj;
    try { obj = JSON.parse(String(body ?? "")); } catch { return { error: "hire-request body is not JSON" }; }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { error: "hire-request body is not an object" };
    const skills = Array.isArray(obj.skills) ? obj.skills.map((s) => String(s)) : [];
    const writeScope = Array.isArray(obj.writeScope) ? obj.writeScope.map((s) => String(s)) : [];
    if (!skills.length) return { error: "hire-request names no skills" };
    return { req: { skills, writeScope, reason: String(obj.reason ?? "").slice(0, 500) } };
  }

  /** One request → at most one agent. Returns what happened, for the tick's report. */
  function handle(msg) {
    const jobId = msg.jobId ?? null;

    // 1. THE SENDER. The transport already refuses worker → hr (routeAllowed), which is the
    //    real control; this is the second check, because a member's role can change between
    //    send and route and mailbox.mjs says so in its own header.
    if (msg.from !== managerId) {
      log({ event: "hr-refused-sender", from: msg.from, jobId });
      return { refused: `sender ${msg.from} is not the Manager` };
    }

    const p = parseRequest(msg.body);
    if (p.error) {
      log({ event: "hr-failed", jobId, reason: p.error });
      reply(msg.from, "hire-failed", jobId, { reason: p.error });
      return { failed: p.error };
    }
    const { skills, writeScope } = p.req;

    // 2. REUSE BEFORE HIRE. The Manager asks only when ITS match found nothing, but two jobs
    //    can ask for the same skill before the first hire lands. Matching here makes the whole
    //    operation idempotent without a second ledger to keep in step: the roster IS the
    //    record of who exists.
    const existing = roster.match(skills);
    if (existing.length) {
      log({ event: "hr-reused", jobId, agentId: existing[0].id, skills });
      reply(msg.from, "hire-done", jobId, { agentId: existing[0].id, reused: true });
      return { reused: existing[0].id };
    }

    // 3. THE CAP. Workers only — stations and the ceo are the org chart, not the budget.
    const workers = roster.all().filter((m) => m.role === "worker").length;
    if (workers >= WORKER_CAP) {
      const reason = `worker cap reached (${workers}/${WORKER_CAP}) — reuse a seat or ask the BOSS`;
      log({ event: "hr-failed", jobId, reason });
      reply(msg.from, "hire-failed", jobId, { reason });
      return { failed: reason };
    }

    // 4. CREATE. Every rule about what a hire may hold lives in validateRosterSpec; HR does
    //    not restate any of them, so there is one place to read and one place to change.
    const takenIds = new Set(roster.all().map((m) => m.id));
    const made = createRosterAgent({ skills, writeScope }, { takenIds });
    if (made.error) {
      log({ event: "hr-failed", jobId, reason: made.error });
      reply(msg.from, "hire-failed", jobId, { reason: made.error });
      return { failed: made.error };
    }

    // 5. WRITE IT DOWN. roster.add re-validates through validateMember on the way to disk and
    //    emits roster.changed. If the disk refuses, the hire DID NOT HAPPEN — say so, rather
    //    than reporting an agent the roster does not carry (addendum #2).
    const added = roster.add(made.member);
    if (added?.error) {
      log({ event: "hr-failed", jobId, reason: added.error });
      reply(msg.from, "hire-failed", jobId, { reason: `roster refused the hire: ${added.error}` });
      return { failed: added.error };
    }

    log({ event: "hr-hired", jobId, agentId: added.id, skills: added.skills, writeScope: added.writeScope });
    reply(msg.from, "hire-done", jobId, { agentId: added.id, skills: added.skills });
    return { hired: added.id };
  }

  return {
    /**
     * Drain HR's inbox and act. Called on the heartbeat.
     * `inject` exists for tests that need to present a message the TRANSPORT would refuse,
     * so the second sender check can be exercised on its own.
     */
    async tick({ inject = null } = {}) {
      const msgs = inject ?? mailbox.read(hrId);
      const out = { hired: [], reused: [], failed: [], refused: [] };
      for (const msg of msgs.slice(0, MAX_REQUESTS_PER_TICK)) {
        if (!msg || msg.kind !== "hire-request") continue; // HR acts on ONE kind
        const r = handle(msg);
        if (r.hired) out.hired.push(r.hired);
        else if (r.reused) out.reused.push(r.reused);
        else if (r.failed) out.failed.push(r.failed);
        else if (r.refused) out.refused.push(r.refused);
      }
      return out;
    },
  };
}
