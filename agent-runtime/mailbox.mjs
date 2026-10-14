// Phase 8 / task 8.1 — THE MAILBOX. Peers talk without the human in the loop.
//
// File-based and SINGLE-WRITER by construction: `send()` writes ONLY into the sender's own
// outbox, and `route()` — the one mover, called on the heartbeat — is the only thing that
// ever writes an inbox. No two writers touch one file, so there is no lock to get wrong and
// no lost update. Modelled on the munder-difflin file mailbox the design cites.
//
// SECURITY, stated once and enforced, not hoped for:
//   • `from` is BOUND BY THE CALLER. The runtime knows which seat it spawned; anything the
//     model puts in its payload is data. A forged `from` cannot exist because the field is
//     never read from the model's arguments (8.2 binds it from spawn env).
//   • A body is AGENT-AUTHORED TEXT that lands inside ANOTHER agent's prompt. It is capped
//     (4 KB), scrubbed through the shared egress scrub, and truncation is ANNOUNCED — the
//     same treatment SKILL bodies get in 7.3, for the same reason.
//   • The ROLE PAIR is checked twice: at send, and again at route. A member's role can change
//     between the two (HR hires, an operator edits the roster), and a message must not be
//     delivered under a permission that no longer holds.
//   • Agent ids are charset-checked before they become path segments.
//   • NOBODY may write to the ceo. The BOSS hears from the Manager through Job state, not
//     through a mailbox an agent can post into. That is the whole point of the one-door model.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";

import { ulid } from "./deliveries.mjs";

/** The closed set of message kinds. A kind outside this is refused, never coerced. */
export const MAIL_KINDS = Object.freeze([
  // Phase 10 — `hire-failed` completes the hire triple. Without it HR can only ever answer
  // success, and a refused hire (unknown skill, bad scope, roster cap) would have to be sent
  // as some other kind or not at all — which is a job waiting on news that never comes.
  "handoff", "blocked", "done", "question", "answer",
  "hire-request", "hire-done", "hire-failed", "status",
]);
/**
 * Kinds the Manager is kept informed of, whoever they were addressed to. Phase D · task 13
 * added `question` and `answer`: a worker that asks a peer and ends its turn is waiting on
 * news only the Manager can act on — the answer is what re-enqueues the asker.
 */
const MANAGER_CC = Object.freeze(["status", "blocked", "done", "question", "answer"]);
/** Max bytes of a mail body. It reaches another agent's prompt; it is not a file transfer. */
export const MAX_BODY_BYTES = 4 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * The routing table, as roles — NOT as ids, so a hire cannot widen it.
 * worker ↔ worker · worker ↔ manager · manager ↔ hr. Everything else is refused,
 * and an unknown role on either end is refused rather than defaulted.
 */
export function routeAllowed(fromRole, toRole) {
  if (!fromRole || !toRole) return false;
  if (toRole === "ceo" || fromRole === "ceo") return false; // the BOSS is not on the bus
  if (fromRole === "worker" && toRole === "worker") return true;
  if (fromRole === "worker" && toRole === "manager") return true;
  if (fromRole === "manager" && toRole === "worker") return true;
  if (fromRole === "manager" && toRole === "hr") return true;
  if (fromRole === "hr" && toRole === "manager") return true;
  // Phase 9 — the RUNTIME ITSELF reports terminal task outcomes to the Manager, so a job
  // never waits on news that a crashed seat cannot send. Deliberately the narrowest rule in
  // the table: `system` may reach the Manager and NOTHING else, and no seat can ever hold
  // this role (it is not a roster role — server.mjs assigns it to the literal id `engine`).
  if (fromRole === "system" && toRole === "manager") return true;
  return false;
}

const isAgentId = (s) => typeof s === "string" && ID_RE.test(s);

function atomicWrite(file, text) {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}

