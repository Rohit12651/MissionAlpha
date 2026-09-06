---
phase: 4
name: Heavy Tail
requirements: [R13, R14, R15]
depends_on: [2, 3]
files_modified:
  - agent-runtime/db.mjs
  - agent-runtime/vault.mjs
  - agent-runtime/crypto-at-rest.mjs (new)
  - agent-runtime/factory.mjs (AES broker keyholder)
  - agent-runtime/queue.mjs
  - agent-runtime/anti-drift.mjs (new)
  - agent-runtime/vault-graph.mjs (new)
  - scripts/migrate-encrypt.mjs (new)
  - src/components/bos/ (stall indicator)
autonomous: true
checkpoints: [4.0]  # hard BOSS gate — key-recovery approval blocks R13; autonomy pauses there by design
commit_policy: NO COMMITS until BOSS says
---

<objective>
The heavy tail: data encrypted at rest with a tested key-recovery story, stall detection that makes silent 3-day wedges impossible, and PageRank ranking over the vault graph to sharpen retrieval. Entry gate: key-recovery design approved by BOSS BEFORE R13 implementation starts.
</objective>

<skills mandatory="true">
- security-review — R13 is crypto + migration; block on CRITICAL; design doc reviewed BEFORE code
- sp-test-driven-development · sp-verification-before-completion — every task
- sp-systematic-debugging — any migration anomaly
- code-reviewer agent — per task
- gstack `/careful` (R13 migration is the one task warranting conservative execution) + `/qa` + `/review`
- context7 — better-sqlite3/SQLCipher API verification before R13 code
- mem-search — vault/db invariants (file-is-record law) before touching either
- caveman + headroom + codeburn — session ops
- Fable 5 — independent phase verification (Task 4.5)
</skills>

<tasks>

<task id="4.0" name="R13 entry gate — key-recovery design (BLOCKING)">
Files: .planning/phases/04-heavy-tail/KEY-RECOVERY.md (new).
Action: Design doc BEFORE any crypto code: key hierarchy (master in factory AES broker; per-store derived keys), recovery paths (BOSS-held recovery phrase → master re-derive; explicit documented data-loss boundary if both lost), rotation procedure, migration rollback (encrypted copy alongside original until verified — original deleted only on BOSS confirmation), threat model (laptop theft = covered; live-process compromise = explicitly NOT covered, documented). security-review on the doc. **STOP: present to BOSS via AskUserQuestion — R13 implementation does not start until approved.** (Autonomy exception — key-loss = data-loss is a one-way door; BOSS mandate "in charge while I sleep" does not extend to one-way doors.)
Verify: doc exists, security-reviewed, BOSS-approved.
Done when: approval recorded in the doc header.
</task>

<task id="4.1" name="R13 — encryption at rest" tdd="true">
Files: agent-runtime/crypto-at-rest.mjs (new), db.mjs, vault.mjs, scripts/migrate-encrypt.mjs, factory.mjs.
Action: Per approved design. SQLite: SQLCipher via better-sqlite3 build if clean, else page-level AES-GCM wrapper — context7 verify current API first; decision documented. Vault files: AES-GCM per file, key from broker, filename+structure unchanged (file-is-record law holds — `cat` shows ciphertext, `vault export <id>` decrypts for the human). Migration script: copy→encrypt→verify-read-all→swap, original retained as .pre-encrypt until BOSS confirms; idempotent re-run; interrupted-migration recovery test. Startup: missing key = fail-closed with doctor finding (never silent plaintext fallback).
Verify: `crypto-at-rest.test.mjs` — roundtrip, wrong-key fails clean, interrupted migration recovers, recovery-phrase path restores access on fixture store; doctor gains encrypted-at-rest check; full regression green against encrypted stores.
Done when: fresh runtime boots encrypted end-to-end; recovery drill passes on fixtures; rollback path intact.
</task>

