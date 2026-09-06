# Adoption Map — 15-pin acceptance snapshot

Committed snapshot of the adoption-map HTML artifact (claude.ai/code/artifact/7b7c34e0-94d6-439a-8f34-0e6cfed68512, 2026-08-18). Program close (Task 4.5) walks this table pin by pin. "Verified as per HTML" = every row has observed evidence or an explicit DISCLOSED-BLOCKED note.

| Pin | Req | Item | Lands in | Phase | Acceptance (observable) |
|-----|-----|------|----------|-------|-------------------------|
| 1 | R1 | Hook lifecycle | engine-spawner.mjs + hooks.mjs | 1 | mid-run quality failure kills run before Delivery mint; run.killed frame rendered |
| 2 | R2 | Cadence workers | cadence.mjs · scheduler.mjs · resource-guard.mjs | 1 | capped low-band worker Deliveries appear in Inbox with zero human action |
| 3 | R3 | Tier-0/1 routing | engine.mjs · codemod.mjs · router-tier.mjs | 1 | mechanical task ships as $0 codemod diff through normal Inbox→broker path; tier telemetry on usage feed |
| E5 | R4 | doctor | engine-readiness.mjs · doctor.mjs · banner | 1 | `npm run doctor` + cockpit banner flag no-active-account with fix text |
| 4 | R5 | Learning loop | success-signature.mjs · vault | 2 | approval mints/updates exactly one pattern record; retry-rate metric recorded |
| 5 | R6 | Vault retrieval | vault-embed.mjs · system-prompt.mjs | 2 | repeat-topic prompt carries fenced top-k prior art; <100ms @1k |
| 6 | R7 | Cross-model review | story-reviewqa.mjs · providers/ | 2 | review artifact names provider ≠ builder (or crossModel:false disclosed) |
| E6 | R8 | Skill budget | station-skills.mjs · skills-curated/ | 2 | every station prompt ≤ budget; size drop measured |
| 7 | R9 | MetaHarness self-grade | metaharness.mjs · factory/* | 3 | weakening station-perms drops live score + mints finding; cockpit tile |
| E1 | R10 | Adapter trust | adapters/trust.mjs | 3 | different-history adapters show different scores; friction-only pinned by test |
| E2 | R11 | PII detection | pii-detect.mjs in scrub chain | 3 | audit export redacts typed PII; count rendered; FP within budget on corpus |
| E4 | R12 | Injection heuristics | inject-detect.mjs · adapters | 3 | crafted PR body arrives flagged + band-bumped, content intact |
| E3 | R13 | Encryption at rest | crypto-at-rest.mjs · db/vault | 4 | boots encrypted; recovery drill passes; fail-closed on missing key; BOSS-approved design |
| E8 | R14 | Anti-drift policy | anti-drift.mjs · queue.mjs | 4 | hung mock task surfaces as diff-less escalation Delivery within window |
| E7 | R15 | Graph ranking | vault-graph.mjs | 4 | hub record outranks orphan at equal cosine; caps pinned |

Rejected (never adopt): ruflo install · npx:* perms · neural stack · federation · consensus.
Security laws 1–5: see CONTEXT.md — every pin's evidence must show its laws held.
