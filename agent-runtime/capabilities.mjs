// ADR-050 A1 — Static capability index for the 16 builtin agents + spec-to-stack helper.
//
// Pure module — no I/O, no imports from factory/registry. The index is derived
// from the ORCHESTRATION.md roster and the backend/frontend routing matrices.
// `capsForSpec` derives the lang/framework/db set from a minted agent's dev skill stack.

import { SKILL_CATALOG } from "./factory.mjs";

/**
 * Returns the static capability index for the 16 builtin agents.
 * Shape: Map<agentId, {langs:string[], frameworks:string[], dbs:string[]}>
 *
 * Source of truth: .claude/agents/ORCHESTRATION.md agents table + routing matrices.
 * Each entry reflects what the agent actually knows (for gap-detection purposes).
 */
export function capabilityIndex() {
  return new Map([
    // 0. CEO — strategic; no code stack
    ["ceo", { langs: [], frameworks: [], dbs: [] }],

    // 1. Architect — design only; reads all stacks
    ["architect", { langs: ["python", "typescript"], frameworks: ["fastapi", "react", "expo"], dbs: ["mongodb", "redis"] }],

    // 2. principal-ux-design — React/Tailwind/Radix/RN tokens
    ["principal-ux-design", { langs: ["typescript"], frameworks: ["react", "react-native", "tailwind", "radix"], dbs: [] }],

    // 3. principal-db-engineer — MongoDB exclusively (no SQL)
    ["principal-db-engineer", { langs: ["python"], frameworks: ["motor", "pymongo"], dbs: ["mongodb", "redis"] }],

    // 4. senior-security-engineer
    ["senior-security-engineer", { langs: ["python", "typescript"], frameworks: [], dbs: ["mongodb", "redis"] }],

    // 5. senior-cicd-engineer — GCP Cloud Run, Docker, k8s, Terraform
    ["senior-cicd-engineer", { langs: ["bash", "yaml"], frameworks: ["docker", "kubernetes", "terraform", "gcp"], dbs: [] }],

    // 6. senior-lead-dev — orchestrator; broad
    ["senior-lead-dev", { langs: ["python", "typescript"], frameworks: ["fastapi", "react"], dbs: ["mongodb"] }],

    // 7. senior-web-1 — customer-web + admin-dashboard (React+Vite)
    ["senior-web-1", { langs: ["typescript"], frameworks: ["react", "vite", "radix", "tanstack-query"], dbs: [] }],

    // 8. senior-web-2 — vendor-dashboard + driver-web (React+Vite + WebSocket)
    ["senior-web-2", { langs: ["typescript"], frameworks: ["react", "vite", "radix", "websocket"], dbs: [] }],

    // 9. principal-rn-mobile-1 — customer + admin mobile (Expo/RN)
    ["principal-rn-mobile-1", { langs: ["typescript"], frameworks: ["react-native", "expo", "reanimated"], dbs: [] }],

    // 10. principal-rn-mobile-2 — vendor + driver mobile (Expo/RN + location)
    ["principal-rn-mobile-2", { langs: ["typescript"], frameworks: ["react-native", "expo", "reanimated", "websocket"], dbs: [] }],

    // 11. senior-backend-1 — auth/gateway/catalog/cart/order/payment/promotion (FastAPI/Python/Mongo)
    ["senior-backend-1", { langs: ["python"], frameworks: ["fastapi", "pydantic", "stripe", "twilio"], dbs: ["mongodb", "redis"] }],

    // 12. senior-backend-2 — admin/vendor/driver/notification/analytics/loyalty (FastAPI + WS)
    ["senior-backend-2", { langs: ["python"], frameworks: ["fastapi", "pydantic", "websocket", "twilio"], dbs: ["mongodb", "redis"] }],

    // 13. senior-qa — test tooling; broad coverage
    ["senior-qa", { langs: ["python", "typescript"], frameworks: ["pytest", "vitest", "playwright", "detox"], dbs: [] }],

    // 14. senior-code-reviewer — review; broad
    ["senior-code-reviewer", { langs: ["python", "typescript"], frameworks: ["fastapi", "react"], dbs: ["mongodb"] }],

    // 15. memory-updater — memory custodian; no code stack
    ["memory-updater", { langs: [], frameworks: [], dbs: [] }],
  ]);
}

/**
 * Derive the capability set ({langs, frameworks, dbs}) from a minted agent's spec.
 * Looks up each dev skill in SKILL_CATALOG and merges their `stack` fields.
 * Non-dev skills contribute nothing (no stack field).
 *
 * @param {object} spec - agent spec with a `skills` array
 * @returns {{langs:string[], frameworks:string[], dbs:string[]}}
 */
export function capsForSpec(spec) {
  const langs = new Set();
  const frameworks = new Set();
  const dbs = new Set();

  const skills = Array.isArray(spec?.skills) ? spec.skills : [];
  for (const skillId of skills) {
    const entry = SKILL_CATALOG.find((s) => s.id === skillId);
    if (!entry?.stack) continue;
    for (const l of entry.stack.langs ?? []) langs.add(l);
    for (const f of entry.stack.frameworks ?? []) frameworks.add(f);
    for (const d of entry.stack.dbs ?? []) dbs.add(d);
  }

  return { langs: [...langs], frameworks: [...frameworks], dbs: [...dbs] };
}
