// Phase G (ADR G-3, D-7) — the app's data-plane answers for the parity diff.
//
// Built from the RECORDED fixtures (api.json), not written from scratch: every response
// keeps the real runtime's shape, and only the values the mockup shows are patched in. A
// patch that names a field the app does not read changes nothing on screen, so a wrong
// field fails the diff instead of passing silently. Grows story by story (G2…G12).

import { fixtureKey, isDataPlanePath, loadFixtures } from "./fixtures.mjs";

/** FREEZE_JS's fixed clock (harness.mjs). Every timestamp here is relative to it. */
export const FIXED = 1786500000000;
const iso = (msAgo) => new Date(FIXED - msAgo).toISOString();
const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const parse = (fixtures, key) => JSON.parse(fixtures[key].body);

// The mockup's stations and their watch (docs/mockups/missionalpha-sketchbook.html STATIONS).
const WATCH = {
  "tech-lead": "on", "pm-analyst": "on", architect: "standby", "sr-backend": "on", "sr-frontend": "on",
  reviewer: "standby", qa: "standby", devops: "off", sre: "standby", "docs-writer": "off",
};
const COLUMN = { on: "in_progress", standby: "idle", off: "offline" };
// The mockup's loop step and heartbeat age per station, read from the mockup at capture.
const STEP = { "tech-lead": ["Plan the change", 0], "pm-analyst": ["Read the goal", 37_800], "sr-backend": ["Edit inside its scope", 37_800],
  "sr-frontend": ["Run the checks", 37_800] };
// The mockup's station tiers (mkSt), in the runtime's vocabulary (captain=supreme, worker=support).
const TIER = { "tech-lead": "principal", "pm-analyst": "principal", architect: "principal", "sr-backend": "senior", "sr-frontend": "senior",
  reviewer: "senior", qa: "senior", devops: "senior", sre: "support", "docs-writer": "support" };

// The mockup's six pending inbox items, as runtime kinds (src/lib/inboxTally.ts), with the
// mockup's SLA (`due: now() + N * MIN`) as an absolute deadline on the frozen clock.
const MIN = 60_000;
// G4 adds what the Inbox page reads: the ref (storyId / jobId), the risk band, the diffstat.
const INBOX = [
  { id: "D-31", kind: "release-approval", agentId: "devops", title: "Replay scrubber · ship to stable", sla: 41, storyId: "S-12", band: "high", stat: [4, 128, 36] },
  { id: "D-30", kind: "code", agentId: "sr-backend", title: "Cache the vault search results", sla: 18, jobId: "J-105", band: "low", stat: [2, 46, 9] },
  { id: "G-18", kind: "design-approval", agentId: "architect", title: "Dark mode for the cockpit · approve the design", sla: 75, storyId: "S-18", band: "medium", stat: [0, 0, 0] },
  { id: "Q-19", kind: "question", agentId: "pm-analyst", title: "Onboarding emails · two questions", sla: 120, storyId: "S-19", band: "low", stat: [0, 0, 0] },
  { id: "C-4", kind: "failure", agentId: "sr-frontend", title: "3 lint failures in src/lib", sla: 30, jobId: "J-102", band: "medium", stat: [0, 0, 0] },
  { id: "D-29", kind: "code", agentId: "docs-writer", title: "Tighten the empty-state copy", sla: 55, jobId: "J-103", band: "low", stat: [1, 2, 2] },
];
// The mockup's D-30 diff (DIFF_A), verbatim.
const DIFF_A = '@@ src/lib/vaultSearch.ts @@\n+import { LRU } from "./lru";\n+const cache = new LRU<string, Hit[]>(200);\n export async function search(q: string) {\n+  const hit = cache.get(q);\n+  if (hit) return hit;\n   const rows = await index.query(q);\n-  return rows;\n+  cache.set(q, rows);\n+  return rows;\n }';
const SUMMARY = { "D-30": "Repeated searches answer from a 200-entry cache.", "D-31": "Adds the scrubber and moves the release channel from beta to stable." };

