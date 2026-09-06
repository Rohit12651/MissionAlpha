#!/usr/bin/env node
// Phase 12 / task 12.1 — `create_job`, exposed to the Ash seat as an MCP tool.
//
// A tiny stdio JSON-RPC server, spawned BY the runtime once per Ash chat turn, with the
// caller's own credentials in its environment. It is the sibling of 8.2's mail server and it
// keeps the same property, which is the only one that matters:
//
//   THE MODEL SUPPLIES TITLE AND BRIEF. NOTHING ELSE.
//
// `source`, `repo` and `externalKey` are ABSENT from the schema — not "ignored if present" —
// so a job Ash creates can never claim to have come from Jira, target another repository, or
// collide with a ticket key.
//
// WHY IT SPEAKS HTTP INSTEAD OF IMPORTING THE JOB STORE. The store is SQLite behind one
// writer, and a second process opening the same database is a second writer. More importantly,
// `POST /runtime/jobs` already carries the whole decision: the token gate, the approver-role
// gate, and (12.1) the rate and duplicate caps that live in the store so a direct curl is
// bound by the same numbers. Relaying to that route means Ash adds NO authorization logic and
// therefore has none that can drift from the runtime's. This process is a courier: it carries
// the caller's own session and reports what the route said.
//
// IDENTITY IS BOUND FROM THE ENVIRONMENT. The cookie below is the session of the human who is
// chatting. If that human is a viewer, the route answers 403 and the tool relays it. Ash can
// do exactly what the person at the keyboard could already do with a curl, and no more.

const BASE = (process.env.MA_ASH_BASE || "").replace(/\/+$/, "");
const TOKEN = process.env.MA_ASH_TOKEN || "";
const COOKIE = process.env.MA_ASH_COOKIE || "";
const TIMEOUT_MS = Number(process.env.MA_ASH_TIMEOUT_MS || 15_000);

/** Mirrors jobs.mjs MAX_TITLE / MAX_BRIEF. Refused there too; this only avoids a pointless round trip. */
const MAX_TITLE = 300;
const MAX_BRIEF = 10_000;

const TOOLS = [
  {
    name: "create_job",
    description:
      "Create ONE job from what the BOSS asked for. The brief must be the BOSS's own words. "
      + "The runtime refuses an identical brief submitted twice within ten minutes, refuses more "
      + "than a handful of jobs per minute, and refuses a session that is not an approver — "
      + "relay any refusal to the BOSS and do not retry it.",
    inputSchema: {
      type: "object",
      // NO source, NO repo, NO externalKey. See the header.
      properties: {
        title: { type: "string", description: "A short label for the job. You write this." },
        brief: { type: "string", description: "What the BOSS asked for, in their words. Capped at 10 KB." },
      },
      required: ["title", "brief"],
    },
  },
];

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const ok = (id, text) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
const fail = (id, text) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });

async function createJob(id, args) {
  if (!BASE || !TOKEN) {
    return fail(id, "create_job is not bound to a runtime — tell the BOSS the job was NOT created.");
  }
  const title = String(args?.title ?? "").trim();
  const brief = String(args?.brief ?? "").trim();
  if (!title) return fail(id, "create_job refused: a title is required.");
  if (!brief) return fail(id, "create_job refused: a brief is required.");
  // REFUSED, not truncated — the brief is the specification (jobs.mjs says the same).
  if (title.length > MAX_TITLE) return fail(id, `create_job refused: the title exceeds ${MAX_TITLE} characters.`);
  if (brief.length > MAX_BRIEF) return fail(id, `create_job refused: the brief exceeds ${MAX_BRIEF} characters.`);

  const headers = { "Content-Type": "application/json", "x-runtime-token": TOKEN };
  if (COOKIE) headers.cookie = COOKIE;

  let res, body;
  try {
    res = await fetch(`${BASE}/runtime/jobs`, {
      method: "POST", headers, body: JSON.stringify({ title, brief }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    body = await res.json().catch(() => ({}));
  } catch (e) {
    return fail(id, `create_job could not reach the runtime: ${String(e?.message || e)}. The job was NOT created.`);
  }
  if (!res.ok) {
    // The route's own words. A refusal must never carry a job id — the BOSS acts differently on
    // a duplicate than on a permission refusal, and "an error occurred" tells them neither.
    const why = String(body?.error || `the runtime answered ${res.status}`);
    return fail(id, `create_job refused (${res.status}): ${why}`);
  }
  const jobId = String(body?.id || "");
  if (!jobId) return fail(id, "the runtime accepted the job but returned no id — do not tell the BOSS it was created.");
  return ok(id, `created ${jobId} — status ${String(body?.status || "intake")}.`);
}

function handleCall(id, name, args) {
  if (name === "create_job") return createJob(id, args);
  return fail(id, `unknown tool: ${name}`);
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: "2024-11-05", capabilities: { tools: {} },
        serverInfo: { name: "missionalpha-ash", version: "1.0.0" },
      } });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === "tools/call") {
      Promise.resolve(handleCall(msg.id, msg.params?.name, msg.params?.arguments || {}))
        .catch((e) => fail(msg.id, `create_job failed: ${String(e?.message || e)}`));
    } else if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  }
});
