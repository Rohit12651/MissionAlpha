// Agent Factory client — typed fetchers over the vite-proxied /factory/* runtime
// endpoints. Reuses the same same-origin runtime token as AgentChat/BossConsole.

export interface Skill {
  id: string;
  label: string;
  desc: string;
  tools: string[];
  platforms: string[];
  posting: boolean;
}
export interface Platform {
  id: string;
  label: string;
  maxChars: number;
  dailyCap: number;
}
export interface AgentSpec {
  id: string;
  role: string;
  title: string;
  skills: string[];
  tools: string[];
  integrations: string[];
  createdBy: string;
  createdAt: string | null;
  persona?: string;
  personaPreview?: string;
}
export interface Connection {
  connId: string;
  platform: string;
  handle: string;
  createdAt: string;
}
export interface PostPreview {
  dryRun: true;
  confirmToken: string;
  preview: {
    agentId: string;
    platform: string;
    platformLabel: string;
    handle: string;
    content: string;
    chars: number;
    maxChars: number;
    composio: boolean;
  };
  rate: { used: number; cap: number; remaining: number };
}
export interface PostResult {
  ok?: boolean;
  simulated?: boolean;
  postId?: string;
  url?: string | null;
  platform?: string;
  handle?: string;
  rate?: { used: number; cap: number; remaining: number };
  error?: string;
}

// Cached same-origin runtime token (mirrors AgentChat).
let tokenPromise: Promise<string> | null = null;
export function runtimeToken(): Promise<string> {
  if (!tokenPromise) {
    tokenPromise = fetch("/api/runtime-token", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { token: "" }))
      .then((j) => (j as { token?: string }).token ?? "")
      .catch(() => "");
  }
  return tokenPromise;
}

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await runtimeToken();
  return fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", "x-runtime-token": token, ...(init.headers || {}) },
  });
}
async function authedJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await authed(path, init);
  return (await r.json()) as T;
}

export const getSkills = () =>
  fetch("/factory/skills").then((r) => r.json()) as Promise<{ skills: Skill[]; platforms: Platform[] }>;
export const getFactoryHealth = () =>
  fetch("/factory/health").then((r) => r.json()).catch(() => ({ ok: false })) as Promise<{
    ok: boolean;
    composio?: boolean;
    platforms?: string[];
  }>;
export const listAgents = () => authedJson<{ agents: AgentSpec[] }>("/factory/agents");
export const createAgent = (spec: Partial<AgentSpec>) =>
  authedJson<{ spec?: AgentSpec; error?: string }>("/factory/create", {
    method: "POST",
    body: JSON.stringify({ spec }),
  });
export const deleteAgent = (id: string) =>
  authedJson<{ ok?: boolean; error?: string }>(`/factory/${encodeURIComponent(id)}`, { method: "DELETE" });
export const updateAgent = (
  id: string,
  patch: Partial<Pick<AgentSpec, "skills" | "tools" | "integrations" | "persona">>,
) =>
  authedJson<{ spec?: AgentSpec; error?: string }>(`/factory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

export const listConnections = () => authedJson<{ connections: Connection[] }>("/factory/connections");
export const connectAccount = (platform: string, handle: string, secret: string) =>
  authedJson<{ connection?: Connection; error?: string }>("/factory/connect", {
    method: "POST",
    body: JSON.stringify({ platform, handle, secret }),
  });
export const deleteConnection = (connId: string) =>
  authedJson<{ ok?: boolean; error?: string }>(`/factory/connections/${encodeURIComponent(connId)}`, {
    method: "DELETE",
  });

export const previewPost = (agentId: string, connId: string, content: string) =>
  authedJson<PostPreview & { error?: string }>("/factory/post/preview", {
    method: "POST",
    body: JSON.stringify({ agentId, connId, content }),
  });
export const executePost = (agentId: string, connId: string, content: string, confirmToken: string) =>
  authedJson<PostResult>("/factory/post/execute", {
    method: "POST",
    body: JSON.stringify({ agentId, connId, content, confirmToken }),
  });

// Stream the agent-creator: yields reasoning tokens, resolves with the parsed spec
// (or an error). onToken receives streamed reasoning text for the live "authoring" UI.
export async function authorAgent(
  description: string,
  onToken: (t: string) => void,
): Promise<{ spec?: AgentSpec; error?: string }> {
  const token = await runtimeToken();
  const res = await authed("/factory/author", {
    method: "POST",
    body: JSON.stringify({ description }),
    headers: { "x-runtime-token": token },
  });
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => ({}));
    return { error: (j as { error?: string }).error || `HTTP ${res.status}` };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let specResult: { spec?: AgentSpec; error?: string } = { error: "no spec produced" };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() || "";
    for (const f of frames) {
      const ev = /event: (.+)/.exec(f)?.[1];
      const dataLine = /data: ([\s\S]*)/.exec(f)?.[1];
      if (!dataLine) continue;
      let data: unknown;
      try {
        data = JSON.parse(dataLine);
      } catch {
        continue;
      }
      if (ev === "token") onToken(String(data));
      else if (ev === "spec") {
        // server sends the validated result JSON-stringified (scrubbed)
        try {
          const parsed = JSON.parse(String(data)) as { spec?: AgentSpec; error?: string };
          specResult = parsed;
        } catch {
          specResult = { error: "spec parse failed" };
        }
      } else if (ev === "error") specResult = { error: String(data) };
    }
  }
  return specResult;
}
