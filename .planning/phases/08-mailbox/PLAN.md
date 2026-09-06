---
phase: 8
name: Mailbox
requirements: [M2-MAIL, M2-MAILRULES, M2-THREAD]
depends_on: [7]
files_modified:
  - agent-runtime/mailbox.mjs (new; store + router + rules; bodies scrubbed + capped + fenced as DATA when injected into any prompt)
  - agent-runtime/mcp/mail-tools.mjs (new; mail_send / mail_read MCP server for seats)
  - agent-runtime/server.mjs (router on heartbeat; --mcp-config includes mail server; story_log rows)
  - src/lib/storyThread.ts (render mail rows) · src/components/bos/StoryThread.tsx
  - agent-runtime/test/mailbox*.test.mjs
autonomous: true
checkpoints: []
commit_policy: NO COMMITS until BOSS says
---

<objective>
Workers talk to each other and to the Manager without the human in the loop. File-based,
single-writer, routed by the runtime, visible in the thread. Rules: worker ↔ worker, worker
→ Manager, Manager ↔ HR only. Nobody writes to BOSS except the Manager through Job state.
</objective>

<skills mandatory="true">
- security-review — mail bodies are agent-authored (untrusted) and are fed into other agents' prompts: scrub, cap, fence
- sp-test-driven-development · sp-verification-before-completion · code-reviewer · build-mcp-server (for 8.2)
</skills>

<tasks>

<task id="8.1" name="mailbox.mjs — store, router, rules" tdd="true">
Files: agent-runtime/mailbox.mjs, agent-runtime/test/mailbox.test.mjs.
Action: dirs `engine-store/mail/<agentId>/{inbox,outbox}`; message `{id(ulid), from, to, jobId, taskId?, kind, body(≤4 KB scrubbed), at}`; `send()` writes to sender's outbox only; `route()` (called each heartbeat) moves outbox → recipient inbox, appends a `story_log` row `{event:"mail", byAgent:from, toAgent:to, ref:kind}` and emits SSE `mail` (declared in 7.0b), copies `status|blocked|done` to the Manager's inbox. `RULES`: allowed pairs by role; a disallowed pair is dropped with a `mail-refused` log row. `read(agentId)` returns and archives.
Verify: routing table test (allowed/refused pairs), scrub applied, single-writer (two senders never touch one file), idempotent route.
Done when: unit green; a manual send via API appears in the other agent's inbox and in the thread.
</task>

<task id="8.2" name="mail_send / mail_read as MCP tools for seats">
Files: agent-runtime/mcp/mail-tools.mjs, agent-runtime/server.mjs (mcp-config per spawn with `{agentId, jobId, taskId}` bound).
Action: tiny stdio MCP server exposing `mail_send({to, kind, body})` and `mail_read()`; identity bound server-side from spawn env, never from the model's argument. 8.2 ADDS `--mcp-config <per-spawn file>` + `--strict-mcp-config` to the ENGINE spawn (today only the chat path `cliReply` ~server.mjs:996 composes one; `engineDispatch` ~1770–1890 has none) and adds `mcp__mail__mail_send`,`mcp__mail__mail_read` to `--allowed-tools`.
Verify: spawn a seat with a brief "ask Charizard for the endpoint name" → outbox has one `question` to charizard; forged `from` is ignored.
Done when: live: two seats exchange one handoff on a two-task goal and both messages render in the thread.
</task>

<task id="8.3" name="Thread rendering">
Files: src/lib/storyThread.ts, src/components/bos/StoryThread.tsx, src/lib/__tests__/storyThread.test.ts.
Action: `mail` rows render as "Pikachu → Charizard · handoff · <body>"; refused rows render muted.
Verify: unit; visual snapshot.
Done when: the live exchange from 8.2 is visible on the story page.
</task>

<task id="8.4" name="Phase gate">
Action: contract BEFORE and AFTER (dev servers stopped); live proofs 8.2/8.3 in STATE.md; PES report with Known Gaps & Risks.
Done when: numbers in STATE.md.
</task>

</tasks>

<must_haves>
- Two workers complete a handoff without the human
- Every message is in story_log and on screen
- A disallowed pair is dropped and logged, never delivered
</must_haves>

<threat_model>
- Prompt injection via mail body → scrubbed, capped, fenced as DATA when injected into a prompt (same fence as pipeline artifacts).
- Identity spoofing → `from` bound from spawn env, model argument ignored.
- Mail flood → per-agent cap 50 pending; overflow logged.
</threat_model>

<exit_gate>
Contract green before/after · two seats exchange a handoff live · every message in story_log and on screen · a disallowed pair dropped and logged.
</exit_gate>
