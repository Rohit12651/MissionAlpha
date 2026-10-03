// Landing + Setup (spec §5, ADR-LS2) — the first-run rules, pure.
import test from "node:test";
import assert from "node:assert/strict";
import { firstRunView, accountPlan, folderOk, readyLines, HERO_SCRIPT, withTimeout } from "../firstRun.ts";

const acct = (id: string, providerType: string, authMethod: string) => ({ id, providerType, authMethod });
const ws = (configured: string | null, envPinned = false) => ({ configured, envPinned });

test("flag set → cockpit, whatever the runtime says", () => {
  assert.equal(firstRunView({ flag: "1", accounts: null, workspace: null }), "cockpit");
});
test("flag unset, no active account → landing", () => {
  assert.equal(firstRunView({ flag: null, accounts: { accounts: [], activeAccountId: null }, workspace: ws("/r") }), "landing");
});
test("upgrade path: active account AND a configured workspace → cockpit", () => {
  assert.equal(firstRunView({ flag: null, accounts: { accounts: [acct("a", "claude", "subscription")], activeAccountId: "a" }, workspace: ws("/r") }), "cockpit");
});
test("upgrade path: an env-pinned workspace counts", () => {
  assert.equal(firstRunView({ flag: null, accounts: { accounts: [acct("a", "claude", "subscription")], activeAccountId: "a" }, workspace: ws(null, true) }), "cockpit");
});
test("active account but no workspace → landing", () => {
  assert.equal(firstRunView({ flag: null, accounts: { accounts: [acct("a", "claude", "subscription")], activeAccountId: "a" }, workspace: ws(null) }), "landing");
});
test("runtime unreachable (nulls) → landing", () => {
  assert.equal(firstRunView({ flag: null, accounts: null, workspace: null }), "landing");
});

test("accountPlan: no Claude subscription account → create", () => {
  assert.deepEqual(accountPlan({ accounts: [acct("k", "openai", "api_key")], activeAccountId: "k" }), { kind: "create" });
});
test("accountPlan: a subscription account that is not active → activate it", () => {
  assert.deepEqual(accountPlan({ accounts: [acct("s", "claude", "subscription"), acct("k", "openai", "api_key")], activeAccountId: "k" }), { kind: "activate", id: "s" });
});
test("accountPlan: the subscription account is already active → confirm", () => {
  assert.deepEqual(accountPlan({ accounts: [acct("s", "claude", "subscription")], activeAccountId: "s" }), { kind: "confirm", id: "s" });
});
test("accountPlan: a Claude API-key account is not a subscription", () => {
  assert.deepEqual(accountPlan({ accounts: [acct("c", "claude", "api_key")], activeAccountId: "c" }), { kind: "create" });
});

test("folderOk: the mockup's rule", () => {
  for (const ok of ["/xy", "~/x", "~/code/my-app", " /srv/app "]) assert.equal(folderOk(ok), true, ok);
  for (const bad of ["x", "/", "/x", "~", "", "code/app", "~user/x", "~~/x"]) assert.equal(folderOk(bad), false, bad);
});

test("readyLines: pending restart is never called active, and is not marked confirmed", () => {
  const l = readyLines({ engine: "Claude Code CLI", account: "subscription", project: { path: "~/a", status: "pending" }, stations: 10 });
  assert.deepEqual(l[2], { text: "Project: ~/a · pending restart", confirmed: false });
  assert.ok(!l.some((x) => x.text.startsWith("Project") && x.text.includes("active")));
});
test("readyLines: an env-pinned runtime says the choice will not apply", () => {
  const l = readyLines({ engine: "Claude Code CLI", account: "subscription", project: { path: "~/a", status: "pinned" }, stations: 10 });
  assert.deepEqual(l[2], { text: "Project: ~/a · pinned by the runtime's environment, not applied", confirmed: false });
});
test("readyLines: only what the runtime confirmed is marked confirmed", () => {
  const l = readyLines({ engine: "Claude Code CLI", account: "later", project: { path: "~/a", status: "active" }, stations: null });
  assert.deepEqual(l, [
    { text: "Engine: Claude Code CLI", confirmed: true },
    { text: "Account: API key, later (add one in Accounts)", confirmed: false },
    { text: "Project: ~/a · active", confirmed: true },
    { text: "— stations, standing by", confirmed: false },
  ]);
});
test("HERO_SCRIPT is the mockup's six-message job", () => {
  assert.equal(HERO_SCRIPT.length, 6);
  assert.deepEqual(HERO_SCRIPT[0], ["ceo", "Proceed. Cheaper option: ship the switch first, persist the choice in a second pass."]);
});

// Final review LOW: the first-run race left its 5 s timer running after the runtime answered.
test("withTimeout: an answer before the deadline clears the timer", async () => {
  const live = new Set<unknown>();
  const [st, ct] = [globalThis.setTimeout, globalThis.clearTimeout];
  globalThis.setTimeout = ((fn: () => void, ms: number) => { const id = st(fn, ms); live.add(id); return id; }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => { live.delete(id); ct(id); }) as typeof clearTimeout;
  try {
    assert.equal(await withTimeout(Promise.resolve(7), 5000), 7);
    assert.equal(live.size, 0, "the deadline timer is still pending");
  } finally { [globalThis.setTimeout, globalThis.clearTimeout] = [st, ct]; }
});

test("withTimeout: no answer by the deadline rejects", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 10), /timeout/);
});
