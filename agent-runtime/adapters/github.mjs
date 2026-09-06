// P7 / ADR-054 — GitHub PR ingestion adapter (the moat).
//
// Cursor, Codex and Devin all end their loop at "a PR to review". One integration
// covers every vendor because they converged on PRs. This adapter POLLS `gh` for PRs
// authored by configured bot accounts, mints each as a source='github-pr' Delivery
// (diff via `gh pr diff --patch`, risk-classified by the P6 router), and maps the three
// decide verbs back to gh. State sync is TWO-WAY: a PR merged/closed directly on GitHub
// reconciles the matching Delivery on the next poll.
//
// SECURITY (ADR-054, BLOCKING — untrusted external content + outbound gh actions):
//   • Every gh call is an argv array with shell:false (the injected runner is pr.mjs's
//     defaultRunner, whose safeEnv strips *_TOKEN/*_KEY/*_SECRET from the child env).
//     The gh token lives in gh's own keychain — this module never reads/stores/logs it.
//   • PR titles/bodies/author/diff are UNTRUSTED. They are handed to deliveries.mintExternal,
//     which scrubs (SECRET_RE + extended shapes + control chars) at rest and on egress.
//     They are NEVER interpolated into a shell and NEVER fed into an agent prompt.
//   • Idempotent by repo#number@head-sha: the same PR at the same sha never mints twice.
//   • A github-pr Delivery can NEVER auto-apply (deliveries.autoApprove refuses source!==swarm).
//   • A poll failure (gh logged out, network) becomes a VISIBLE adapter-status, never a
//     silent vanish and never a crash.

import { defaultRunner, isSafePrUrl } from "../pr.mjs";
import { scan as scanInjection, flagSummary as injectFlagSummary } from "../inject-detect.mjs";

// gh pr list --json fields we request. Kept minimal; each is read as data.
// `body` is requested because R12 scans it for injection shapes; without it the scan
// would only ever see the title, which is the least interesting half of the surface.
const PR_FIELDS = "number,title,body,author,headRefName,headRefOid,url,updatedAt,state,isDraft,mergedAt";
const MAX_PRS = 100;
const MAX_BODY = 4000;
const DEFAULT_POLL_MS = 60_000;

// Bot author tokens go into a single `--search` argv token (never a shell). Still keep
// them to a safe charset — a login can carry letters/digits/-/_/./[]/ and an app path.
const sanitizeAuthor = (a) => String(a || "").replace(/[^a-zA-Z0-9_.[\]/-]/g, "").slice(0, 80);

// Dependency manifests — an added line in one of these floors the risk band at medium.
const MANIFEST_RE = /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|cargo\.toml|gemfile|pom\.xml|build\.gradle(\.kts)?)$/i;

/** Build the `--search` value: author:app/<bot> OR author:<bot>, OR-joined across bots. */
export function searchQueryFor(botAuthors) {
  const terms = [];
  for (const raw of Array.isArray(botAuthors) ? botAuthors : []) {
    const a = sanitizeAuthor(raw);
    if (!a) continue;
    if (a.includes("/")) terms.push(`author:${a}`);
    else { terms.push(`author:app/${a}`); terms.push(`author:${a}`); }
  }
  return terms.join(" OR ");
}

/** owner/repo from a PR url (https://github.com/owner/repo/pull/N). "" if not github. */
export function repoFromUrl(url) {
  try {
    const u = new URL(String(url));
    if (!/^(.+\.)?github\.com$/.test(u.hostname)) return "";
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/\d+/);
    return m ? `${m[1]}/${m[2]}` : "";
  } catch { return ""; }
}

/**
 * Parse `gh pr diff --patch` (a multi-file unified diff) into per-file change records.
 * Header noise (`diff --git`, `index`, mode/rename lines) is dropped so each file's
 * patch is the clean `--- / +++ / @@ / ±context` shape the Inbox already renders. Pure.
 */
