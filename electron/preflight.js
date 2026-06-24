// electron/preflight.js — host dependency check. Tier-1 = dev-machine (deps present).
// claude+auth are blocking; docker is a non-blocking warning (chat works without it).
export async function preflight({ exec, env = process.env }) {
  const probe = async (cmd) => { try { const r = await exec(cmd); return !r || r.code === 0; } catch { return false; } };
  const claude = await probe("claude --version");
  const docker = await probe("docker info");
  const auth = claude || Boolean(env.ANTHROPIC_API_KEY);
  const messages = [];
  if (!claude) messages.push("`claude` CLI not found on PATH. Install Claude Code and log in (subscription) or set ANTHROPIC_API_KEY.");
  if (!auth) messages.push("No Claude auth detected — log into Claude Code or set ANTHROPIC_API_KEY.");
  if (!docker) messages.push("Docker daemon not reachable — chat works, but /exec (sandboxed code execution) is disabled until Docker is running.");
  const ok = claude && auth;
  return { claude, docker, auth, ok, blocking: !ok, messages };
}
