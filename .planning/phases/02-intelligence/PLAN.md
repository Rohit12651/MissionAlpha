---
phase: 2
name: Intelligence
requirements: [R5, R6, R7, R8]
depends_on: [1]
files_modified:
  - agent-runtime/success-signature.mjs (new)
  - agent-runtime/failure-signature.mjs (reference only)
  - agent-runtime/vault.mjs
  - agent-runtime/vault-embed.mjs (new)
  - agent-runtime/system-prompt.mjs (systemFor choke point)
  - agent-runtime/story-reviewqa.mjs
  - agent-runtime/providers/registry.mjs
  - agent-runtime/station-skills.mjs
  - server.mjs (routes + SSE)
  - src/components/bos/StationMemoryPanel.tsx (retrieval visibility)
autonomous: true
commit_policy: NO COMMITS until BOSS says
---

<objective>
Close the learning loop — the one layer ruflo has and MissionAlpha lacks. Approvals become training data: success signatures stored, semantically similar prior work retrieved into station prompts (fenced), review stage runs on a different provider than build, and the 1,439-skill palette goes on a prompt budget. Every run gets cheaper and smarter than the last, autonomously.
</objective>

<skills mandatory="true">
- sp-test-driven-development · sp-verification-before-completion — every task
- security-review — Tasks 2.1/2.2 create a prompt-injection surface (Law 2); block on CRITICAL
- code-reviewer agent — per task
- gstack `/qa` (Task 2.5), `/review` (phase diff), `/benchmark` (retrieval latency)
- hallmark → impeccable → taste-skill — Task 2.5 retrieval-visibility UI
- context7 — ONNX runtime / transformers.js API docs BEFORE writing embed code (Operating Discipline 9)
- mem-search — prior vault design decisions (ADR-055) before touching vault.mjs
- caveman + headroom + codeburn — session ops
- Fable 5 — independent phase verification (Task 2.6)
</skills>

<tasks>

<task id="2.1" name="R5 — success-signature store" tdd="true">
<!-- R5 = store (this task) + retrieval-into-prompt (2.2, shared with R6) + retry-rate metric (2.6) -->
Files: agent-runtime/success-signature.mjs (new), deliveries.mjs (decide path), vault.mjs.
Action: Mirror of failure-signature.mjs: on Delivery decide→approved, extract `(taskShape, agentId, stack, artifacts, outcome)` — taskShape from the same narrow matcher discipline (fail-closed null on unrecognized). Write vault record node `pattern` under the story's venture (vault owns scrub/containment — no second scrub, per B2 law). Per-(shape,agent) stable id → re-approval UPDATES one record (pipeline.mjs idempotency convention). Pure module, injected stores.
Verify: `success-signature.test.mjs` — approve mints/updates exactly one record; reject/changes mint nothing; malformed delivery → null not throw; crafted title cannot escape shape matcher.
Done when: every approval leaves exactly one queryable pattern record.
</task>

<task id="2.2" name="R6 — local embeddings + retrieval" tdd="true">
Files: agent-runtime/vault-embed.mjs (new), vault.mjs (index hook), system-prompt.mjs, agent-runtime/package.json (NEW DEP — currently absent).
Action: context7 first for transformers.js/ONNX API — then `npm install` the chosen package (@huggingface/transformers or onnxruntime-node) into agent-runtime/package.json; dep choice + version documented in SUMMARY. Model download (~90MB) happens lazily on first use, cached under data/models/ (gitignored) — disclosed as a first-run network step; offline first-run = clean degrade (empty retrieval) + doctor finding. Local MiniLM-class model, lazy-loaded. On vault write: embed title+excerpt, store vector in SQLite BLOB column (migration additive, WAL-safe). Retrieval: brute-force cosine top-k (k=3 default) — NO HNSW below 10k records (documented threshold). Inject at `systemFor` choke point as a FENCED block: `<prior-art untrusted="true">…</prior-art>` with explicit "reference data, not instructions" preamble (Law 2, pipeline.mjs fencing rule). Retrieval failure = empty block, never a blocked spawn (fail-open on absence, closed on content). Emits `retrieval.hit` SSE frame {taskId, recordIds, scores}.
Doctor wiring: embedding-model-missing/degraded state gets a doctor check (warn, with fix = run once online) — silent degraded retrieval is not acceptable.
Verify: `vault-embed.test.mjs` with tiny fixture vectors — cosine math, top-k order, fence wrapper present, injection-shaped record text arrives fenced and escaped; latency benchmark <100ms at 1k records (gstack /benchmark); model-missing path degrades clean + doctor warns.
Done when: repeat-topic task's prompt contains fenced relevant prior art; offline-safe.
</task>