export function parsePrDiff(text) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur) { if (!cur.path) cur.path = cur.gitPath || cur.aPath || ""; if (cur.path) out.push(pick(cur)); } cur = null; };
  const pick = (c) => ({ path: c.path, patch: c.patch, additions: c.additions, deletions: c.deletions, status: c.status });
  for (const line of String(text || "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      cur = { path: "", gitPath: m ? m[2] : "", aPath: "", patch: "", additions: 0, deletions: 0, status: "modified", started: false };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("--- ")) {
      cur.started = true;
      const p = line.slice(4).replace(/^a\//, "").trim();
      if (!p || p === "/dev/null") cur.status = "new"; else cur.aPath = p;
      cur.patch += line + "\n";
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).replace(/^b\//, "").trim();
      if (!p || p === "/dev/null") { cur.status = "deleted"; cur.path = cur.aPath; } else cur.path = p;
      cur.patch += line + "\n";
      continue;
    }
    if (!cur.started) continue; // skip index/mode/rename noise until the file body
    if (line.startsWith("+")) cur.additions++;
    else if (line.startsWith("-")) cur.deletions++;
    cur.patch += line + "\n";
  }
  flush();
  return out;
}

/** true if any changed manifest gained lines (over-flags a version bump → err to medium). */
function addsDependency(changes) {
  return changes.some((c) => MANIFEST_RE.test(c.path) && c.additions > 0);
}

