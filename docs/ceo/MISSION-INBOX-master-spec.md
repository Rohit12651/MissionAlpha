# MissionAlpha → The Agent Inbox — Master Spec & End-to-End Build Order

**Slug:** `mission-inbox-master-spec`
**Author:** CEO agent (with BOSS direction, 2026-07-29)
**Status:** SPEC — AWAITING_USER_GO
**Supersedes sequencing of:** `master-roadmap.md` stages (absorbs S1/S2 remainders into M-stages below)
**Mockup:** `docs/mockups/mission-inbox-mockup.html`

---

## 1. The Idea (one paragraph)

Every AI coding vendor converged on the same loop in 2026: queue a task → agent works in a
sandbox → a PR/diff comes back for review (Cursor background agents, OpenAI Codex, Devin,
Claude Code). But each vendor traps that review inside its own tool, and enterprise "mission
control" products (Salesforce Agentforce Observability, ServiceNow AI Control Tower, Cisco
Cloud Control, Mission Control AI "Swarm") are top-down IT governance consoles — not the
screen a developer keeps open all day. **The missing category is the neutral, local-first
INBOX where ALL agent work arrives for human decision.** Like email: many senders, one
inbox. MissionAlpha becomes that inbox. An agent finishes work → a **Delivery** lands in
the Inbox → a human reviews the diff → Approve ships it (branch/PR) / Reject sends feedback
back to the agent → everything audited. When every piece of AI work in a company must pass
through this screen, the app is as mandatory as Outlook.

**Tagline:** *Every company is hiring AI workers. MissionAlpha is where humans manage them.*

## 2. Why this wins (research-grounded)

| Fact (verified 2026-07) | Consequence for us |
|---|---|
| Cursor/Codex/Devin all end their loop at "a PR to review"; review UX is scattered per vendor | One neutral inbox that ingests ALL of them = the layer nobody owns |
| HITL research: approval fatigue is the #1 failure; fixes = risk-based triggers, reviewer routing, SLA timeouts | Risk-routed Inbox (M4) is a *researched* feature, not a guess |
| Gartner: 40% of enterprise apps embed task agents by end-2026; >40% of agentic projects at risk of cancellation by 2027 without governance | The approval+audit gap is the exact cancellation-risk gap |
| Enterprise mission controls are SaaS, top-down, vendor-locked | Local-first + dev-first + vendor-neutral is open ground |

## 3. The core object: `Delivery`

Everything in the product hangs off one new typed object.

```ts
type Delivery = {
  id: string;                 // ulid
  agentId: string;            // who did the work
  taskId: string | null;      // queue linkage (M2)
  title: string;              // "Add login page validation"
  summary: string;            // agent-written, caveman-scrubbed
  source: "swarm" | "claude-code" | "github-pr" | "external";   // M5 widens this
  kind: "code" | "doc" | "post" | "command";
  diffstat: { files: number; additions: number; deletions: number };
  changes: ChangeEntry[];     // path + patch (reuses F2b /changes shape)
  risk: { score: number; band: "low" | "medium" | "high"; reasons: string[] };  // M4
  status: "pending" | "approved" | "rejected" | "changes_requested" | "expired" | "auto_approved";
  slaDeadline: string | null; // ISO; SLA timer (M4)
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;   // "BOSS" (M7: real users)
  feedback: string | null;    // rejection / change-request text, fed back to agent
  auditRef: string;           // AUDIT.log linkage
};
```

**Flow:** agent run completes → runtime mints Delivery (instead of today's silent sandbox
diff) → Inbox badge +1 → human opens card → full diff → decision →
- **Approve** → existing F2b `/apply` broker (M1) → git branch + PR (M3) → agent `reportBack` DONE
- **Request changes** → feedback string becomes the agent's next `/run` task (loop closes)
- **Reject** → sandbox discarded, audited

## 4. End-to-end build order

Rules: each M-stage independently shippable, exits only on green gates
(tsc 0 · unit+e2e green · security review on any broker/exec change · SESSION_MEMORY updated).
Reuse over rebuild — every stage lists what it reuses.

