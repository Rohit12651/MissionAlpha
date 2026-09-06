---
phase: 13
name: Jira in/out
requirements: [M2-JIRA]
depends_on: [12]
files_modified:
  - agent-runtime/providers/registry.mjs (PROVIDER_TYPES += `{type:"jira", authMethods:["api_key"], needsBaseUrl:true, probeCapable:false}` — today the set is closed: claude/openai/minimax/zai/custom)
  - agent-runtime/adapters/jira.mjs (new; REST v3 client, host allow-list, token from credStore)
  - agent-runtime/server.mjs (GET /runtime/jira/tickets?jql=, POST /runtime/jobs/from-jira {key}, ship hook)
  - agent-runtime/server.mjs (jira-watch rides the existing heartbeat with its own interval `JIRA_WATCH_MS`, default 300000 — NOT a cadence worker: `CADENCE_EXPRS` is daily/weekly/2xdaily/ondemand and worker rows are daily-capped)
  - src/components/board/JiraPicker.tsx (new) · src/lib/jiraClient.ts (new)
  - agent-runtime/test/{jira-adapter,jira-http}.test.mjs (stubbed REST via injected fetch)
autonomous: true
waves: {1: [13.1], 2: [13.0], 3: [13.2, 13.3], 4: [13.4]}
checkpoints: [13.0]  # BOSS adds the Jira site + token in Accounts; the agent never sees the value
commit_policy: NO COMMITS until BOSS says
---

<objective>
Pick a Jira epic or story from a list (or let Mission watch a board); it becomes a Job with
the full ticket text and comments, fenced as untrusted data; on ship, the ticket gets a
comment with the PR link and moves to Done.
</objective>

<skills mandatory="true">
- security-review — external credential + outbound HTTP + inbound untrusted text
- context7 — Jira Cloud REST v3 (search, issue, comment, transitions) before code
- sp-test-driven-development · sp-verification-before-completion · code-reviewer
</skills>

<tasks>
<task id="13.0" name="BOSS gate — Jira account (BLOCKING) — DECLINED 2026-09-06">
**BOSS, 2026-09-06: SKIP JIRA.** No account was added, so no live proof exists for this phase.
13.1/13.2/13.3 are built and green against stubs and a local fake Jira; every "Done when: live"
clause in this phase is therefore UNMET and recorded as such in STATE.md. Nothing here has ever
spoken to a real Atlassian site. To finish it later: add the account on the Accounts page
(`https://<site>.atlassian.net`, secret `email:api_token`) and run 13.4's live proof.

Files: Accounts page (existing) → credStore entry `providerType:"jira"` with `baseUrl` + api token.
Action: BOSS adds it. Agent never types or reads the token value.
Verify: `GET /runtime/accounts` shows a jira account with `hasSecret:true`.
Done when: present.
</task>
<task id="13.1" name="jira.mjs" tdd="true">
Files: agent-runtime/providers/registry.mjs, agent-runtime/adapters/jira.mjs, agent-runtime/test/jira-adapter.test.mjs, agent-runtime/test/providers-credentials.test.mjs (existing — pins PROVIDER_TYPES; add the jira type).
Action: FIRST add the `jira` provider type so 13.0 can be done in Accounts at all (13.0 depends on this landing first — reorder waves: 13.1 wave 1, 13.0 wave 2). Then `createJira({fetch, credStore})`: `search(jql, {max:50})`, `issue(key)` → `{key, summary, description, comments[], acceptance}`, `comment(key, body)`, `transition(key, name)` (resolves the transition id by name). Host must equal the account's `baseUrl` origin; token only in the Authorization header; responses scrubbed; every text field capped and fenced as DATA before it can enter a prompt.
Verify: injected fetch fixtures for all four calls; wrong host → refused; a token string in a response body is scrubbed from logs.
Done when: green.
</task>
<task id="13.2" name="Picker + watch">
Files: JiraPicker.tsx, jiraClient.ts, server.mjs, test/jira-http.test.mjs. (jobs.source / jobs.externalKey exist since 9.1 — no migration here.)
Action: `GET /runtime/jira/tickets?jql=` lists; `POST /runtime/jobs/from-jira {key}` builds the brief (summary + description + acceptance + comments, fenced) and creates the Job with `source:"jira", externalKey`. Heartbeat-driven `jira-watch` (interval `JIRA_WATCH_MS`) polls the configured JQL and creates Jobs for new keys with label `mission`, idempotent on the UNIQUE `jobs.externalKey`, max 10 per tick.
Verify: HTTP with stubbed fetch: list, create-from-key, duplicate key → same job; watch tick creates one job per new key.
Done when: live: one real ticket becomes a Job on the board.
</task>
<task id="13.3" name="Ship hook" tdd="true">
Files: manager.mjs (onShipped), jira.mjs, test/jira-http.test.mjs.
Action: on Job `shipped` with `externalKey`: `comment("PR: <url>" or "Branch: <name>")` then `transition("Done")`; failures logged as a job event, never block the Job.
Verify: stubbed: shipped → one comment + one transition call; transition failure → job still shipped + event row.
Done when: live: BOSS's ticket shows the comment and Done.
</task>
<task id="13.4" name="Phase gate">
Action: contract BEFORE and AFTER; live proof on one real ticket; PES report.
Done when: numbers in STATE.md.
</task>
</tasks>

<must_haves>
- One real Jira ticket → Job → shipped → ticket commented and moved
- Ticket text never enters a prompt unfenced
</must_haves>

<threat_model>
- Outbound only to the configured Jira origin; token never logged; responses scrubbed.
- Inbound ticket/comment text is agent-external untrusted data → fenced with the pipeline's DATA fence before Manager intake; caps enforced.
- Watch worker cannot create more than 10 jobs per tick.
</threat_model>