// The mockup's five jobs (J-101…J-105): three in flight, one shipped, one blocked.
const JOB_STATUS = { "J-101": "building", "J-102": "review", "J-103": "awaiting-you", "J-104": "shipped", "J-105": "blocked" };

// The mockup's doctor chips. The app renders a check's label with its status as the dot,
// so the mockup's chip text is what these checks are called here.
const DOCTOR = [
  ["node", "node ok", "ok"], ["git", "git clean", "ok"], ["docker", "docker running", "ok"],
  ["runtime", "runtime 12 ms", "ok"], ["disk", "disk 81% used", "warn"],
];

// The mockup's eight stories (docs/mockups STORIES): id, title, idea, stage, status, venture,
// minutes since the last update.
const STORIES = [
  ["S-21", "Saved views for the jobs board", "Let me save a filter on the jobs board and come back to it.", "idea", "active", "ma", 6],
  ["S-19", "Onboarding emails, second pass", "The welcome emails read like a manual. Make them shorter.", "requirements", "active", "site", 14],
  ["S-18", "Dark mode for the cockpit", "A dark theme that keeps the brand colours.", "design", "waiting-you", "ma", 22],
  ["S-16", "Vault export to Markdown", "Export the log as Markdown files.", "plan", "active", "ma", 31],
  ["S-15", "Per-station spend caps", "Stop a station when it spends more than a cap.", "build", "active", "ma", 3],
  ["S-14", "Reconnect banner when the live feed drops", "Tell me when the live feed is down instead of showing stale numbers.", "review-qa", "active", "ma", 9],
  ["S-12", "Replay scrubber", "Scrub through a session like a video.", "deploy-watch", "waiting-you", "ma", 40],
  ["S-09", "Station memory editor", "Let me edit what a station always knows.", "accept", "shipped", "site", 90],
];

