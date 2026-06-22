// Quota-guard status client. Read-only GET /runtime/quota (same-origin via vite,
// runtime token). The quota guard is a self-throttle + 429 backoff around every
// `claude` spawn; this surfaces its window count so the UI can show a brake chip.
import { runtimeToken } from "./runtimeToken";
import { runtimeUrl } from "./runtimeBase";

export interface QuotaStatus {
  count: number; // total calls across the swarm in the window (account-wide pressure)
  max: number; // self-imposed per-agent cap (operator-picked; NOT Anthropic's real cap)
  windowMs: number;
  paused: boolean; // any agent at/over its cap → brake engaged
}

export async function getQuota(): Promise<QuotaStatus | null> {
  try {
    const token = await runtimeToken();
    const r = await fetch(runtimeUrl("/runtime/quota"), {
      headers: { "x-runtime-token": token },
      cache: "no-store",
    });
    if (!r.ok) return null;
    return (await r.json()) as QuotaStatus;
  } catch {
    return null;
  }
}
