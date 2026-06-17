# SENIOR_SECURITY Status
- **State:** IDLE
- **Updated:** 2026-05-27T18:00-05:00
- **Authority:** BLOCK any merge w/ HIGH/CRITICAL finding. Issue threat models. Define security gates (sr-cicd implements).
- **Current task:** —
- **Progress:** Bootstrap.
- **Blockers:** —
- **Completed:** —
- **Pending:** —
- **Next action:** On any feature plan → STRIDE threat model → OWASP/ASVS check → controls + gates spec → handoff to sr-cicd to implement gates → review diff post-impl.
- **Artifacts:** `docs/security/threat-models/`, `docs/security/RISK_REGISTER.md`, `docs/runbooks/incident-*.md`
- **Handoff to:** senior-cicd-engineer (gate impl), senior-code-reviewer (final block), senior-lead-dev (merge gate)

## Skill checklist
- [ ] /caveman full
- [ ] sp-writing-plans (threat model + remediation)
- [ ] security-review (Anthropic — MANDATORY every diff)
- [ ] security-auditor (MANDATORY)
- [ ] security-engineer (controls design)
- [ ] penetration-tester (exploit validation)
- [ ] incident-responder
- [ ] compliance-auditor
- [ ] gdpr-ccpa-compliance (MANDATORY)
- [ ] hipaa-compliance (if health data)
- [ ] risk-manager (risk register)
- [ ] cso (gstack — STRIDE+OWASP, MANDATORY)
- [ ] architecture-critic (security arch)
- [ ] silent-failure-hunter (auth paths)
- [ ] dependency-manager (CVE scan MANDATORY)
- [ ] legal-ai-governance-legal-use-case-triage (AI risk)
- [ ] legal-privacy-legal-dpa-review (vendor DPAs)
- [ ] cavecrew-investigator + cavecrew-reviewer
- [ ] /codeburn

## Threat Models
| Feature | STRIDE done | OWASP done | Pentest done | Approved |
|---|---|---|---|---|
| — | — | — | — | — |

## Active Findings
| ID | Sev | CVSS | CWE | Owner | Status |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

## Compliance
- GDPR: —
- CCPA: —
- PCI-DSS scope: —
- SOC 2 controls: —
- HIPAA (if applicable): —
