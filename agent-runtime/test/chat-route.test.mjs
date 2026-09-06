// CHAT LLM SELECTION — the operator picks, the app does not guess.
//
// WHAT WAS WRONG. `pickChatBackend` decided silently from a heuristic:
//     acct.capability !== "swarm" && OPENAI_COMPAT_TYPES.has(...) → "adapter", else "cli"
// So probing an account for tool support (a GOOD thing — it unlocks the engine) SILENTLY
// EJECTED it from chat, and chat fell back to the Claude CLI without ever saying so. The
// operator added an OpenRouter key, watched the app answer from somewhere else entirely,
// and had no surface anywhere that named the routing decision.
//
// A routing rule the operator cannot see or override is the app choosing for them.
//
// NEW CONTRACT: an EXPLICIT choice always wins and is never second-guessed — including for
// swarm-capable accounts, which the old rule refused outright. With no choice recorded the
// resolver returns `ask` and NAMES the options, rather than picking one and hoping.

import test from "node:test";
import assert from "node:assert/strict";
import { resolveChatRoute, chatChoices } from "../chat-route.mjs";

const acct = (over = {}) => ({
  id: "a1", label: "OX Alpha", providerType: "custom", authMethod: "api_key",
  hasSecret: true, baseUrl: "https://openrouter.ai/api/v1/chat/completions",
  model: "stealth/ox-alpha", capability: "swarm", ...over,
});
const claude = (over = {}) => acct({ id: "c1", label: "Claude Max", providerType: "claude",
  authMethod: "subscription", hasSecret: false, baseUrl: null, ...over });

// ── ask-once ─────────────────────────────────────────────────────────────────

test("ASK-1: no choice + MULTIPLE usable accounts → ask, and NAME the options", () => {
  const r = resolveChatRoute({ accounts: [acct(), claude()], chatAccountId: null });
  assert.equal(r.mode, "ask");
  assert.deepEqual(r.choices.map((c) => c.id).sort(), ["a1", "c1"]);
  assert.match(r.reason, /choose|pick|select/i);
});

test("ASK-1b: no choice + exactly ONE usable account → USE IT, do not ask", () => {
  // The first cut of this module asked whenever nothing was recorded — which broke chat
  // on EVERY existing single-account install (17 suite failures) and, worse, asked a
  // question with one possible answer. Asking is for AMBIGUITY. With one usable account
  // there is nothing to choose between, and refusing to answer is not "letting the
  // operator decide", it is a dead app. The picker still shows what is routing.
  const r = resolveChatRoute({ accounts: [acct()], chatAccountId: null });
  assert.equal(r.mode, "adapter");
  assert.equal(r.account.id, "a1");
  assert.match(r.reason, /only|sole|single/i);
});

test("ASK-1c: an UNUSABLE account does not count toward ambiguity", () => {
  // One usable + one broken is still a one-option install.
  const r = resolveChatRoute({ accounts: [acct(), claude({ id: "c9", providerType: "nope" })], chatAccountId: null });
  assert.equal(r.mode, "adapter");
  assert.equal(r.account.id, "a1");
});

test("ASK-2: a recorded choice is REMEMBERED — never asks twice", () => {
  const r = resolveChatRoute({ accounts: [acct(), claude()], chatAccountId: "a1" });
  assert.notEqual(r.mode, "ask");
  assert.equal(r.account.id, "a1");
});

test("ASK-3: a choice pointing at a DELETED account falls back to ask, not to a guess", () => {
  const r = resolveChatRoute({ accounts: [claude()], chatAccountId: "a1" });
  assert.equal(r.mode, "ask");
  assert.match(r.reason, /no longer|missing|removed|not found/i);
});

test("ASK-4: zero accounts → fall through to the CLI, exactly as before this feature", () => {
  // No accounts is not a choice to make — it is the pre-existing no-account install, and
  // it must behave identically to before (Claude CLI / mock). Asking here would break a
  // fresh checkout that never had an account in the first place.
  const r = resolveChatRoute({ accounts: [], chatAccountId: null });
  assert.equal(r.mode, "cli");
  assert.deepEqual(r.choices, []);
});

// ── the explicit choice overrides the old heuristic ──────────────────────────

test("SWARM-1: a SWARM account chosen for chat IS used — the old rule refused this", () => {
  // The whole point. capability:"swarm" previously forced chat to the CLI no matter what.
  const r = resolveChatRoute({ accounts: [acct({ capability: "swarm" })], chatAccountId: "a1" });
  assert.equal(r.mode, "adapter");
  assert.equal(r.account.capability, "swarm");
});

test("ROUTE-1: an OpenAI-compatible account with key + baseUrl → adapter", () => {
  const r = resolveChatRoute({ accounts: [acct({ capability: "chat_only" })], chatAccountId: "a1" });
  assert.equal(r.mode, "adapter");
});

test("ROUTE-2: a Claude subscription → cli", () => {
  const r = resolveChatRoute({ accounts: [claude()], chatAccountId: "c1" });
  assert.equal(r.mode, "cli");
});

test("ROUTE-3: an OpenAI-compatible account with NO secret cannot be an adapter", () => {
  // Choosing it must not produce a route that will 401 at the provider. Say why instead.
  const r = resolveChatRoute({ accounts: [acct({ hasSecret: false })], chatAccountId: "a1" });
  assert.equal(r.mode, "ask");
  assert.match(r.reason, /key|secret|credential/i);
});

test("ROUTE-4: an OpenAI-compatible account with no baseUrl cannot be an adapter", () => {
  const r = resolveChatRoute({ accounts: [acct({ baseUrl: "" })], chatAccountId: "a1" });
  assert.equal(r.mode, "ask");
  assert.match(r.reason, /url|endpoint/i);
});

// ── the option list the picker renders ───────────────────────────────────────

test("CHOICES-1: every account is offered, each labelled with how it would run", () => {
  const cs = chatChoices([acct(), claude()]);
  const byId = Object.fromEntries(cs.map((c) => [c.id, c]));
  assert.equal(byId.a1.via, "adapter");
  assert.equal(byId.c1.via, "cli");
  assert.match(byId.a1.label, /OX Alpha/);
});

test("CHOICES-2: an unusable account is offered but marked, never silently hidden", () => {
  // Hiding it would leave the operator wondering where their account went.
  const cs = chatChoices([acct({ hasSecret: false })]);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].usable, false);
  assert.ok(cs[0].why);
});

test("CHOICES-3: NO SECRET VALUE is ever exposed in a choice", () => {
  const flat = JSON.stringify(chatChoices([acct({ secret: "sk-should-never-appear" })]));
  assert.doesNotMatch(flat, /sk-should-never-appear/);
  assert.doesNotMatch(flat, /"secret"/);
});

test("ROBUST-1: malformed input never throws and never auto-selects", () => {
  for (const bad of [undefined, null, {}, { accounts: "nope" }, { accounts: [null, 7] }]) {
    const r = resolveChatRoute(bad);
    // No usable account can be derived → the pre-feature CLI fallback, never a crash and
    // never a silent pick of something that was not offered.
    assert.equal(r.mode, "cli", JSON.stringify(bad));
  }
  assert.deepEqual(chatChoices(null), []);
});
