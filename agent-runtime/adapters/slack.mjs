// MUNDER-ADOPTION A7 — SLACK INGRESS: a channel message becomes a read-only Delivery.
//
// TRUST MODEL, stated plainly. This adapter backs the ONE route that is exempt from the
// runtime's loopback-Host gate (Slack's servers cannot send a loopback Host through a
// tunnel), so its authentication is NOT the per-boot token — it is Slack's own request
// signature: v0 HMAC-SHA256 over `v0:<timestamp>:<rawBody>` with the workspace signing
// secret, compared timing-safely, with a ±300s timestamp window that kills replays.
// FAIL-CLOSED EVERYWHERE: no signing secret configured → 403 before any parsing; adapter
// disabled in factory/adapters.json → 403; bad/old signature → 401; channel not on the
// allowlist → 202-and-drop (Slack retries on non-2xx — a policy drop must not turn into
// a redelivery storm).
//
// LAW 3 + THE TRIPLE GATE, structurally:
//   • the ONLY mint is deliveries.mintExternal (source 'slack'), which auto_apply-proofs
//     the row exactly like github-pr/claude-code;
//   • deliveries.decide() hard-refuses source 'slack' (read-only, like claude-code) —
//     a Slack message can ASK, it can never SHIP;
//   • mints are capped per UTC day through the SHARED worker-cap under CAP_ID
//     'slack-ingress'; over cap → 202-and-drop with a log line, never a queue.
//
// CONTENT IS UNTRUSTED (Law 2): message text reaches the row through mintExternal's
// scrub, is truncated hard here first, and is NEVER fed into any prompt by this module.
//
// WHAT V1 DELIBERATELY DOES NOT DO (disclosed, not hidden): no reply back into Slack
// (chat.postMessage needs a bot token this machine does not hold — the `postReply` seam
// exists and is tested with an injected transport, wired live only when SLACK_BOT_TOKEN
// is present), and no slash-command form-encoding (JSON Events API only).

import { createHmac, timingSafeEqual } from "node:crypto";

export const CAP_ID = "slack-ingress";
export const REPLAY_WINDOW_S = 300;
export const MAX_TEXT = 2000;
const SLACK_API_HOST = "slack.com"; // reply egress is PINNED to this host

