// Phase 9 · task 9.7 — THE MANAGER SEAT IS ONE FACT, ASSERTED IN ONE PLACE.
//
// Written during the 9.7 adversarial review, not because anything is broken today, but
// because the failure mode is addendum #23 exactly: a constant that mirrors the DESIGN
// rather than the RUNNING SYSTEM enforces nothing, silently.
//
// The Phase 9 signal path hardcodes the Manager's seat id in several independent places —
// `MANAGER_AGENT_ID` in server.mjs (loop_steps + usage attribution), the `to:` on every
// engine → Manager mail, and the `managerId` defaults of mailbox.mjs / manager.mjs /
// manager-dispatch.mjs. Every one of them is `"tech-lead"` and the roster's manager seat is
// ALSO `"tech-lead"`, so it all works — by coincidence, not by construction. Rename the seat
// in roster.json and nothing fails loudly: `mailbox.send` refuses an unknown recipient, the
// engine's `blocked`/`done` signals stop arriving, and jobs sit in `building` forever, which
// is the exact silence #29 and #30 were about.
//
// This asserts the coincidence, so that renaming the seat is a RED TEST rather than a
// production mystery.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dir, "..", "..");
const roster = JSON.parse(readFileSync(join(__dir, "..", "roster.json"), "utf-8"));

/** The seat the roster says is the Manager. The single source of truth. */
function rosterManagerSeat() {
  const managers = (roster.members || []).filter((m) => m.role === "manager");
  assert.equal(managers.length, 1,
    `the roster must name exactly ONE manager seat (found ${managers.length}): the signal path ` +
    "addresses a single id, so two managers means half the mail goes nowhere");
  return managers[0].id;
}

test("MSEAT-1: the roster names exactly one manager seat", () => {
  assert.ok(rosterManagerSeat(), "no manager seat in roster.json");
});

test("MSEAT-2: server.mjs attributes Manager turns to the roster's manager seat", () => {
  const src = readFileSync(join(REPO, "agent-runtime", "server.mjs"), "utf-8");
  const ast = parse(src, { ecmaVersion: "latest", sourceType: "module" });
  let value = null;
  for (const n of walk(ast)) {
    if (n.type === "VariableDeclarator" && n.id?.type === "Identifier"
        && n.id.name === "MANAGER_AGENT_ID" && n.init?.type === "Literal") {
      value = n.init.value; break;
    }
  }
  assert.ok(value, "MANAGER_AGENT_ID not found as a literal in server.mjs");
  assert.equal(value, rosterManagerSeat(),
    "MANAGER_AGENT_ID drives loop_steps and usage attribution for every Manager turn; if it " +
    "is not the roster's manager seat those rows are filed against a seat that does not exist");
});

test("MSEAT-3: the engine → Manager signal is addressed to that same seat", () => {
  const src = readFileSync(join(REPO, "agent-runtime", "server.mjs"), "utf-8");
  const ast = parse(src, { ecmaVersion: "latest", sourceType: "module" });
  let fn = null;
  for (const n of walk(ast)) {
    if (n.type === "FunctionDeclaration" && n.id?.name === "signalManager") { fn = n; break; }
  }
  assert.ok(fn, "signalManager not found");
  // The `to:` property of the mailbox.send call inside it.
  let to = null;
  for (const n of walk(fn)) {
    if (n.type !== "Property") continue;
    const key = n.key?.name ?? n.key?.value;
    if (key === "to" && n.value?.type === "Literal") { to = n.value.value; break; }
  }
  assert.ok(to, "signalManager does not address a literal recipient");
  assert.equal(to, rosterManagerSeat(),
    "the engine's blocked/done mail is addressed to a seat the roster does not call the " +
    "manager — mailbox.send would refuse it and every job would wait forever");
});

test("MSEAT-4: the module defaults agree with the roster too", async () => {
  // These are the ids used when server.mjs does NOT pass one explicitly.
  const { createMailbox } = await import("../mailbox.mjs");
  const seat = rosterManagerSeat();
  // Read the default straight off each module's source: they are parameter defaults, which
  // no export exposes at runtime.
  for (const file of ["mailbox.mjs", "manager.mjs", "manager-dispatch.mjs"]) {
    const src = readFileSync(join(REPO, "agent-runtime", file), "utf-8");
    const m = /managerId\s*=\s*"([^"]+)"/.exec(src);
    assert.ok(m, `${file} has no managerId default`);
    assert.equal(m[1], seat, `${file} defaults managerId to ${m[1]}, roster says ${seat}`);
  }
  assert.equal(typeof createMailbox, "function");
});

function* walk(node) {
  if (!node || typeof node.type !== "string") return;
  yield node;
  for (const k of Object.keys(node)) {
    if (k === "type" || k === "start" || k === "end" || k === "loc") continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) yield* walk(c); }
    else if (v && typeof v === "object" && typeof v.type === "string") yield* walk(v);
  }
}