export function buildParityFixtures(recorded, tab) {
  const out = {};

  const state = parse(recorded, "GET /api/state.json");
  state.generatedAt = iso(0);
  state.counts = { total: 11, active: 1, inProgress: 1, blocked: 1, stale: 0, offline: 0 };
  state.agents = state.agents.map((a) => {
    const w = WATCH[a.id];
    if (!w) return a;
    return { ...a, tier: TIER[a.id] ?? a.tier, column: COLUMN[w], state: w === "on" ? "RUNNING" : w === "off" ? "OFFLINE" : "IDLE",
      heartbeatAt: iso(STEP[a.id]?.[1] ?? 37_800), stale: false, dead: false, task: STEP[a.id]?.[0] ?? "Read the goal" };
  });
  out["GET /api/state.json"] = json(state);

  const base = parse(recorded, "GET /inbox?limit=1").deliveries[0];
  // createdAt steps back in the mockup's order (the list is newest-first); a code delivery
  // names its changed files (isFailure() reads an empty list as "agent stuck").
  const PATHS = { "D-31": ["src/components/replay/Scrubber.tsx", "src/components/replay/index.ts", "electron/channel.cjs", "docs/release.md"],
    "D-30": ["src/lib/vaultSearch.ts", "src/lib/lru.ts"], "D-29": ["src/components/EmptyState.tsx"] };
  const deliveries = INBOX.map(({ sla, band, stat: [files, additions, deletions], ...d }, i) => ({
    ...base, storyId: null, jobId: null, ...d, status: "pending", source: "swarm", slaDeadline: iso(-sla * MIN),
    createdAt: iso((i + 1) * MIN), changedPaths: PATHS[d.id] ?? [],
    risk: { score: null, band, reasons: [] }, summary: SUMMARY[d.id] ?? d.title,
    diffstat: { ...base.diffstat, files, additions, deletions }, diffFiles: files, diffAdditions: additions, diffDeletions: deletions,
  }));
  out["GET /inbox?limit=200&status=pending"] = json({ deliveries, counts: { pending: INBOX.length } });
  // G3 — the Command center's Needs-you list (NEEDS_LIMIT = 5).
  out["GET /inbox?limit=5&status=pending"] = json({ deliveries: deliveries.slice(0, 5), counts: { pending: INBOX.length } });

  // G9 — Workflows: the mockup's five cadences. The frozen clock is Wed 02:00 UTC, so the
  // next Monday 09:00 is +5d7h and the next Friday 16:00 is +2d14h. The SRE watch runs on an
  // expression this build has no word for ("every 15 min"); the client shows it verbatim.
  const H = 3_600_000, D = 24 * H;
  const cad = (id, skill, agent, expr, hour, enabled, lastAgo, lastStatus, nextIn) => ({
    id, skill, agent, venture: "ma", expr, hour, enabled, next_run: FIXED + nextIn, last_run: FIXED - lastAgo, last_status: lastStatus, last_fired_slot: null });
  out["GET /runtime/cadence"] = json({ cadences: [
    cad("wf1", "nightly-repo-health", "devops", "daily", 2, true, 9 * H, "dispatched", D),
    cad("wf2", "story-triage", "tech-lead", "daily", 9, true, 4 * H, "dispatched", 7.5 * H),
    cad("wf3", "SRE-watch", "sre", "every 15 min", null, true, 6 * MIN, "dispatched", 9 * MIN),
    cad("wf4", "weekly-dependency-sweep", "sr-backend", "weekly", 9, true, 3 * D, "error", 5 * D + 7 * H),
    cad("wf5", "release-notes-digest", "docs-writer", "weekly", 16, false, 5 * D, "dispatched", 2 * D + 14 * H),
  ] });
  // G9 — Schedule: the mockup's seven slots of today's watch are not its five workflows (it
  // adds two story windows and an evening summary), so its capture runs on its own runtime
  // state: seven timed cadences at the mockup's hours. Workflows keeps the five above.
  if (tab === "schedule") out["GET /runtime/cadence"] = json({ cadences: [
    cad("sc1", "nightly-repo-health", "devops", "daily", 2, true, D, "dispatched", D),
    cad("sc2", "weekly-dependency-sweep", "sr-backend", "weekly", 9, true, 2 * D + 17 * H, "dispatched", 5 * D + 7 * H),
    cad("sc3", "story-triage", "tech-lead", "daily", 9, true, 17 * H, "dispatched", 7 * H),
    cad("sc4", "build-window-S-15", "sr-backend", "daily", 11, true, 15 * H, "dispatched", 9 * H),
    cad("sc5", "review-window-S-14", "qa", "daily", 14, true, 12 * H, "dispatched", 12 * H),
    cad("sc6", "release-notes-digest", "docs-writer", "weekly", 16, false, 5 * D, "dispatched", 2 * D + 14 * H),
    cad("sc7", "SRE-watch-summary", "sre", "daily", 18, true, 8 * H, "dispatched", 16 * H),
  ] });

  // G10 — Outputs: the mockup's three artifacts as produced records. The server lists newest
  // first, so their ages keep the mockup's order; the audit generator stays as recorded.
  out["GET /runtime/outputs"] = json({ ...parse(recorded, "GET /runtime/outputs"), outputs: [
    ["release-notes-S-09.md", "Release notes", 52], ["J-101-footer-links.diff", "Diff", 88], ["repo-health-0200.json", "Report", 9 * 60],
  ].map(([label, kind, min]) => ({ id: label, kind, venture: "ma", label, ref: `/runtime/outputs/${label}`, createdAt: FIXED - min * MIN })) });

  // G8 — Agents: every station in Ask mode, the mockup's 128 records read, $1.68 metered
  // spend per station (the mockup's seeded spend; its total on the Command center is a delta).
  for (const id of Object.keys(WATCH)) {
    const key = `GET /runtime/${id}/perm-mode`;
    if (recorded[key]) out[key] = json({ ...parse(recorded, key), effective: "default", permMode: null });
  }
  out["GET /runtime/spend?window=24h"] = json({ ...parse(recorded, "GET /runtime/spend?window=7d"), windowMs: 86_400_000, usd: 16.82, meteredTurns: 41, activeMetered: true,
    agents: Object.keys(WATCH).map((agentId) => ({ agentId, meteredTurns: 4, unpricedTurns: 0, usd: 1.68 })) });

  // G7 — CEO brief: the mockup's seven log rows at capture (who, line, minutes ago). Only
  // delivery.created carries a free title on the wire, so each row is one.
  const LOG = [["tech-lead", "Team ready on ~/code/my-app", 0], ["devops", "Nightly repo health finished: 0 issues", 4], ["tech-lead", "Split S-15 into two goals", 8],
    ["sr-backend", "Opened a branch for per-station caps", 12], ["qa", "S-14: 11 passed, 0 skipped", 16],
    ["architect", "Design for S-18 is ready for the BOSS", 20], ["sr-frontend", "J-102: renamed the route", 24]];
  out["GET /runtime/brief/log?hours=24"] = json({ hours: 24, events: LOG.map(([agentId, title, min], i) => ({
    seq: 9000 - i, name: "delivery.created", ts: iso(min * MIN), data: { id: `log-${i}`, agentId, title, kind: "code" } })) });

  // G6 — Missions: the mockup opens the Tech Lead chat empty, in Ask mode.
  out["GET /runtime/config"] = json({ ...parse(recorded, "GET /runtime/config"), permissionMode: "default" });
  out["GET /runtime/boss/thread"] = json({ ...parse(recorded, "GET /runtime/boss/thread"), messages: [] });

  // G5 — the Stories board.
  const story0 = JSON.parse(recorded["GET /runtime/stories"].body).stories[0];
  out["GET /runtime/stories"] = json({ stories: STORIES.map(([id, title, idea, stage, status, venture, min]) => ({
    ...story0, id, title, idea, stage, status, venture, answers: null, createdAt: FIXED - 86_400_000, updatedAt: FIXED - min * MIN })) });

  // G4 — the Inbox page: the list, the two details the review opens, the day's score.
  out["GET /inbox?limit=100"] = json({ deliveries, counts: { pending: INBOX.length, auto_approved: 3 } });
  const detail = (id, patch) => {
    const d = deliveries.find((x) => x.id === id);
    const reasons = id === "D-30" ? ["Unit 18 passed, 0 skipped", "Cache-hit test added"] : ["changes the release channel"];
    return json({ ...d, risk: { ...d.risk, reasons }, changes: [{ path: patch.split(" @@")[0].replace("@@ ", ""), status: "modified", before: "", after: "", patch, editable: true }] });
  };
  out["GET /inbox/D-30"] = detail("D-30", DIFF_A);
  out["GET /inbox/D-31"] = detail("D-31", "@@ src/components/replay/Scrubber.tsx @@\n+export function Scrubber() {}");
  out["GET /runtime/scoreboard?window=1d"] = json({ ...parse(recorded, "GET /runtime/scoreboard?window=1d"), approved: 3, decided: 5 });

  // G3 — Command center: readiness, doctor, the four tiles, the ventures list.
  out["GET /runtime/engine/readiness"] = json({
    ...parse(recorded, "GET /runtime/engine/readiness"),
    ready: true, standing: "runs", capability: "swarm", refusal: null, explanation: "Claude drives the CLI",
    account: { id: "acct-1", label: "Claude Code", providerType: "claude-cli", model: "sonnet", authMethod: "subscription" },
    spendCap: "$40/day",
  });
  out["GET /runtime/doctor"] = json({
    status: "warn",
    checks: DOCTOR.map(([id, label, status]) => ({ id, label, status, detail: label })),
    summary: { ok: 4, warn: 1, fail: 0 },
  });
  const jobs = JSON.parse(recorded["GET /runtime/jobs"].body).jobs[0];
  out["GET /runtime/jobs"] = json({ jobs: Object.entries(JOB_STATUS).map(([id, status], i) => ({ ...jobs, id, status, title: id, createdAt: FIXED - (i + 1) * 3_600_000, updatedAt: FIXED - i * 600_000 })) });

  out["GET /runtime/quota"] = json({ count: 67, max: 200, windowMs: 18_000_000, paused: false });
  out["GET /runtime/workspace"] = json({ repoPath: "~/code/my-app", isGit: true });

  const vault = parse(recorded, "GET /runtime/vault/stats");
  const kpis = parse(recorded, "GET /runtime/bos/kpis?window=1d");
  out["GET /runtime/bos/kpis?window=1d"] = json({ ...kpis, jobsShipped: 2, prsShipped: 1, pendingDeliveries: INBOX.length,
    ventures: [{ id: "ma", name: "MissionAlpha", records: 6, pending: 4 }, { id: "site", name: "Sketchbook site", records: 2, pending: 2 }] });

  vault.total = 128;
  vault.ventures = [
    { id: "ma", name: "MissionAlpha", createdAt: iso(86_400_000), records: 6 },
    { id: "site", name: "Sketchbook site", createdAt: iso(86_400_000), records: 2 },
  ];
  out["GET /runtime/vault/stats"] = json(vault);

  // G10 — Knowledge vault: the mockup's eight records. Its kinds are not the
  // runtime's nodes, so each takes the node at the same graph position (decisions stays the
  // centre). The server lists newest first, so ages keep the mockup's order. The Agents
  // capture keeps the 128 above; this tab's runtime holds the eight.
  // G10 — Accounts: the mockup's two accounts (a Claude subscription, active; an OpenAI key)
  // and its three CLI engines. Secrets never travel: `hasSecret` is all the wire carries.
  // Landing + Setup (spec §8): a fresh install — no accounts, no workspace chosen, the
  // mockup's two engines (Claude Code CLI found and the spawn engine; Codex CLI not found).
  // Upgrade path (spec §5.1, amendment 1): no flag, but an active account and a chosen workspace.
  if (tab === "first-run-upgrade") {
    out["GET /runtime/accounts"] = json({ ...parse(recorded, "GET /runtime/accounts"), activeAccountId: "a1", accounts: [
      { id: "a1", providerType: "claude", label: "Claude subscription", authMethod: "subscription", hasSecret: false, capability: "swarm", createdAt: FIXED - 86_400_000 }] });
    out["GET /runtime/workspace"] = json({ repoPath: "~/code/my-app", configured: "~/code/my-app", configDir: "~/.missionalpha/config", isGit: true, seedDirs: [], envPinned: false, gh: { installed: false, authed: false } });
  }
  // Account step cases (spec AC-S4…S8): the same fresh install, with the accounts that decide the plan.
  if (tab === "first-run" || tab === "first-run-activate" || tab === "first-run-confirm") {
    out["POST /runtime/accounts"] = json({ ok: true, account: { id: "new-sub", providerType: "claude", label: "Claude subscription", authMethod: "subscription", hasSecret: false, capability: "swarm", createdAt: FIXED } });
    out["POST /runtime/accounts/active"] = json({ ok: true, activeAccountId: "new-sub", capability: "swarm" });
    out["POST /runtime/workspace"] = json({ ok: true, repoPath: "~/code/my-app", active: "/repo", restartRequired: true, envPinned: false });
  }
  if (tab === "first-run-activate" || tab === "first-run-confirm") {
    const sub = { id: "sub1", providerType: "claude", label: "Claude subscription", authMethod: "subscription", hasSecret: false, capability: "swarm", createdAt: FIXED - 86_400_000 };
    const key = { id: "key1", providerType: "openai", label: "OpenAI · work", authMethod: "api_key", hasSecret: true, capability: "chat_only", createdAt: FIXED - 86_400_000 };
    out["GET /runtime/accounts"] = json({ ...parse(recorded, "GET /runtime/accounts"), accounts: [sub, key], activeAccountId: tab === "first-run-confirm" ? "sub1" : "key1" });
    out["GET /runtime/workspace"] = json({ repoPath: "~/code/my-app", configured: null, configDir: "~/.missionalpha/config", isGit: true, seedDirs: [], envPinned: false, gh: { installed: false, authed: false } });
    out["GET /runtime/engines"] = json({ at: FIXED, spawnEngine: "claude", engines: [{ id: "claude", label: "Claude Code CLI", bin: "claude", found: true, path: "/usr/local/bin/claude", promptDelivery: "flag", installCommand: null, docsUrl: null }] });
  }
  if (tab === "first-run-noengine") {
    out["GET /runtime/accounts"] = json({ ...parse(recorded, "GET /runtime/accounts"), accounts: [], activeAccountId: null });
    out["GET /runtime/workspace"] = json({ repoPath: "~/code/my-app", configured: null, configDir: "~/.missionalpha/config", isGit: true, seedDirs: [], envPinned: false, gh: { installed: false, authed: false } });
    out["GET /runtime/engines"] = json({ at: FIXED, spawnEngine: "claude", engines: [{ id: "claude", label: "Claude Code CLI", bin: "claude", found: false, path: null, promptDelivery: "flag", installCommand: "npm install -g @anthropic-ai/claude-code", docsUrl: null }] });
  }
  if (tab === "first-run") {
    out["GET /runtime/accounts"] = json({ ...parse(recorded, "GET /runtime/accounts"), accounts: [], activeAccountId: null });
    out["GET /runtime/workspace"] = json({ repoPath: "~/code/my-app", configured: null, configDir: "~/.missionalpha/config", isGit: true, seedDirs: [], envPinned: false, gh: { installed: false, authed: false } });
    out["GET /runtime/engines"] = json({ at: FIXED, spawnEngine: "claude", engines: [["claude", "Claude Code CLI", true], ["codex", "Codex CLI", false]]
      .map(([id, label, found]) => ({ id, label, bin: id, found, path: found ? `/usr/local/bin/${id}` : null, promptDelivery: "flag", installCommand: null, docsUrl: null })) });
  }
  if (tab === "accounts") {
    const acc = parse(recorded, "GET /runtime/accounts");
    out["GET /runtime/accounts"] = json({ ...acc, activeAccountId: "a1", accounts: [
      { id: "a1", providerType: "claude", label: "Claude subscription · personal", authMethod: "subscription", hasSecret: false, capability: "swarm", createdAt: FIXED - 30 * 86_400_000 },
      { id: "a2", providerType: "openai", label: "OpenAI · work", authMethod: "api_key", hasSecret: true, capability: "chat_only", createdAt: FIXED - 9 * 86_400_000 },
    ] });
    out["GET /runtime/engines"] = json({ at: FIXED, spawnEngine: "claude", engines: [["claude", "Claude Code CLI", true], ["codex", "Codex CLI", false], ["gemini", "Gemini CLI", false]]
      .map(([id, label, found]) => ({ id, label, bin: id, found, path: found ? `/usr/local/bin/${id}` : null, promptDelivery: "flag", installCommand: null, docsUrl: null })) });
    out["GET /runtime/chat-account"] = json({ chatAccountId: "a1", mode: "cli", reason: "Chat answers through the Claude CLI on the active subscription.", choices: [
      { id: "a1", label: "Claude subscription · personal", providerType: "claude", model: null, via: "cli", usable: true, why: null },
      { id: "a2", label: "OpenAI · work", providerType: "openai", model: null, via: null, usable: false, why: "No model id set" },
    ] });
  }
  if (tab === "vault") {
    const REC = [["r1", "decisions", "Footer links live in one row", "tech-lead", 52, "One row on desktop, stacked on phones. Decided on J-101."],
      ["r2", "ventures", "Copy tone: plain, no exclamation marks", "docs-writer", 70, ""], ["r3", "market", "S-09 Station memory editor shipped", "docs-writer", 90, ""],
      ["r4", "content", "Nightly repo health · 0 issues", "devops", 9 * 60, ""], ["r5", "pipeline", "BOSS prefers diffs under 200 lines", "tech-lead", 30 * 60, ""],
      ["r6", "tech", "Seat limit is 3 on this machine", "devops", 48 * 60, ""],
      ["r7", "decisions", "Confetti on every press: killed", "tech-lead", 50 * 60, ""], ["r8", "ventures", "Footer: test the stacked layout at 375px", "qa", 52 * 60, ""]];
    const meta = ([id, node, title, author, min]) => ({ id, venture: "ma", node, title, author, sourceRun: null, createdAt: iso(min * MIN), excerpt: "" });
    out["GET /runtime/vault/stats"] = json({ ...vault, total: 8, byNode: { decisions: 2, ventures: 2, market: 1, content: 1, pipeline: 1, tech: 1 } });
    out["GET /runtime/vault?limit=20"] = json({ records: REC.map(meta) });
    out["GET /runtime/vault/record?id=r1"] = json({ meta: meta(REC[0]), body: REC[0][5] });
    out["GET /runtime/tech-lead/memory"] = json({ agentId: "tech-lead", memory: "Keep diffs under 200 lines. Ask the BOSS before touching auth.", size: 60, max: 8000 });
  }
  return out;
}