<task id="4.2" name="R14 — anti-drift dispatch policy" tdd="true">
Files: agent-runtime/anti-drift.mjs (new), queue.mjs, engine.mjs, cadence integration.
Action: First AUDIT existing queue serialization (per-agent serial, MAX_INFLIGHT) — document overlap, build only the delta: (a) per-story concurrency cap (default 2) atop per-agent rules; (b) stall detector — task in non-terminal state past `RUNTIME_STALL_MS` (default 30min) with no heartbeat → mint escalation Delivery (failure-signature clusterable shape "<agent> is stuck — stalled") + `agent.state` SSE frame; (c) checkpoint requirement: engine stages emit progress marks, detector uses them. Escalation-Delivery Law-3 semantics pinned: kind `failure`, DIFF-LESS (auto-apply structurally impossible), max ONE per stall episode (idempotent), episode counter capped per day per agent (reuses worker-cap machinery) — an autonomously-minted delivery never gets write power. The 3-day silent wedge becomes structurally impossible: blocked ≠ silent.
Verify: `anti-drift.test.mjs` — injected-clock stall mints exactly one escalation (idempotent per stall episode), escalation is diff-less failure-kind with auto-apply impossible (band/kind assertions), daily episode cap enforced, recovery clears state, per-story cap queues not drops, existing queue tests untouched-green.
Done when: a deliberately-hung mock task surfaces in Inbox within the window, zero human polling.
</task>

<task id="4.3" name="R15 — PageRank vault graph ranking" tdd="true">
Files: agent-runtime/vault-graph.mjs (new), vault-embed.mjs (rank fusion).
Action: Edges from existing record metadata: same-story, same-agent, temporal-adjacency, explicit refs. PageRank with the honesty guards ruflo's intelligence.cjs got right: node cap (5k), iteration cap, O(n²) guard on edge building. Rank fusion: `final = 0.7·cosine + 0.3·normalizedPageRank` (weights env-tunable, defaults documented). Graph rebuilt incrementally on vault write, full rebuild on demand. Pure module + persisted graph state (0600).
Verify: `vault-graph.test.mjs` — hub record outranks orphan at equal cosine on fixtures; caps enforced; A/B fixture: fusion reorders vs cosine-only in the expected direction; retrieval latency still <100ms at 1k.
Done when: retrieval measurably prefers well-connected prior art; guards pinned.
</task>

<task id="4.4" name="Wire UI — stall + encryption status" ui="true">
Files: src/components/bos/ (stall indicator on station cards), EngineReadinessBanner (encryption check surfaces via doctor frames — no new plumbing).
Action: hallmark → impeccable → taste-skill. Station card: stalled state visual (existing state system — amber pulse, "stalled 32m" label). Doctor banner already renders new encrypted-at-rest check via Phase 1 wiring — verify only.
Verify: render tests; visual 1280/390; dark+light.
Done when: stalled station visually distinct; encryption status visible through existing banner.
</task>

<task id="4.5" name="Phase gate + program close — Fable 5 full-map verification">
Files: .planning/phases/04-heavy-tail/VERIFICATION.md, .planning/PROGRAM-CLOSE.md (new).
Action: Full regression + all phase suites. gstack `/qa` + `/review` + `/cso`. code-reviewer + security-review on diff. Fable 5 independent pass for R13–R15, THEN full-program audit: walk `.planning/ADOPTION-MAP.md` pin by pin — the committed 15-pin snapshot of the adoption-map HTML artifact — each item demonstrated with evidence (the BOSS's acceptance criterion: "verified as per html"; live where accounts allow, DISCLOSED-BLOCKED otherwise). PROGRAM-CLOSE.md: per-pin evidence table, measured metrics (token delta, retry rate, prompt sizes, retrieval latency), disclosed gaps, codeburn session cost summary. NO COMMIT — final report ends with the exact commit-ready state description for BOSS sign-off.
Verify: 15/15 pins evidenced or explicitly disclosed-blocked (e.g., live-account items if still no active account).
Done when: PROGRAM-CLOSE.md complete; BOSS has a single document to approve commits from.
</task>

</tasks>

<success_criteria>
- Encrypted at rest with drilled recovery + intact rollback; fail-closed on missing key.
- Stalls surface as Deliveries within the window — silent wedge class dead.
- Graph-fused retrieval measurably better-ordered; all guards pinned.
- Program: 15/15 ADOPTION-MAP.md pins evidenced end-to-end or explicitly DISCLOSED-BLOCKED; every mandate from BOSS instructions addressed in PROGRAM-CLOSE.md; zero commits made throughout.
</success_criteria>
