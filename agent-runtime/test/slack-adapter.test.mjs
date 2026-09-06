// MUNDER-ADOPTION A7 — Slack ingress invariants, pinned. Signature math against real
// HMACs, replay window, fail-closed config, allowlist, Law-3 cap, idempotent mint,
// loop-guard, host-pinned reply seam.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySlackSignature, parseSlackIngress, createSlackAdapter, CAP_ID, REPLAY_WINDOW_S } from "../adapters/slack.mjs";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const NOW = 1_755_600_000_000; // fixed clock

const sign = (rawBody, tsSec = NOW / 1000) =>
  `v0=${createHmac("sha256", SECRET).update(`v0:${tsSec}:${rawBody}`).digest("hex")}`;

const eventBody = (over = {}) => JSON.stringify({
  type: "event_callback",
  event: { type: "message", channel: "C0DEPLOY", user: "U1BOSS", text: "draft release notes for v1.4", ts: "1755600000.000100", ...over },
});

function harness(cfg = {}, over = {}) {
  const minted = [];
  const capCalls = [];
  let capAllows = true;
  const a = createSlackAdapter({
    getConfig: () => ({ enabled: true, channelAllowlist: ["C0DEPLOY"], ...cfg }),
    getSecret: () => SECRET,
    mintExternal: (input) => { minted.push(input); return { id: `d-${minted.length}`, deduped: false }; },
    cap: { consume: (id, at) => { capCalls.push({ id, at }); return capAllows; } },
    now: () => NOW,
    log: () => {},
    ...over,
  });
  return { a, minted, capCalls, setCap: (v) => { capAllows = v; } };
}

// ── signature ────────────────────────────────────────────────────────────────

test("a correctly signed, fresh request verifies; any byte change fails", () => {
  const body = eventBody();
  const ts = NOW / 1000;
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, rawBody: body, signature: sign(body), now: () => NOW }), true);
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, rawBody: body + " ", signature: sign(body), now: () => NOW }), false);
  assert.equal(verifySlackSignature({ signingSecret: "wrong", timestamp: ts, rawBody: body, signature: sign(body), now: () => NOW }), false);
});

test(`replay window: a signature older than ${REPLAY_WINDOW_S}s is refused even when valid`, () => {
  const body = eventBody();
  const oldTs = NOW / 1000 - (REPLAY_WINDOW_S + 10);
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: oldTs, rawBody: body, signature: sign(body, oldTs), now: () => NOW }), false);
});

test("missing secret / timestamp / signature / non-numeric timestamp all fail closed", () => {
  const body = eventBody();
  assert.equal(verifySlackSignature({ signingSecret: "", timestamp: NOW / 1000, rawBody: body, signature: sign(body) }), false);
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: "", rawBody: body, signature: sign(body) }), false);
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: "not-a-ts", rawBody: body, signature: sign(body), now: () => NOW }), false);
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: NOW / 1000, rawBody: body, signature: "", now: () => NOW }), false);
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: NOW / 1000, rawBody: body, signature: "v0=short", now: () => NOW }), false);
});

// ── parsing ──────────────────────────────────────────────────────────────────

test("url_verification answers the challenge; bot messages are loop-guarded; junk ignored", () => {
  assert.deepEqual(parseSlackIngress(JSON.stringify({ type: "url_verification", challenge: "chal-123" })), { kind: "challenge", challenge: "chal-123" });
  assert.equal(parseSlackIngress(eventBody({ bot_id: "B0T" })).kind, "ignore");
  assert.equal(parseSlackIngress(eventBody({ subtype: "bot_message" })).kind, "ignore");
  assert.equal(parseSlackIngress("{not json").kind, "ignore");
  assert.equal(parseSlackIngress(JSON.stringify({ type: "event_callback", event: { type: "reaction_added" } })).kind, "ignore");
  assert.equal(parseSlackIngress(eventBody({ text: "  " })).kind, "ignore");
});

// ── ingest decision ladder ───────────────────────────────────────────────────

