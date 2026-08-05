// P9 — second seat auth client. Typed fetchers over the vite-proxied /runtime/auth
// and /runtime/users routes, same token header + base as inboxClient. The session
// cookie is HttpOnly and set/sent by the browser automatically (same-origin fetch
// defaults to credentials:"same-origin"); JS never reads or writes it.
import { runtimeToken, runtimeUrl } from "./runtimeBase.ts";

export type Role = "approver" | "viewer";

export interface AuthUser {
  name: string;
  role: Role;
}

/** GET /runtime/auth/me — whether login is required, and who is logged in. */
export interface MeResult {
  authActive: boolean;
  userCount: number;
  user: AuthUser | null;
}

/** A managed account (never carries the password hash). */
export interface ManagedUser {
  id: string;
  name: string;
  role: Role;
  createdAt: string;
}

async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await runtimeToken();
  return fetch(runtimeUrl(path), {
    ...init,
    cache: "no-store",
    credentials: "same-origin", // send/receive the HttpOnly session cookie
    headers: { "Content-Type": "application/json", "x-runtime-token": token, ...(init.headers || {}) },
  });
}

/**
 * GET /runtime/auth/me. Returns the auth state. A 401 (auth active, no valid session)
 * is NOT thrown — it carries `{authActive:true,user:null}`, which is exactly what the
 * caller needs to show the LoginGate. Any other transport failure defaults to solo so
 * the app never hard-locks on a runtime hiccup.
 */
export async function getMe(): Promise<MeResult> {
  try {
    const r = await authFetch("/runtime/auth/me");
    if (r.status === 401 || r.ok) {
      const j = (await r.json()) as MeResult;
      return { authActive: !!j.authActive, userCount: j.userCount ?? 0, user: j.user ?? null };
    }
  } catch {
    /* fall through */
  }
  return { authActive: false, userCount: 0, user: null };
}

export interface LoginResult {
  ok: boolean;
  user?: AuthUser;
  error?: string;
}

export async function login(name: string, password: string): Promise<LoginResult> {
  try {
    const r = await authFetch("/runtime/auth/login", { method: "POST", body: JSON.stringify({ name, password }) });
    if (r.ok) return { ok: true, user: (await r.json()).user as AuthUser };
    // Generic error — the server never distinguishes unknown-user from wrong-password.
    return { ok: false, error: "Incorrect name or password." };
  } catch {
    return { ok: false, error: "Could not reach the runtime." };
  }
}

export async function logout(): Promise<void> {
  try { await authFetch("/runtime/auth/logout", { method: "POST" }); } catch { /* best-effort */ }
}

export async function listUsers(): Promise<ManagedUser[]> {
  try {
    const r = await authFetch("/runtime/users");
    if (!r.ok) return [];
    return ((await r.json()).users ?? []) as ManagedUser[];
  } catch {
    return [];
  }
}

export interface CreateUserResult {
  ok: boolean;
  user?: ManagedUser;
  error?: string;
}

export async function createUser(name: string, password: string, role: Role): Promise<CreateUserResult> {
  try {
    const r = await authFetch("/runtime/users", { method: "POST", body: JSON.stringify({ name, password, role }) });
    const j = await r.json();
    if (r.ok) return { ok: true, user: j.user as ManagedUser };
    return { ok: false, error: j.error || `Could not add user (HTTP ${r.status}).` };
  } catch {
    return { ok: false, error: "Could not reach the runtime." };
  }
}

export async function deleteUser(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await authFetch(`/runtime/users/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (r.ok) return { ok: true };
    return { ok: false, error: (await r.json()).error || `Could not remove user (HTTP ${r.status}).` };
  } catch {
    return { ok: false, error: "Could not reach the runtime." };
  }
}

// ── @mention parsing (display only) ───────────────────────────────────────────
export interface MentionSegment {
  type: "text" | "mention";
  value: string;
}

/**
 * Split feedback text into plain + @mention segments for highlighting. Purely
 * cosmetic (P9 scope: "parse, display only") — a mention triggers no notification
 * and no side effect. A mention is `@` followed by name-safe chars.
 */
export function parseMentions(text: string): MentionSegment[] {
  const out: MentionSegment[] = [];
  if (!text) return out;
  const re = /@([A-Za-z0-9._-]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ type: "text", value: text.slice(last, m.index) });
    out.push({ type: "mention", value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}