/**
 * createMailbox({ root, roleOf, scrub, emit, log, managerId })
 *   roleOf(agentId) → role string or null   (injected: the roster in production)
 *   scrub(text)     → text                  (the SHARED egress scrub)
 *   emit(name, payload)                     (SSE; identity only, never a body)
 *   log(row)                                (one story_log row per delivered/refused message)
 */
/** The board's drawer is not a log file. The cap keeps the MOST RECENT exchange, which is what
 *  an operator opened the drawer to see. */
export const MAX_THREAD = 200;

/**
 * Phase B · Task 3 — ONE envelope validator for both ends of the transport. send() builds the
 * envelope so it never had to check `id`; route() reads a file that anyone with a shell in the
 * mail root could have planted, so it must check everything, id included (the id becomes the
 * inbox FILENAME — an id of "../x" is a path). Returns the refusal text, or null.
 */
export function envelopeError({ from, to, kind, id } = {}, { requireId = false } = {}) {
  if (!isAgentId(from)) return `invalid sender id: ${JSON.stringify(from)}`;
  if (!isAgentId(to)) return `invalid recipient id: ${JSON.stringify(to)}`;
  if (from === to) return "a seat cannot mail itself";
  if (!MAIL_KINDS.includes(kind)) return `unknown kind: ${JSON.stringify(kind)}`;
  // send() has no id yet (it mints one); route() reads a file whose id is about to become a
  // filename, so there it is REQUIRED — an absent id was written as `undefined.json` and
  // clobbered its predecessor (security review of Task 3, MEDIUM).
  if (requireId && typeof id !== "string") return "missing message id";
  if (id !== undefined && !ID_RE.test(String(id))) return `invalid message id: ${JSON.stringify(id)}`;
  return null;
}