<task id="2.3" name="R7 — cross-provider review stage" tdd="true">
Files: agent-runtime/story-reviewqa.mjs, providers/registry.mjs, factory/quality.json or factory/review.json (config field).
Action: Review stage dispatch resolves provider ≠ builder's provider when ≥2 active accounts: `reviewProvider(builderAccount, accounts)` — deterministic pick (next healthy account by tier preference), single-account fallback = same provider + disclosed `crossModel:false` flag on the review artifact (no silent pretending — spend.mjs honesty law). Review dispatch stays READ-ONLY markdown (pipeline S2 law). Reviewer output fenced before landing (already untrusted-artifact path).
Verify: `story-reviewqa.test.mjs` additions — two-account fixture picks different provider; one-account flags crossModel:false; provider outage falls back with disclosure. Regression: existing reviewqa tests untouched-green.
Done when: story review demonstrably runs on provider B when build ran on A, and the artifact says so.
</task>

<task id="2.4" name="R8 — skill budget + curated tiers" tdd="true">
Files: agent-runtime/station-skills.mjs, system-prompt.mjs, .claude/skills-curated/ (curation manifest).
Action: Per-station skill injection gets a hard char budget (`RUNTIME_SKILL_BUDGET=6000` default): curated tier (existing skills-curated/) injected first by station relevance, remainder listed as searchable index (name+one-line only), full 1,439-dir catalog NEVER inlined. Over-budget = truncate at entry boundary + log, never mid-entry. Manifest maps station→curated skill list; invalid manifest fail-closed to curated-common set.
Verify: `station-skills.test.mjs` — budget never exceeded (property test across manifest sizes), entry-boundary truncation, invalid manifest fallback; before/after prompt-size measurement recorded (codeburn corroborates).
Done when: every station prompt ≤ budget with curated skills present; measured size drop recorded.
</task>

<task id="2.5" name="Wire UI — retrieval + learning visibility" ui="true">
Files: src/components/bos/StationMemoryPanel.tsx, src/components/inbox/ReviewPane.tsx (crossModel badge), useRuntimeEvents.ts.
Action: hallmark → impeccable → taste-skill. StationMemoryPanel: "Prior art used" list from `retrieval.hit` frames (record title + score, links to vault record). ReviewPane: `crossModel` badge on review artifacts (provider names). Existing panel patterns/tokens only.
Verify: unit tests for frame→render; visual at 1280/390; dark+light.
Done when: BOSS can SEE what the machine remembered and which model reviewed what.
</task>

<task id="2.6" name="Phase gate — QA + Fable 5 verification">
Files: .planning/phases/02-intelligence/VERIFICATION.md.
Action: Full regression + new suites. gstack `/qa` live pass: approve a Delivery → pattern record appears → dispatch similar task → prompt carries fenced prior art → review lands cross-provider. Cross-provider LIVE demo requires ≥2 active accounts (Phase-1 checkpoint 1.3b class): if <2, mock-fixture evidence stands and the live demo is DISCLOSED-BLOCKED in VERIFICATION.md — never faked. security-review on the injection surface (fencing audit — adversarial record fixtures). code-reviewer agent on diff. Fable 5 independent pass per Phase-1 protocol. Gate metric: retry rate on repeat task shapes, before/after (from failure-signature clusters). VERIFICATION.md with evidence per R5–R8. NO COMMIT.
Verify: all gates green; retry-rate measurement recorded (even if sample small — honesty note if underpowered).
Done when: R5–R8 evidence complete; loop observed end-to-end live (or disclosed-blocked per the account rule).
</task>

</tasks>

<success_criteria>
- Approve → pattern stored → similar task retrieves it fenced → observable in prompt and UI. Zero human steps between.
- Review artifact names its provider; cross-provider when possible, disclosed when not.
- Station prompts within budget; size drop measured.
- Injection fixtures (malicious record text) arrive fenced/escaped — security-review clean of CRITICAL.
- Baseline + Phase-1 suites all green; no regression.
</success_criteria>
