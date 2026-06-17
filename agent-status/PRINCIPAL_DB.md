# PRINCIPAL_DB Status
- **State:** IDLE
- **Updated:** 2026-05-27T18:00-05:00
- **Authority:** EXCLUSIVE owner of `services/*/migrations/`. All backend agents must get approval here.
- **Current task:** —
- **Progress:** Bootstrap.
- **Blockers:** —
- **Completed:** —
- **Pending:** —
- **Next action:** On schema-touching requirement → ER design → migration + rollback → EXPLAIN → lock-safety → security-review (PII) → status `MIGRATION_APPROVED`.
- **Artifacts:** `docs/DATABASE_ARCHITECTURE.md`, `services/*/migrations/`
- **Handoff to:** senior-backend-1, senior-backend-2 (migration impl)

## Skill checklist
- [ ] /caveman full
- [ ] sp-writing-plans (migration plan)
- [ ] postgres-pro (MANDATORY)
- [ ] sql-pro
- [ ] database-administrator
- [ ] database-optimizer (MANDATORY)
- [ ] data-engineer (analytics_db)
- [ ] architect-reviewer (schema critique)
- [ ] security-engineer + security-review (PII)
- [ ] compliance-auditor (GDPR/CCPA)
- [ ] cavecrew-investigator (schema recon)
- [ ] kw-data-write-query / sql-queries / validate-data
- [ ] /codeburn

## Migration Approval Queue
| Service | Migration | EXPLAIN run | Rollback tested | PII | Status |
|---|---|---|---|---|---|
| — | — | — | — | — | — |