const signedReq = (body, tsSec = NOW / 1000) => ({ timestamp: tsSec, signature: sign(body, tsSec), rawBody: body });

test("fail-closed: disabled → 403; no secret → 403; bad signature → 401", () => {
  const disabled = harness({ enabled: false });
  assert.equal(disabled.a.ingest(signedReq(eventBody())).status, 403);

  const noSecret = harness({}, { getSecret: () => "" });
  assert.equal(noSecret.a.ingest(signedReq(eventBody())).status, 403);

  const { a } = harness();
  assert.equal(a.ingest({ timestamp: NOW / 1000, signature: "v0=bad", rawBody: eventBody() }).status, 401);
});

test("allowlisted signed message mints ONE read-only external delivery (201, idempotent key)", () => {
  const { a, minted } = harness();
  const r = a.ingest(signedReq(eventBody()));
  assert.equal(r.status, 201);
  assert.equal(minted.length, 1);
  assert.equal(minted[0].source, "slack");
  assert.equal(minted[0].kind, "command");
  assert.equal(minted[0].externalKey, "slack:C0DEPLOY:1755600000.000100");
  assert.deepEqual(minted[0].changes, []);
  assert.match(minted[0].summary, /release notes/);
});

test("challenge round-trips through ingest with a valid signature (200 {challenge})", () => {
  const body = JSON.stringify({ type: "url_verification", challenge: "chal-9" });
  const { a, minted } = harness();
  const r = a.ingest(signedReq(body));
  assert.equal(r.status, 200);
  assert.equal(r.body.challenge, "chal-9");
  assert.equal(minted.length, 0);
});

test("non-allowlisted channel → 202 drop (Slack must not retry-storm), zero mint, zero cap", () => {
  const { a, minted, capCalls } = harness({ channelAllowlist: ["C0OTHER"] });
  const r = a.ingest(signedReq(eventBody()));
  assert.equal(r.status, 202);
  assert.equal(minted.length, 0);
  assert.equal(capCalls.length, 0);
});

test("Law 3: no cap seam → NOTHING mints; cap denied → 202 drop; cap id is 'slack-ingress'", () => {
  const capless = harness({}, { cap: null });
  assert.equal(capless.a.ingest(signedReq(eventBody())).status, 202);
  assert.equal(capless.minted.length, 0);

  const { a, minted, capCalls, setCap } = harness();
  setCap(false);
  assert.equal(a.ingest(signedReq(eventBody())).status, 202);
  assert.equal(minted.length, 0);
  assert.equal(capCalls[0].id, CAP_ID);
});

test("a mint refusal degrades to 202, never a 5xx back at Slack", () => {
  const { a } = harness({}, { mintExternal: () => { throw new Error("db locked"); } });
  assert.equal(a.ingest(signedReq(eventBody())).status, 202);
});

// ── reply seam ───────────────────────────────────────────────────────────────

test("postReply: skipped without a bot token; host-pinned to slack.com when live", async () => {
  const calls = [];
  const { a } = harness({}, {
    getBotToken: () => "",
    fetch: async (url, init) => { calls.push({ url, init }); return { ok: true }; },
  });
  assert.deepEqual(await a.postReply({ channel: "C0DEPLOY", threadTs: "1.2", text: "done" }), { skipped: true, reason: "no bot token" });
  assert.equal(calls.length, 0);

  const live = harness({}, {
    getBotToken: () => "xoxb-test",
    fetch: async (url, init) => { calls.push({ url, init }); return { ok: true }; },
  });
  const r = await live.a.postReply({ channel: "C0DEPLOY", threadTs: "1.2", text: "done" });
  assert.deepEqual(r, { sent: true });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith("https://slack.com/api/chat.postMessage"));
});

test("postReply never throws — a dead transport reads as skipped", async () => {
  const { a } = harness({}, { getBotToken: () => "xoxb", fetch: async () => { throw new Error("ECONNREFUSED"); } });
  const r = await a.postReply({ channel: "C", threadTs: "1", text: "x" });
  assert.equal(r.skipped, true);
});
