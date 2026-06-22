// ADR-038 — Full Tool-Loop Broker over the sandbox. The runtime MEDIATES execution:
// every command is CLASSIFIED, then (if allowed) executed INSIDE a locked container
// (sandbox.mjs) over the agent's git worktree. Default-deny: only provably-safe
// read-only commands auto-run; everything else needs approval; FORBIDDEN never runs.
//
// SECURITY: classification treats the command as hostile. Any shell control operator
// (; | & $ ` > < newline, &&, ||, $()) disqualifies SAFE (→ SENSITIVE at best), and
// FORBIDDEN patterns are matched across the WHOLE string regardless of structure. The
// container is the real boundary; classification is defense-in-depth on top of it.

// FORBIDDEN — host-escape / privilege / exfil / destructive-to-host. Matched on the
// full command string; if ANY hits → reject, never runs (not even with approval).
const FORBIDDEN = [
  { re: /(^|[\s;&|])(docker|podman|kubectl|nerdctl)([\s;&|]|$)/i, why: "container runtime" },
  { re: /(^|[\s;&|])(sudo|su|doas|pkexec)([\s;&|]|$)/i, why: "privilege escalation" },
  { re: /(^|[\s;&|])(mount|umount|chroot|unshare|nsenter|pivot_root|setns)([\s;&|]|$)/i, why: "namespace/mount escape" },
  { re: /(^|[\s;&|])(reboot|shutdown|halt|poweroff|systemctl|service)([\s;&|]|$)/i, why: "host control" },
  { re: /(^|[\s;&|])mknod([\s;&|]|$)/i, why: "device node" },
  { re: /\bdd\b[^\n]*\bof=\/dev\//i, why: "raw device write" },
  { re: /\/dev\/(tcp|udp)\//i, why: "reverse shell" },
  { re: /(^|[\s;&|])nc\b[^\n]*\s-e\b/i, why: "netcat exec" },
  { re: /(curl|wget|fetch)\b[^\n;|&]*\|\s*(sh|bash|zsh)\b/i, why: "pipe-to-shell" },
  { re: /(^|[^a-z0-9_])\.ssh([^a-z0-9_]|$)/i, why: "ssh keys" },
  { re: /(^|[^a-z0-9_])\.claude([^a-z0-9_]|$)/i, why: "claude creds" },
  { re: /(^|[\s"'=:])\/etc(\/|\b)/i, why: "host /etc" },
  { re: /(^|[\s"'=:])\/Users(\/|\b)/i, why: "host /Users" },
  { re: /(^|[\s"'=:])\/root(\/|\b)/i, why: "host /root" },
  { re: /(^|[\s"'=:])\/home(\/|\b)/i, why: "host /home" },
  { re: /\/proc(\/|\b)/i, why: "/proc (env/host-root exposure)" },
  { re: /\.\.\//, why: "path traversal above /work" },
  { re: /(^|[\s"'=:])~(\/|\s|$)/, why: "home expansion" },
  { re: /:\s*\(\s*\)\s*\{.*\}\s*;/, why: "fork bomb" },
];

// Shell control operators + glob metacharacters — presence disqualifies SAFE (the
// command is no longer a single, literal, read-only invocation; globs like /et*/passwd
// can dodge literal-path FORBIDDEN guards, so they force SENSITIVE → approval).
const SHELL_CTRL = /[;&|`$<>\n*?{}[\]]|\$\(|&&|\|\|/;

// Read-only / idempotent verbs that may auto-run (SAFE) when standalone + no operators.
const SAFE_VERBS = new Set(["ls", "cat", "head", "tail", "wc", "pwd", "echo", "true", "stat", "date", "whoami", "id", "grep", "find", "cut", "sort", "uniq", "basename", "dirname", "env", "printf", "file", "diff", "tree"]);
// Commands needing a subcommand/flag check before they count as SAFE.
const SAFE_GIT = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "describe"]);

// Network-implying tokens — SENSITIVE commands touching these need the network capability.
const NETWORK_RE = /(^|[\s;&|])(npm|pnpm|yarn|pip|pip3|curl|wget|fetch|apk|apt|apt-get|go)\b|\bgit\s+(clone|fetch|pull|push|remote)\b/i;

export function classify(commandRaw) {
  const command = String(commandRaw || "").trim();
  if (!command) return { klass: "forbidden", reason: "empty command", network: false };
  // 1) FORBIDDEN — checked first, on the whole string.
  for (const f of FORBIDDEN) if (f.re.test(command)) return { klass: "forbidden", reason: f.why, network: false };

  const network = NETWORK_RE.test(command);

  // 2) SAFE — only a single read-only invocation, no shell operators. The verb
  // allowlist below already excludes network tools (curl/wget not listed; npm/yarn
  // only `--version`; git only read-only subcommands), so a network command can never
  // reach SAFE even though NETWORK_RE flags `npm --version` for the SENSITIVE path.
  if (!SHELL_CTRL.test(command)) {
    const tokens = command.split(/\s+/);
    const verb = tokens[0];
    let safe = false;
    if (verb === "git") safe = SAFE_GIT.has(tokens[1]);
    else if (verb === "node" || verb === "npm" || verb === "pnpm" || verb === "yarn") safe = tokens[1] === "--version" || tokens[1] === "-v";
    else if (verb === "find") safe = SAFE_VERBS.has(verb) && !/-(exec|delete|execdir|fprint|fls)/.test(command);
    else safe = SAFE_VERBS.has(verb);
    if (safe) return { klass: "safe", reason: "read-only", network: false };
  }

  // 3) Everything else → SENSITIVE (default-deny: needs approval before it runs).
  return { klass: "sensitive", reason: "writes/installs/runs or not provably read-only", network };
}

export function createToolBroker(opts = {}) {
  const sandbox = opts.sandbox;          // createSandbox()
  const worktreeFor = opts.worktreeFor;  // (agentId) → host worktree dir (bind-mounted /work)
  const audit = opts.audit || (() => {}); // (event, data) — secrets never passed in
  const now = opts.now || (() => Date.now());
  // G1/G2/G3: isFactoryAgent predicate — defaults to false (all built-ins pass through unchanged).
  // Injected from factory.mjs registry membership so the broker stays decoupled from imports.
  const isFactory = opts.isFactoryAgent || (() => false);

  // G3: derive the trust tier for a given agentId.
  function tierFor(agentId) {
    return isFactory(agentId) ? "factory" : "builtin";
  }

  // G2: network is allowed for an agent only when it is NOT a factory-tier agent.
  // Built-in agents keep current behavior (network honored when requested + needed).
  function networkAllowed(agentId) {
    return !isFactory(agentId);
  }

  // Decide what happens to a proposed command for an agent (policy lives at the route
  // layer for approval memory; this returns the classification + whether it can auto-run).
  // G1: factory agents are NEVER auto-run, even for `safe` commands.
  function decide(agentId, command) {
    const c = classify(command);
    const factory = isFactory(agentId);
    return { ...c, autoRun: !factory && c.klass === "safe" };
  }

  // Execute an APPROVED (or auto-safe) command in the sandbox over the agent's worktree.
  // FORBIDDEN is refused here too (never trust the caller). Audited.
  // G2: network is default-deny for factory tier.
  // G3: tier is stamped in the exec.run audit line.
  async function execTool(agentId, command, o = {}) {
    const c = classify(command);
    if (c.klass === "forbidden") {
      audit("exec.forbidden", { agentId, reason: c.reason, callId: o.callId });
      return { refused: true, klass: "forbidden", reason: c.reason };
    }
    const dir = worktreeFor(agentId);
    if (!dir) return { refused: true, reason: "no worktree for agent" };
    // G2: factory tier is network-denied regardless of o.network
    const network = networkAllowed(agentId) && !!o.network && c.network;
    const tier = tierFor(agentId); // G3
    audit("exec.run", { agentId, tier, klass: c.klass, network, callId: o.callId, cmd: command.slice(0, 200) });
    const res = await sandbox.runInSandbox(dir, command, {
      network, callId: o.callId, timeoutMs: o.timeoutMs || 120000, signal: o.signal, onData: o.onData,
    });
    audit("exec.done", { agentId, callId: o.callId, exitCode: res.exitCode, timedOut: res.timedOut, killed: res.killed });
    return { refused: false, klass: c.klass, ...res };
  }

  return { classify, decide, execTool };
}