/**
 * Layer the parity answers over installHermetic's recorded fixtures. Registered AFTER
 * installHermetic, so Playwright consults it first; anything it does not name falls back
 * to the recorded fixture (and from there to the harness's "missing" report).
 */
export async function installParityFixtures(page, tab) {
  const parity = buildParityFixtures(await loadFixtures(), tab);
  const served = new Set();
  await page.route((url) => { try { return isDataPlanePath(new URL(url).pathname); } catch { return false; } }, async (route) => {
    const key = fixtureKey(route.request().method(), route.request().url());
    const hit = parity[key];
    if (!hit) return route.fallback();
    served.add(key);
    return route.fulfill(hit);
  });
  return served;
}

/** Electron-only signals a browser render cannot have (D-4, the strip's docker/breaker). */
// The operator's per-station model choice (src/lib/agentModel.ts), as the mockup assigns it.
const MODELS = { "tech-lead": "opus", "pm-analyst": "sonnet", architect: "opus", "sr-backend": "sonnet", "sr-frontend": "sonnet",
  reviewer: "opus", qa: "sonnet", devops: "haiku", sre: "haiku", "docs-writer": "haiku" };

export const PARITY_BRIDGE_JS = `
  (() => {
    try { for (const [id, tier] of Object.entries(${JSON.stringify(MODELS)})) localStorage.setItem("ma.agent.model." + id, tier); } catch { /* storage blocked */ }
    // Only onPreflight: no isPackaged, so the app stays in browser mode (runtimeBase.ts) and
    // the title bar keeps the mockup's padding (main.tsx keys the Electron inset on it).
    globalThis.missionAlpha = { onPreflight(cb) { setTimeout(() => cb({ claude: true, docker: true, auth: true, ok: true, blocking: false, messages: [] }), 0); } };
    const Base = globalThis.EventSource;
    globalThis.EventSource = class extends Base {
      constructor(url) {
        super(url);
        // Every runtime frame carries an id (agent-runtime/events.mjs frame()); so do these.
        let seq = 0;
        const fire = (name, data) => { const ev = new MessageEvent(name, { data: JSON.stringify(data), lastEventId: String(++seq) }); for (const fn of this._listeners.get(name) || []) fn(ev); };
        setTimeout(() => {
          fire("breaker.state", { agentId: "tech-lead", level: "healthy" });
          // G3 — the Command center's activity stream: the mockup holds 7 events at capture.
          const who = ["devops", "tech-lead", "sr-backend", "qa", "sr-frontend"];
          for (let i = 0; i < 7; i++) fire("task.done", { agentId: who[i % who.length], taskId: "task_" + i });
        }, 50);
      }
    };
  })();
`;

/**
 * First-run bridge: the preflight answer the cockpit needs, and NO automatic runtime events
 * (the parity bridge fires seven, which would make the landing show a real feed). A test that
 * needs a real event pushes one with window.__fireSSE(name, data).
 */
export const FIRST_RUN_BRIDGE_JS = `
  (() => {
    globalThis.missionAlpha = { onPreflight(cb) { setTimeout(() => cb({ claude: true, docker: true, auth: true, ok: true, blocking: false, messages: [] }), 0); } };
    const Base = globalThis.EventSource; const live = []; let seq = 0;
    globalThis.EventSource = class extends Base { constructor(url) { super(url); live.push(this); } };
    globalThis.__fireSSE = (name, data) => { const ev = new MessageEvent(name, { data: JSON.stringify(data), lastEventId: String(++seq) }); let n = 0; for (const es of live) for (const fn of es._listeners.get(name) || []) { fn(ev); n += 1; } return n; };
  })();
`;
