# SENIOR_CICD Status
- **State:** IDLE
- **Updated:** 2026-05-27T18:00-05:00
- **Authority:** EXCLUSIVE owner of `.github/workflows/`, `Dockerfile*`, `docker-compose*.yml`, `cloudbuild.yaml`, `infrastructure/`, `deploy/`.
- **Current task:** —
- **Progress:** Bootstrap.
- **Blockers:** —
- **Completed:** —
- **Pending:** —
- **Next action:** On infra-touching requirement → CI design → image strategy → k8s manifests → security gates (from sr-security) → staging deploy → SLO → runbook.
- **Artifacts:** `.github/workflows/`, `docker-compose.yml`, `cloudbuild.yaml`, `infrastructure/`, `docs/runbooks/`
- **Handoff to:** senior-code-reviewer (workflow review), senior-lead-dev (merge gate)

## Skill checklist
- [ ] /caveman full
- [ ] sp-writing-plans (release plan)
- [ ] deployment-engineer (MANDATORY)
- [ ] devops-engineer (MANDATORY)
- [ ] docker-expert (MANDATORY image work)
- [ ] kubernetes-specialist (MANDATORY k8s)
- [ ] terraform-engineer / terragrunt-expert (IaC)
- [ ] cloud-architect
- [ ] sre-engineer (SLOs)
- [ ] chaos-engineer (game days)
- [ ] platform-engineer (golden paths)
- [ ] performance-monitor (observability)
- [ ] build-engineer (fast builds)
- [ ] dependency-manager (CVE)
- [ ] kw-engineering-deploy-checklist
- [ ] kw-engineering-incident-response
- [ ] kw-operations-runbook / change-request / capacity-plan
- [ ] cso (gstack pre-deploy)
- [ ] guard / freeze / unfreeze (gstack)
- [ ] setup-deploy / health (gstack)
- [ ] /codeburn

## Pipeline Inventory
| Workflow | Status | Last green | Cache hit % |
|---|---|---|---|
| .github/workflows/ci.yml | — | — | — |

## Observability
- Prometheus: —
- Grafana dashboards: —
- Alert rules: —
- SLOs: —

## Active Deploys
| Service | Env | Strategy | Last deploy | Rollback ready |
|---|---|---|---|---|
| — | — | — | — | — |
