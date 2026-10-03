// the first-run rules (spec §5, ADR-LS2). Pure: no DOM, no network.
export const ONBOARDED_KEY = "ma.onboarded.v1"; // the old tour's key, kept so its users stay onboarded

interface AcctLike { id: string; providerType: string; authMethod: string }
interface AcctsLike { accounts: AcctLike[]; activeAccountId: string | null }
interface WsLike { configured: string | null; envPinned: boolean }

export function readFlag(): string | null { try { return localStorage.getItem(ONBOARDED_KEY); } catch { return "1"; /* storage blocked: never nag */ } }
export function writeFlag(): void { try { localStorage.setItem(ONBOARDED_KEY, "1"); } catch { /* storage blocked */ } }

/** Spec §5.1: flag → cockpit; else the upgrade path; else (including an unreachable runtime) landing. */
export function firstRunView(i: { flag: string | null; accounts: AcctsLike | null; workspace: WsLike | null }): "cockpit" | "landing" {
  if (i.flag === "1") return "cockpit";
  const active = i.accounts?.activeAccountId ?? null;
  const hasWs = !!i.workspace && (i.workspace.configured !== null || i.workspace.envPinned);
  return active !== null && hasWs ? "cockpit" : "landing";
}

export type AccountPlan = { kind: "create" } | { kind: "activate"; id: string } | { kind: "confirm"; id: string };
export function accountPlan(r: AcctsLike): AccountPlan {
  const sub = r.accounts.find((a) => a.providerType === "claude" && a.authMethod === "subscription");
  if (!sub) return { kind: "create" };
  return r.activeAccountId === sub.id ? { kind: "confirm", id: sub.id } : { kind: "activate", id: sub.id };
}

/** The mockup's folder rule: starts with / or ~ and is longer than 2 characters. */
// "~user" is refused: the runtime expands only a leading "~" or "~/".
export const folderOk = (p: string): boolean => /^(\/|~(\/|$))/.test(p.trim()) && p.trim().length > 2;

export type ProjectStatus = "active" | "pending" | "pinned";
export interface ReadyLine { text: string; confirmed: boolean }

/** Ready's summary (spec §5.3, amendment 3): a line is "confirmed" only when the runtime said so. */
export function readyLines(c: { engine: string; account: "subscription" | "later"; project: { path: string; status: ProjectStatus }; stations: number | null }): ReadyLine[] {
  const project = { active: "active", pending: "pending restart", pinned: "pinned by the runtime's environment, not applied" }[c.project.status];
  return [
    { text: `Engine: ${c.engine}`, confirmed: true },
    c.account === "subscription"
      ? { text: "Account: Claude subscription · active", confirmed: true }
      : { text: "Account: API key, later (add one in Accounts)", confirmed: false },
    { text: `Project: ${c.project.path} · ${project}`, confirmed: c.project.status === "active" },
    { text: `${c.stations ?? "—"} stations, standing by`, confirmed: c.stations !== null },
  ];
}

/** The mockup's example job (mockup lines 1233–1240), played only when the runtime has no events. */
export const HERO_SCRIPT: readonly (readonly [string, string])[] = [
  ["ceo", "Proceed. Cheaper option: ship the switch first, persist the choice in a second pass."],
  ["mgr", "Two tasks. sr-frontend owns the switch; sr-backend owns the saved setting."],
  ["fe", "@sr-backend what shape is the saved setting? I need the key and the default."],
  ["be", "Key `theme`, values `light` | `dark`, default follows the system."],
  ["fe", "Thanks. Wiring the switch to that now."],
  ["qa", "Both tasks green. Handing the diff to the BOSS for a yes."],
];

/** `p`, or a rejection after `ms`. The deadline timer is cleared once either side settles. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let id: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, no) => { id = setTimeout(() => no(new Error("timeout")), ms); });
  return Promise.race([p, deadline]).finally(() => clearTimeout(id));
}