---

### M0 — Debt burn-down (the README list + hygiene)  — effort S
The 7 open BOSS asks, plus repo hygiene. All are trust-builders for daily use.
1. **STOP button** — `POST /runtime/:id/stop`: kill tracked `claude -p` child (SIGTERM→SIGKILL),
   mark thread interrupted, surface stop control on agent cards + board. Reuses inflight tracking.
2. **Send loading indicator** — pending state in ChatPane between POST and first SSE token.
3. **Skills catalog 1800+** — finish `scripts/vendor-skills.mjs` pipeline; searchable, grouped,
   lazy-loaded catalog (virtualized list; 9 → full set).
4. **Delete agent from board** (all except `ceo`) — reuse factory delete, confirm-gated.
5. **"Add agent" lives in Agent Factory beside CREATE.**
6. **CEO assembles team** — "Describe the job" → CEO proposes agent set → BOSS confirms (reuse
   dispatch-block parser pattern).
7. Fix `lint` script reality (eslint not installed — install or drop from package.json).
**Exit:** all 7 verified in browser; tsc 0.

### M1 — THE INBOX (the product's soul)  — effort M
- Runtime: Delivery store (`agent-runtime/deliveries/` ndjson or per-file JSON, 0600,
  gitignored), minted on run-completion from existing `/changes` machinery.
- Endpoints: `GET /inbox` · `GET /inbox/:id` · `POST /inbox/:id/approve` ·
  `POST /inbox/:id/reject` · `POST /inbox/:id/request-changes {feedback}` — all behind the
  existing host/origin/token gates.