/** v0 signature check. Pure; injectable clock. True only for a fresh, valid signature. */
export function verifySlackSignature({ signingSecret, timestamp, rawBody, signature, now = Date.now }) {
  if (!signingSecret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now() / 1000 - ts) > REPLAY_WINDOW_S) return false; // replay window
  const base = `v0:${timestamp}:${rawBody ?? ""}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false; // timingSafeEqual throws on length mismatch
  return timingSafeEqual(a, b);
}

/** Parse a Slack Events-API body into one of:
 *  {kind:'challenge', challenge} · {kind:'message', channel, user, text, ts, threadTs}
 *  · {kind:'ignore', reason}. Pure; never throws. */
export function parseSlackIngress(rawBody) {
  let o;
  try { o = JSON.parse(String(rawBody || "")); } catch { return { kind: "ignore", reason: "not json" }; }
  if (o?.type === "url_verification" && typeof o.challenge === "string") {
    return { kind: "challenge", challenge: o.challenge.slice(0, 500) };
  }
  if (o?.type !== "event_callback" || !o.event || typeof o.event !== "object") {
    return { kind: "ignore", reason: "not an event_callback" };
  }
  const ev = o.event;
  if (ev.type !== "message" && ev.type !== "app_mention") return { kind: "ignore", reason: `event ${String(ev.type).slice(0, 40)}` };
  if (ev.bot_id || ev.subtype === "bot_message") return { kind: "ignore", reason: "bot message (loop guard)" };
  const text = String(ev.text || "").slice(0, MAX_TEXT).trim();
  if (!text) return { kind: "ignore", reason: "empty text" };
  return {
    kind: "message",
    channel: String(ev.channel || "").slice(0, 40),
    user: String(ev.user || "").slice(0, 40),
    text,
    ts: String(ev.ts || "").slice(0, 40),
    threadTs: String(ev.thread_ts || ev.ts || "").slice(0, 40),
  };
}

export function createSlackAdapter(deps = {}) {
  const getConfig = typeof deps.getConfig === "function" ? deps.getConfig : () => ({ enabled: false, channelAllowlist: [] });
  const getSecret = typeof deps.getSecret === "function" ? deps.getSecret : () => process.env.SLACK_SIGNING_SECRET || "";
  const mintExternal = typeof deps.mintExternal === "function" ? deps.mintExternal : null;
  const cap = deps.cap && typeof deps.cap.consume === "function" ? deps.cap : null;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  // Reply egress seam: injected in tests; live only when a bot token exists. Host-pinned.
  const fetchFn = typeof deps.fetch === "function" ? deps.fetch : (typeof fetch === "function" ? fetch : null);
  const getBotToken = typeof deps.getBotToken === "function" ? deps.getBotToken : () => process.env.SLACK_BOT_TOKEN || "";

  /**
   * The whole ingress decision for one request. Returns { status, body } for the route
   * to serialize — this module never touches req/res.
   */
  function ingest({ timestamp, signature, rawBody }) {
    const cfg = getConfig() || {};
    if (!cfg.enabled) return { status: 403, body: { error: "slack ingress disabled" } };
    const secret = getSecret();
    if (!secret) return { status: 403, body: { error: "slack ingress not configured (no signing secret)" } };
    if (!verifySlackSignature({ signingSecret: secret, timestamp, rawBody, signature, now })) {
      return { status: 401, body: { error: "bad signature" } };
    }

    const parsed = parseSlackIngress(rawBody);
    if (parsed.kind === "challenge") return { status: 200, body: { challenge: parsed.challenge } };
    if (parsed.kind === "ignore") return { status: 202, body: { ok: true, ignored: parsed.reason } };

    const allow = Array.isArray(cfg.channelAllowlist) ? cfg.channelAllowlist : [];
    if (allow.length === 0 || !allow.includes(parsed.channel)) {
      log(`[slack] dropped message from non-allowlisted channel ${parsed.channel}`);
      return { status: 202, body: { ok: true, ignored: "channel not allowlisted" } };
    }
    // Law 3: no cap seam → mint nothing; over cap → drop with a log, never a queue.
    if (!cap) return { status: 202, body: { ok: true, ignored: "no cap store — refusing to mint (Law 3)" } };
    if (!cap.consume(CAP_ID, now())) {
      log(`[slack] daily cap reached — message from ${parsed.channel} dropped`);
      return { status: 202, body: { ok: true, ignored: "daily cap reached" } };
    }
    if (!mintExternal) return { status: 202, body: { ok: true, ignored: "no mint seam" } };

    let row;
    try {
      row = mintExternal({
        source: "slack",
        agentId: `slack-${parsed.user || "unknown"}`,
        externalKey: `slack:${parsed.channel}:${parsed.ts}`, // idempotent per message
        kind: "command",
        title: `Slack request from #${parsed.channel}`,
        summary: parsed.text,
        changes: [],
        externalRef: { channel: parsed.channel, threadTs: parsed.threadTs },
      });
    } catch (e) {
      log(`[slack] mint failed: ${e?.message}`);
      return { status: 202, body: { ok: true, ignored: "mint refused" } };
    }
    return { status: 201, body: { ok: true, id: row.id, deduped: !!row.deduped } };
  }

  /**
   * Reply into the source thread. LIVE only with a bot token; host is PINNED to
   * slack.com — a config value can never point this at another origin. Returns
   * {sent} | {skipped, reason}. Never throws.
   */
  async function postReply({ channel, threadTs, text }) {
    const token = getBotToken();
    if (!token) return { skipped: true, reason: "no bot token" };
    if (!fetchFn) return { skipped: true, reason: "no fetch" };
    try {
      const r = await fetchFn(`https://${SLACK_API_HOST}/api/chat.postMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ channel, thread_ts: threadTs, text: String(text || "").slice(0, MAX_TEXT) }),
      });
      return r && r.ok ? { sent: true } : { skipped: true, reason: `http ${r?.status}` };
    } catch (e) {
      return { skipped: true, reason: String(e?.message || e).slice(0, 200) };
    }
  }

  return { ingest, postReply, CAP_ID };
}
