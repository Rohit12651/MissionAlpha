// Phase 13 / task 13.2 — the PURE half of the Jira client.
//
// What these pin: a picker row is a SUMMARY A STRANGER WROTE, and a duplicate is not a failure.

import test from "node:test";
import assert from "node:assert/strict";
import { MAX_TICKET_SUMMARY, parseTickets, ticketError } from "../jiraClient.ts";

test("JCL-1: a row with no key is dropped and the rest still render", () => {
  const out = parseTickets({ issues: [{ key: "ENG-1", summary: "One" }, { summary: "no key" }, { key: "ENG-2" }] });
  assert.deepEqual(out.map((t) => t.key), ["ENG-1", "ENG-2"]);
  assert.equal(out[1].summary, "(no summary)", "a missing summary must read as missing, never be invented");
});

test("JCL-2: a payload that is not a ticket list is an EMPTY picker, never a throw", () => {
  for (const bad of [null, undefined, 7, "issues", [], { issues: "nope" }, {}]) {
    assert.deepEqual(parseTickets(bad), [], `parseTickets(${JSON.stringify(bad)}) did not degrade`);
  }
});

test("JCL-3: a summary is CAPPED — one picker row is one line", () => {
  const [t] = parseTickets({ issues: [{ key: "ENG-1", summary: "x".repeat(5_000) }] });
  assert.equal(t.summary.length, MAX_TICKET_SUMMARY);
});

test("JCL-4: the runtime's OWN reason survives to the operator", () => {
  assert.equal(ticketError({ error: "no jira account is configured — add one on the Accounts page" }, 400),
    "no jira account is configured — add one on the Accounts page");
  // Without a reason, say what happened rather than inventing a cause.
  assert.match(ticketError(null, 502), /502/);
  assert.match(ticketError(null, 401), /not authorised/);
});