- UI: **Inbox = first item in left rail, with unread badge.** Center = delivery cards
  (agent avatar, title, diffstat, age, risk chip placeholder). Right = review pane: full
  scrollable diff (raise today's 4KB truncation), Approve / Request changes / Reject.
- Notifications: Electron native notification + dock badge on new Delivery (web: title badge).
- Approve wires to existing F2b `/apply`; request-changes wires feedback → `/run`.
**Exit:** dispatch task → agent works → Delivery lands with notification → approve from
Inbox → file in repo → agent DONE in feed. Full loop **without opening a drawer**.

### M2 — Never lose work (queue · retry · auto-chain)  — effort M
(= old roadmap S1, now in service of the Inbox)
- Task queue with backlog (`ADR-027`): tasks survive restart; per-agent serial, cross-agent parallel.
- Retry/self-heal (`ADR-028`): failed run → classified error → one auto-retry → then a
  **failure Delivery** in the Inbox ("agent stuck — needs you").
- Auto-chain (`ADR-024`): approve → next queued task dispatches automatically.
- Parallel dispatch cap via existing MAX_INFLIGHT.
**Exit:** queue 5 tasks across 3 agents → close laptop → return → 5 Deliveries waiting;
kill runtime mid-run → restart → work resumes.

### M3 — Any repo, real branches, real PRs  — effort M
- **Repo picker:** point MissionAlpha at ANY local git repo (persisted per-workspace;
  removes hardwired Waahyu paths). Onboarding: "Open a repo" as first-run step.
- **Git worktree isolation** (`ADR-026`) replaces file-copy sandbox: each task = branch
  `ma/<agent>/<task>` in a worktree. CONFIG_GUARD + path validation carry over.
- **Approve ⇒ commit on branch ⇒ PR** via `gh` when remote exists (else local branch merge).
  Delivery links the PR URL.
**Exit:** clone any public repo → 5-min setup → task → Delivery → approve → real PR on GitHub.

### M4 — Risk router (anti-approval-fatigue)  — effort S–M
(research: precise triggers + routing + SLA timeouts prevent rubber-stamping)
- Rule-based risk engine (no LLM): path patterns (auth/payments/infra/.env = high;
  tests/docs = low), diff size, new-dependency detection, command kind. Score → band → reasons.
- Policy file `factory/policy.json` (BOSS-editable in Settings): per-band behavior —
  `low: auto_approve | notify`, `medium: human`, `high: human + typed-confirm phrase`.
- SLA deadline per band; expiring Deliveries escalate visually (and re-notify once).
- Auto-approved Deliveries still land in Inbox (collapsed "auto" section) + full audit.
**Exit:** docs-only change auto-applies under policy; auth-file change demands typed confirm;
all decisions audited with risk reasons.

### M5 — Universal ingestion (THE moat)  — effort M–L
One inbox for EVERY vendor's agents.
- **GitHub adapter:** poll/webhook PRs authored by bot accounts (Cursor agents, Codex,
  Devin all deliver as PRs) → each becomes a Delivery (diff fetched via `gh`); approve =
  PR approve/merge; request-changes = PR review comment. One integration covers every
  major vendor because they all converged on PRs.
- **Claude Code sessions adapter:** watch `~/.claude/projects/*` transcripts → local
  sessions surface as read-only Deliveries (visibility first, control later).
- Source chip on cards; filter by source.
**Exit:** a Cursor-created PR and a swarm task sit in the SAME inbox, both approvable.

### M6 — Usage meter + audit export  — effort S
- Tokens + context% per thread/agent/tier (parse `claude -p` stream JSON usage fields;
  else chars/4 estimate, labeled). Roadmap gap #8; UsageMeter component exists — wire it.
- Audit export: date-range → single JSON/CSV bundle (deliveries + decisions + audit lines).
**Exit:** per-agent usage visible; one-click export opens in spreadsheet.

### M7 — Second seat  — effort M
- Local accounts (name + role: `approver` | `viewer`), session cookie, decidedBy recorded.
- Assignment: route a Delivery to a person; simple @mention in feedback.
- (Full SSO/RBAC stays deferred — this is the minimum to make approving not-only-Rohit.)
**Exit:** two browsers, two users; a Delivery assigned to user B is decided by B; audit shows who.

### M8 — Dogfood scoreboard + polish  — effort S–M
- **Dogfood mode:** MissionAlpha's own repo as the workspace; weekly scorecard widget:
  "N Deliveries shipped by agents this week, M human-minutes spent approving."
- Design pass: hallmark → impeccable audit/polish → emil motion review; a11y AA;
  empty/loading/error states for Inbox; 375px mobile inbox (approve from phone-size window).
- Full-program e2e + adversarial sweep (regression suite accumulated since M0).
**Exit:** one week of MissionAlpha shipping MissionAlpha through its own Inbox, recorded.

---

## 5. What stays true (invariants)

- **Human decision gates every write to a real repo / every external post.** Auto-approve
  exists ONLY under explicit BOSS-set policy, always audited.
- Claude subscription CLI backend for personal use; API/other-vendor backends only via
  adapters (M5 ingests their *output*, never resells their runtime).
- Bash for agents stays OFF until a dedicated approval-UX stage (old S3.5) — not in M0–M8.
- Local-first: no cloud dependency for the core loop.
- All existing security gates (token, host/origin, scrub, CONFIG_GUARD, symlink guards)
  carry forward unchanged; any broker/exec change re-triggers security review.

## 6. Success metric (the only one that matters pre-launch)

> **Weekly Deliveries approved ÷ human-minutes spent.**
> Target after M8: ≥ 20 Deliveries/week shipped to MissionAlpha itself with < 60 human-minutes.

When that number is real and recorded, the app has proven the category on itself — the
demo every company understands in 10 seconds.

## 7. Known gaps & risks (disclosed)

- M5 GitHub adapter assumes bot-authored PRs are identifiable (usually true; edge cases
  need mapping config).
- Risk engine is heuristic; a wrong "low" band could auto-apply something sensitive —
  mitigations: conservative defaults (auto-approve OFF by default), path-deny always-human list.
- Electron notification behavior differs macOS/Windows; M1 verifies macOS only.
- No TAM/pricing work here by BOSS instruction (product first, business later).
- `master-roadmap.md` S3 diff-review depth and S2.5 MCP-connector manager are folded into
  M1 (diff pane) and deferred (MCP mgmt) respectively — MCP management is NOT in M0–M8.