export function createMailbox({ root, roleOf, scrub = (t) => t, emit, log, managerId = "tech-lead" } = {}) {
  const dirFor = (agentId, box) => join(root, agentId, box);
  const ensure = (agentId, box) => { const d = dirFor(agentId, box); mkdirSync(d, { recursive: true }); return d; };
  const listJson = (agentId, box) => {
    try { return readdirSync(dirFor(agentId, box)).filter((f) => f.endsWith(".json")).sort(); }
    catch { return []; }
  };

  function capBody(raw) {
    let body = scrub(String(raw ?? ""));
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      body = `${Buffer.from(body, "utf8").subarray(0, MAX_BODY_BYTES).toString("utf8")}\n[...message truncated at ${MAX_BODY_BYTES} bytes]`;
    }
    return body;
  }

  function deliver(msg, to) {
    ensure(to, "inbox");
    atomicWrite(join(dirFor(to, "inbox"), `${msg.id}.json`), JSON.stringify(msg));
  }

  return {
    /** Write one message into the SENDER's outbox. `from` is the caller's bound identity. */
    send({ from, to, kind, body, jobId, taskId = null, goalId = null, changedPaths = null, deliveryId = null }) {
      const bad = envelopeError({ from, to, kind });
      if (bad) return { error: bad };
      if (!routeAllowed(roleOf(from), roleOf(to))) {
        return { error: `${from} (${roleOf(from)}) may not mail ${to} (${roleOf(to)})` };
      }
      const msg = {
        // goalId rides alongside taskId because the ENGINE RE-MINTS A TASKID ON EVERY RETRY
        // while the goal is stable. A reader that can only join on taskId loses every signal
        // that follows a retry. Dropping it here silently defeated both other ends of that
        // fix, which is addendum #4 in miniature: a field is only carried if the TRANSPORT
        // carries it, not just the sender and the reader.
        // changedPaths + deliveryId ride along for the same reason goalId does: the ENGINE
        // knows them and the Manager needs them, and a field the transport drops is a field
        // that does not exist. Without these the review turn reported "0 files changed" and
        // ship would have committed nothing while still reporting `shipped` (addendum #30).
        id: ulid(), from, to, jobId: jobId ?? null, taskId, goalId: goalId ?? null,
        changedPaths: Array.isArray(changedPaths) ? changedPaths.map(String).slice(0, 100) : null,
        deliveryId: deliveryId ? String(deliveryId).slice(0, 64) : null,
        kind, body: capBody(body), at: Date.now(),
      };
      ensure(from, "outbox");
      atomicWrite(join(dirFor(from, "outbox"), `${msg.id}.json`), JSON.stringify(msg));
      return msg;
    },

    /**
     * Move every outbox message to its recipient's inbox. Called on the heartbeat, so it MUST
     * be idempotent: the outbox entry is unlinked as part of the move, and a second call over
     * an empty outbox does nothing.
     */
    route() {
      let moved = 0;
      let senders = [];
      try { senders = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
      catch { return 0; }
      for (const from of senders) {
        for (const file of listJson(from, "outbox")) {
          const src = join(dirFor(from, "outbox"), file);
          let msg;
          try { msg = JSON.parse(readFileSync(src, "utf8")); } catch { try { unlinkSync(src); } catch { /* */ } continue; }
          // Phase B · Task 3 — IDENTITY IS THE OUTBOX OWNER. The envelope's `from` is data a
          // planted file can say anything in; the directory it sits in is what the runtime
          // controls. routeAllowed() was never wrong — it was handed a forged identity
          // (Codex F05, reproduced: a file in sr-backend/outbox claiming tech-lead reached HR).
          if (msg.from !== from) {
            try { unlinkSync(src); } catch { /* */ }
            log?.({ event: "mail-forged", jobId: msg?.jobId ?? null, byAgent: from, claimed: String(msg?.from ?? "").slice(0, 64), toAgent: String(msg?.to ?? "").slice(0, 64), ref: String(msg?.kind ?? "").slice(0, 32), at: Date.now() });
            continue;
          }
          // And the envelope is re-validated here, not only in send(): a planted file skipped
          // send() entirely, and its id is about to become an inbox filename.
          const bad = envelopeError(msg, { requireId: true });
          if (bad) {
            try { unlinkSync(src); } catch { /* */ }
            log?.({ event: "mail-invalid", jobId: msg?.jobId ?? null, byAgent: from, reason: bad, at: Date.now() });
            continue;
          }
          // Re-checked at DELIVERY: a role can change between send and route.
          if (!routeAllowed(roleOf(msg.from), roleOf(msg.to))) {
            try { unlinkSync(src); } catch { /* */ }
            log?.({ event: "mail-refused", byAgent: msg.from, toAgent: msg.to, ref: msg.kind, jobId: msg.jobId, at: Date.now() });
            continue;
          }
          deliver(msg, msg.to);
          // The Manager is kept informed of progress without being addressed every time.
          if (MANAGER_CC.includes(msg.kind) && msg.to !== managerId && msg.from !== managerId) {
            // `origTo` keeps the ORIGINAL recipient: the copy is readdressed to the Manager, and
            // without it a CC'd question could not say which peer was asked, so no answer could
            // ever be matched to it. It is the envelope's `to`, already validated above.
            //
            // The copy's id is DERIVED from the original — `<id>-cc` — never freshly minted. A new
            // ulid is stamped at ROUTE time, which sorts the copy after anything the same sender
            // sent later but routed together; the inbox is read in id order, so live run 7's
            // Manager read a seat's `blocked` BEFORE the question that caused it (MAIL-CC-ORDER-1).
            // The suffix keeps it a distinct, valid id (ID_RE) and sorts it at its send-time slot.
            deliver({ ...msg, id: `${msg.id}-cc`, to: managerId, cc: true, origTo: msg.to }, managerId);
          }
          try { unlinkSync(src); } catch { /* */ }
          moved += 1;
          log?.({ event: "mail", byAgent: msg.from, toAgent: msg.to, ref: msg.kind, jobId: msg.jobId, at: msg.at });
          // IDENTITY ONLY on the bus. A frame reaches every connected seat; the body stays
          // behind the auth-gated read. Same rule as vault.written and loop.step.
          try { emit?.("mail", { id: msg.id, from: msg.from, to: msg.to, kind: msg.kind, jobId: msg.jobId }); }
          catch { /* the bus is observational */ }
        }
      }
      return moved;
    },

    /**
     * Phase B · Task 3 — the operator's GLANCE. Same rows as read(), archives NOTHING. The
     * cockpit's GET used read() and so a viewer could drain the Manager's inbox — completion
     * mail gone before the Manager's own heartbeat drain saw it (Codex F04). read() stays
     * destructive because it IS the Manager's drain; this is the window, not the door.
     */
    peek(agentId) {
      if (!isAgentId(agentId)) return [];
      const out = [];
      for (const file of listJson(agentId, "inbox")) {
        try { out.push(JSON.parse(readFileSync(join(dirFor(agentId, "inbox"), file), "utf8"))); } catch { /* skip a corrupt row */ }
      }
      return out;
    },

    /** Return this seat's messages oldest-first and ARCHIVE them, so nothing is re-read. */
    read(agentId) {
      if (!isAgentId(agentId)) return [];
      const out = [];
      for (const file of listJson(agentId, "inbox")) {
        const src = join(dirFor(agentId, "inbox"), file);
        try { out.push(JSON.parse(readFileSync(src, "utf8"))); } catch { /* skip a corrupt row */ }
        try {
          const archive = ensure(agentId, "archive");
          renameSync(src, join(archive, file));
        } catch { try { unlinkSync(src); } catch { /* */ } }
      }
      return out;
    },

    /**
     * 12.2 — every message belonging to one job, oldest-first. NON-DESTRUCTIVE: unlike
     * `read()`, this archives nothing, because opening the board's drawer must not consume
     * the Manager's unread mail.
     *
     * It reads the mailbox itself rather than a second store. The server's `log` sink routes
     * to `stories.appendMailLog`, which begins `if (!getStory(storyId)) return null` — a JOB is
     * not a story, so every job's mail row has been dropped since Phase 8, silently, inside a
     * catch that exists so logging can never fail a delivery. Assembling the thread twice is
     * how two views of one conversation come to disagree; this reads where mail already lives.
     *
     * BOTH boxes are scanned: `read()` moves a delivered message from `inbox` to `archive`, so
     * an inbox-only thread would show exactly the messages nobody had read yet.
     */
    thread(jobId) {
      const want = String(jobId ?? "");
      if (!want) return [];              // an empty id must not match every message ever sent
      let agents = [];
      try { agents = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
      catch { return []; }
      const seen = new Set();
      const out = [];
      for (const agentId of agents) {
        for (const box of ["inbox", "archive"]) {
          for (const file of listJson(agentId, box)) {
            let msg;
            try { msg = JSON.parse(readFileSync(join(dirFor(agentId, box), file), "utf8")); }
            catch { continue; }           // a corrupt row is skipped, never fatal to the drawer
            if (!msg || msg.jobId !== want) continue;
            // A cc'd copy carries a fresh id but the same conversation turn; de-duplicate on
            // the SENDER's fields so the Manager's carbon copy is not a second row.
            const key = `${msg.from}|${msg.to}|${msg.kind}|${msg.at}|${msg.body}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(msg);
          }
        }
      }
      // ULIDs sort lexicographically by mint time, which is the tiebreak for the many
      // messages that share a millisecond. Without it the order is whatever readdir gave.
      out.sort((a, b) => (a.at || 0) - (b.at || 0) || String(a.id).localeCompare(String(b.id)));
      // Keep the TAIL: the newest exchange is what the drawer was opened for.
      return out.slice(-MAX_THREAD);
    },

    inboxCount: (agentId) => listJson(agentId, "inbox").length,
    outboxCount: (agentId) => listJson(agentId, "outbox").length,
  };
}