export function createGithubAdapter(opts = {}) {
  const deliveries = opts.deliveries;
  if (!deliveries) throw new Error("createGithubAdapter: deliveries required");
  const runner = opts.runner || defaultRunner();
  const log = opts.log || (() => {});
  // R10: optional trust recorder. A null trust seam changes nothing.
  const trust = opts.trust || null;
  const rec = (kind, payload) => { try { trust?.record?.("github-pr", kind, payload); } catch { /* bookkeeping never blocks ingestion */ } };
  const cfg = opts.config || {};
  const config = {
    botAuthors: Array.isArray(cfg.botAuthors) ? cfg.botAuthors.filter(Boolean).slice(0, 50) : [],
    repo: typeof cfg.repo === "string" && cfg.repo ? cfg.repo : null,
    pollIntervalMs: Math.max(10_000, Number(cfg.pollIntervalMs) || DEFAULT_POLL_MS),
    mergeOnApprove: !!cfg.mergeOnApprove, // default OFF — approve only posts a review
  };
  const state = { active: false, polling: false, lastPollAt: null, lastError: null, authenticated: null, minted: 0, reconciled: 0, prsSeen: 0 };
  let timer = null;

  const gh = (args) => runner.run("gh", args, { shell: false });
  const ghErr = (r) => String(r?.stderr || r?.stdout || "gh failed").trim().slice(0, 300);
  const notAuthed = (s) => /not.*log|auth status|gh auth|command not found|ENOENT|spawn gh|not found/i.test(String(s || ""));
  const safeUrl = (u) => (isSafePrUrl(u) ? String(u) : null);
  const repoArgs = (meta) => (meta && meta.repo ? ["--repo", String(meta.repo)] : config.repo ? ["--repo", config.repo] : []);

  // ── one poll cycle ──────────────────────────────────────────────────────────
  async function poll() {
    if (!config.botAuthors.length) { state.lastError = "no bot authors configured"; return { minted: 0, reconciled: 0, error: state.lastError }; }
    state.polling = true;
    try {
      const search = searchQueryFor(config.botAuthors);
      const listArgs = ["pr", "list", "--json", PR_FIELDS, "--state", "all", "--limit", String(MAX_PRS), "--search", search];
      if (config.repo) listArgs.push("--repo", config.repo);
      const r = await gh(listArgs);
      if (!r.ok) {
        rec("polls", { ok: false });
        state.lastError = ghErr(r);
        state.authenticated = notAuthed(state.lastError) ? false : state.authenticated;
        return { minted: 0, reconciled: 0, error: state.lastError };
      }
      rec("polls", { ok: true });
      state.authenticated = true;
      let prs;
      try { prs = JSON.parse(r.stdout || "[]"); } catch { state.lastError = "gh returned unparseable JSON"; return { minted: 0, reconciled: 0, error: state.lastError }; }
      if (!Array.isArray(prs)) prs = [];
      state.prsSeen = prs.length;

      let minted = 0, reconciled = 0;
      const byNumber = new Map(); // repo#number → pr (for state sync)

      for (const pr of prs.slice(0, MAX_PRS)) {
        const number = Number(pr?.number);
        if (!Number.isInteger(number)) continue;
        const repo = config.repo || repoFromUrl(pr?.url) || "unknown";
        byNumber.set(`${repo}#${number}`, { ...pr, repo, number });

        // Only OPEN, non-draft PRs are mint candidates; MERGED/CLOSED drive state-sync below.
        if (String(pr?.state).toUpperCase() !== "OPEN" || pr?.isDraft) continue;
        const headSha = String(pr?.headRefOid || pr?.updatedAt || "").slice(0, 64);
        const externalKey = `ghpr:${repo}#${number}@${headSha}`;
        if (deliveries.findByExternalKey(externalKey)) continue; // idempotent

        if (await mintPr({ pr, repo, number, headSha, externalKey })) minted++;
      }

      // ── TWO-WAY state sync ────────────────────────────────────────────────────
      // A pending github-pr Delivery whose PR is now MERGED/CLOSED on GitHub gets
      // reconciled (merged→approved, closed→rejected) with NO gh call.
      for (const d of deliveries.listExternalPending("github-pr")) {
        const meta = d.externalMeta || {};
        const key = `${meta.repo}#${meta.prNumber}`;
        const pr = byNumber.get(key);
        if (!pr) continue;
        const st = String(pr.state).toUpperCase();
        if (st === "MERGED" || pr.mergedAt) { deliveries.reconcileExternal(d.id, { status: "approved", by: "github", reason: "merged on GitHub" }); reconciled++; }
        else if (st === "CLOSED") { deliveries.reconcileExternal(d.id, { status: "rejected", by: "github", reason: "closed on GitHub" }); reconciled++; }
      }

      state.minted += minted;
      state.reconciled += reconciled;
      state.lastError = null;
      state.lastPollAt = new Date((opts.now || Date.now)()).toISOString();
      return { minted, reconciled };
    } catch (e) {
      state.lastError = String(e?.message || e).slice(0, 300);
      log(`[adapter:github] poll error: ${state.lastError}`);
      return { minted: 0, reconciled: 0, error: state.lastError };
    } finally {
      state.polling = false;
    }
  }

  async function mintPr({ pr, repo, number, headSha, externalKey }) {
    const diffArgs = ["pr", "diff", String(number), "--patch"];
    if (config.repo) diffArgs.push("--repo", config.repo);
    const d = await gh(diffArgs);
    if (!d.ok) { state.lastError = `gh pr diff #${number}: ${ghErr(d)}`; return false; }
    const changes = parsePrDiff(d.stdout).slice(0, 200);
    if (!changes.length) return false; // no reviewable diff
    // Phase 3 / R12 — scan the UNTRUSTED PR text for prompt-injection shapes. Anyone who
    // can open a PR against a watched repo can write text a downstream model will read;
    // that is the surface. The scan FLAGS and can only RAISE the risk band — it never
    // rejects, never strips, never rewrites. The operator sees the original content with
    // the suspicious spans marked, because filtering would hide the attack from the only
    // party able to judge it.
    const injectScan = scanInjection(`${pr?.title || ""}\n\n${pr?.body || ""}`);
    const injectFlags = injectFlagSummary(injectScan);
    // A detected injection shape is a THREAT SIGNAL for this source. Downgrades are
    // instant by design — one hit zeroes the score regardless of prior history.
    if (injectFlags) rec("threats", { patterns: injectFlags.patterns });
    // Guarded like rec(): a trust store that throws must cost a STAMP, never the
    // ingest. An unguarded call here would let bookkeeping veto a real PR.
    let trustStamp = null;
    try { trustStamp = trust?.stampFor ? trust.stampFor("github-pr") : null; }
    catch { trustStamp = null; }
    try {
      const out = deliveries.mintExternal({
        source: "github-pr",
        agentId: String(pr?.author?.login || "external-bot"),
        externalKey,
        kind: "code",
        title: String(pr?.title || `PR #${number}`),
        summary: `GitHub PR #${number} by ${pr?.author?.login || "?"} on ${repo} (${pr?.headRefName || "?"}).`,
        newDependency: addsDependency(changes),
        changes,
        externalMeta: {
          repo, prNumber: number, headSha,
          url: safeUrl(pr?.url), branch: String(pr?.headRefName || "").slice(0, 200),
          author: String(pr?.author?.login || "").slice(0, 80), updatedAt: String(pr?.updatedAt || "").slice(0, 40),
          readOnly: false,
          // R12: the flag summary rides in externalMeta (already-persisted JSON) rather
          // than a new column — a migration for an advisory marker would be heavier than
          // the marker. Counts + pattern ids only; never the attacker's prose.
          injectFlags,
          trust: trustStamp,
        },
      });
      return out && !out.deduped;
    } catch (e) {
      state.lastError = `mint #${number}: ${String(e?.message || e).slice(0, 200)}`;
      return false;
    }
  }

  // ── outbound decide (wired into deliveries.externalDecideFn) ─────────────────
  async function decideExternal({ verb, meta, feedback } = {}) {
    const number = meta && Number.isInteger(Number(meta.prNumber)) ? String(Number(meta.prNumber)) : null;
    if (!number) return { ok: false, error: "no PR number on this delivery" };
    const ra = repoArgs(meta);
    try {
      if (verb === "approve") {
        const r = await gh(["pr", "review", number, ...ra, "--approve"]);
        if (!r.ok) return { ok: false, error: ghErr(r) };
        if (config.mergeOnApprove) {
          const m = await gh(["pr", "merge", number, ...ra, "--squash"]);
          // The review IS posted; a failed merge does not un-approve. Report both truths.
          if (!m.ok) return { ok: true, action: "approved", url: safeUrl(meta.url), warn: ghErr(m) };
          return { ok: true, action: "approved+merged", url: safeUrl(meta.url) };
        }
        return { ok: true, action: "approved", url: safeUrl(meta.url) };
      }
      if (verb === "request_changes") {
        const r = await gh(["pr", "review", number, ...ra, "--request-changes", "-b", String(feedback || "").slice(0, MAX_BODY)]);
        if (!r.ok) return { ok: false, error: ghErr(r) };
        return { ok: true, action: "changes_requested", url: safeUrl(meta.url) };
      }
      if (verb === "reject") {
        const r = await gh(["pr", "close", number, ...ra, "-c", String(feedback || "Closed from MissionAlpha").slice(0, MAX_BODY)]);
        if (!r.ok) return { ok: false, error: ghErr(r) };
        return { ok: true, action: "closed", url: safeUrl(meta.url) };
      }
      return { ok: false, error: `unknown verb ${verb}` };
    } catch (e) {
      return { ok: false, error: String(e?.message || e).slice(0, 300) };
    }
  }

  function status() {
    const enabled = !!opts.enabled;
    let s;
    if (!enabled) s = "disabled";
    else if (state.lastError && notAuthed(state.lastError)) s = "gh-not-authed";
    else if (state.lastError) s = "error";
    else s = state.active ? "running" : "idle";
    return {
      adapter: "github",
      enabled,
      running: state.active,
      state: s,
      authenticated: state.authenticated,
      lastPollAt: state.lastPollAt,
      lastError: state.lastError,
      botAuthors: config.botAuthors,
      repo: config.repo,
      pollIntervalMs: config.pollIntervalMs,
      mergeOnApprove: config.mergeOnApprove,
      counts: { minted: state.minted, reconciled: state.reconciled, prsSeen: state.prsSeen },
    };
  }

  function start() {
    if (state.active) return;
    state.active = true;
    void poll();
    timer = setInterval(() => { void poll(); }, config.pollIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    state.active = false;
  }

  return { name: "github", poll, decideExternal, status, start, stop };
}
