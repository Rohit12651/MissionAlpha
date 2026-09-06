// PHASE 1 TASKS 1.2 + 1.4 — the tools a non-Claude model gets, and the caps that bound them.
//
// THE RULE (plan, task 1.2): "the tools are the EXISTING ones ... against the SAME workdir
// and the SAME guards. No second write path. A tool call that escapes the workdir is
// refused exactly as an operator edit is."
//
// So: Read · Glob · Grep · Write · Edit, every write resolved through
// workdir-guard.resolveWorkdirDest — the same function patch-edit.mjs uses for an
// operator's edit. Nothing here writes to the repository. The agent fills its WORKDIR and
// broker.applyChanges remains the single, unchanged path from workdir to repo, behind
// applyAllowed + CONFIG_GUARD. That is exactly how the Claude CLI path already works; this
// gives an OpenAI-compatible model the same reach and the same fence.
//
// TASK 1.4 — CAPS, because an unbounded loop is the real risk here. A model that keeps
// calling tools costs money and can fill a disk. Every cap trips as a REFUSAL THE MODEL CAN
// SEE (a tool result saying the limit was hit), not a silent stop, so the transcript shows
// why the turn ended. Step and wall-clock caps live in the loop; the two that belong to the
// tools — file writes and total bytes written — live here, because this is where writing
// happens and a budget enforced anywhere else could be bypassed by a new call site.

import { readFile, writeFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { join, relative, sep, dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

import { resolveWorkdirDest } from "../workdir-guard.mjs";

/** Caps that bound a single autonomous turn. Overridable per call for tests and policy. */
export const DEFAULT_LIMITS = Object.freeze({
  maxWrites: 40, // distinct successful file writes
  maxBytesWritten: 2 * 1024 * 1024, // total bytes across all writes
  maxReadBytes: 256 * 1024, // per-file read ceiling, so one huge file cannot eat the context
  maxGlobResults: 300,
  maxGrepMatches: 200,
  // SECURITY (Phase 1 verification, HIGH): Grep compiles a pattern the untrusted MODEL
  // supplies. A backtracking regex over a haystack the model can also write is a
  // whole-process DoS, and it bypasses every other cap here because they are only checked
  // BETWEEN tool calls. The match therefore runs in a worker the parent can terminate.
  maxGrepMs: 5000,
  maxGrepFileBytes: 512 * 1024,
  maxGrepLineLength: 2000,
  maxWalkFiles: 5000, // mirrors broker.walk's own DoS bound
  maxWalkDepth: 24,
});

/** The OpenAI function-calling schemas advertised to the model. */
export const TOOL_SCHEMAS = Object.freeze([
  {
    type: "function",
    function: {
      name: "Read",
      description:
        "Read a UTF-8 text file from the working directory. Paths are relative to the working directory root.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Path relative to the working directory" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Glob",
      description: "List files in the working directory whose path matches a glob pattern, e.g. 'src/**/*.ts'.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string", description: "Glob pattern, * and ** and ? supported" } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Grep",
      description: "Search file contents in the working directory for a regular expression. Returns path:line matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regular expression source" },
          glob: { type: "string", description: "Optional glob to restrict which files are searched" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Write",
      description:
        "Create or overwrite a UTF-8 text file in the working directory. Creates parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the working directory" },
          content: { type: "string", description: "Full file contents" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Edit",
      description:
        "Replace an exact substring in an existing file. Fails if old_string is absent or appears more than once, so an ambiguous edit is never guessed at.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the working directory" },
          old_string: { type: "string", description: "Exact text to replace; must occur exactly once" },
          new_string: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
]);

export const TOOL_NAMES = Object.freeze(TOOL_SCHEMAS.map((t) => t.function.name));

/** Anchored glob -> RegExp. `**` crosses separators, `*` and `?` do not. */
export function globToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` should also match zero directories, so 'src/**/*.ts' finds 'src/a.ts'.
        if (pattern[i + 2] === "/") { out += "(?:.*/)?"; i += 2; } else { out += ".*"; i += 1; }
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Relative file paths under `root`, bounded exactly like broker.walk. */
async function walkFiles(root, limits, base = root, depth = 0, acc = { n: 0 }) {
  const out = [];
  if (depth > limits.maxWalkDepth || acc.n > limits.maxWalkFiles) return out;
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // never follow links, same as broker.walk
    const full = join(root, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      out.push(...(await walkFiles(full, limits, base, depth + 1, acc)));
    } else if (e.isFile()) {
      acc.n++;
      out.push(relative(base, full).split(sep).join("/"));
      if (acc.n > limits.maxWalkFiles) break;
    }
  }
  return out;
}

/** A tool result the model can read. `ok:false` is a message, never a thrown error. */
const ok = (content) => ({ ok: true, content });
const no = (content) => ({ ok: false, content });

/**
 * Build the tool executor for one autonomous turn.
 *
 * Returns `{ schemas, names, execute, stats }`. `execute(name, args)` NEVER throws: every
 * failure comes back as a tool result string, because the model has to be able to read the
 * refusal and correct itself. A thrown error would end the turn with the model never
 * learning what it did wrong.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Run Grep in a worker with a HARD DEADLINE.
 *
 * The parent owns the deadline because only the parent can `terminate()` a thread that is
 * wedged in a synchronous regex — the worker cannot rescue itself. Timing out is a normal,
 * readable refusal: the model is told its pattern was too expensive and can pick another.
 */
function runGrepIsolated({ workdir, pattern, glob, limits }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(result);
    };
    const worker = new Worker(join(HERE, "grep-worker.mjs"), {
      workerData: { workdir, pattern, glob, limits },
    });
    const timer = setTimeout(
      () =>
        finish(
          no(
            `Grep timed out after ${limits.maxGrepMs}ms — that pattern is too expensive to run. ` +
              `Use a simpler expression (avoid nested quantifiers such as (a+)+).`,
          ),
        ),
      limits.maxGrepMs,
    );
    worker.on("message", (m) => finish(m && m.ok ? ok(m.content) : no(m?.content ?? "grep failed")));
    worker.on("error", (err) => finish(no(`grep failed: ${err?.message ?? err}`)));
    worker.on("exit", (code) => {
      if (!settled && code !== 0) finish(no(`grep worker exited with code ${code}`));
    });
  });
}

/**
 * Write via scratch file + rename, the SAME mechanism patch-edit.stageEdits uses.
 *
 * `resolveWorkdirDest` lstats the destination and refuses a symlink, but a link planted in
 * the gap before the write would still be followed. `rename(2)` does not follow a symlink
 * at the destination — it replaces it — so the swap wins nothing. The operator path fixed
 * this after review; the UNTRUSTED path shipped without it, which is the wrong way round.
 * Exploitability is low today (the model's five tools cannot create a symlink), so this is
 * defence in depth and consistency with "the same guards", not a live escape.
 */
let scratchSeq = 0;
async function writeAtomically(dest, content) {
  const tmp = `${dest}.tool-${process.pid}-${scratchSeq++}.tmp`;
  try {
    await writeFile(tmp, content, { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    return { ok: false, error: `${err?.message ?? err}` };
  }
  try {
    await rename(tmp, dest);
  } catch (err) {
    try { await unlink(tmp); } catch { /* already gone */ }
    return { ok: false, error: `${err?.message ?? err}` };
  }
  return { ok: true };
}

export function createExecTools({ workdir, limits = {} } = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const stats = { writes: 0, bytesWritten: 0, calls: 0, byTool: Object.create(null) };
  let realRoot = null;

  async function root() {
    if (realRoot === null) realRoot = await realpath(workdir);
    return realRoot;
  }

  /** Resolve a path for reading; refuses everything the write guard refuses. */
  async function readableDest(rel) {
    return resolveWorkdirDest({ workdir, realRoot: await root(), rel, allowCreate: false });
  }

  const tools = {
    async Read({ path }) {
      if (typeof path !== "string") return no("Read requires a string 'path'");
      const r = await readableDest(path);
      if (!r.ok) return no(`cannot read ${path}: ${r.error}`);
      let body;
      try {
        body = await readFile(r.dest, "utf-8");
      } catch (err) {
        return no(`cannot read ${path}: ${err?.message ?? err}`);
      }
      if (body.length > lim.maxReadBytes) {
        return ok(`${body.slice(0, lim.maxReadBytes)}\n…(truncated at ${lim.maxReadBytes} bytes)`);
      }
      return ok(body);
    },

    async Glob({ pattern }) {
      if (typeof pattern !== "string") return no("Glob requires a string 'pattern'");
      let re;
      try {
        re = globToRegExp(pattern);
      } catch (err) {
        return no(`invalid glob: ${err?.message ?? err}`);
      }
      const files = (await walkFiles(workdir, lim)).filter((f) => re.test(f)).sort();
      if (!files.length) return ok(`no files match ${pattern}`);
      const shown = files.slice(0, lim.maxGlobResults);
      const more = files.length > shown.length ? `\n…(${files.length - shown.length} more)` : "";
      return ok(shown.join("\n") + more);
    },

    async Grep({ pattern, glob }) {
      if (typeof pattern !== "string") return no("Grep requires a string 'pattern'");
      // ISOLATED, NOT INSPECTED. See providers/grep-worker.mjs for the measured blowup this
      // prevents. Detecting "dangerous" patterns is a losing game; a terminable worker
      // bounds every pattern, including ones nobody has thought of.
      return runGrepIsolated({ workdir, pattern, glob, limits: lim });
    },

    async Write({ path, content }) {
      if (typeof path !== "string") return no("Write requires a string 'path'");
      if (typeof content !== "string") return no("Write requires a string 'content'");
      // CAPS CHECKED BEFORE THE WRITE, and reported so the model sees the boundary.
      if (stats.writes >= lim.maxWrites) {
        return no(`write limit reached (${lim.maxWrites} files); no further writes are possible this turn`);
      }
      const size = Buffer.byteLength(content, "utf-8");
      if (stats.bytesWritten + size > lim.maxBytesWritten) {
        return no(
          `byte budget exhausted (${lim.maxBytesWritten} bytes for this turn, ${stats.bytesWritten} already written)`,
        );
      }
      const r = await resolveWorkdirDest({ workdir, realRoot: await root(), rel: path, allowCreate: true });
      if (!r.ok) return no(`cannot write ${path}: ${r.error}`);
      const w = await writeAtomically(r.dest, content);
      if (!w.ok) return no(`cannot write ${path}: ${w.error}`);
      stats.writes += 1;
      stats.bytesWritten += size;
      return ok(`wrote ${path} (${size} bytes)`);
    },

    async Edit({ path, old_string: oldStr, new_string: newStr }) {
      if (typeof path !== "string") return no("Edit requires a string 'path'");
      if (typeof oldStr !== "string" || typeof newStr !== "string") {
        return no("Edit requires string 'old_string' and 'new_string'");
      }
      if (oldStr === "") return no("Edit requires a non-empty 'old_string'");
      const r = await readableDest(path);
      if (!r.ok) return no(`cannot edit ${path}: ${r.error}`);
      let body;
      try {
        body = await readFile(r.dest, "utf-8");
      } catch (err) {
        return no(`cannot edit ${path}: ${err?.message ?? err}`);
      }
      const first = body.indexOf(oldStr);
      if (first === -1) return no(`cannot edit ${path}: old_string not found`);
      // AMBIGUITY IS A REFUSAL, not a guess. Replacing the first of several occurrences
      // silently edits a line the model did not mean, and nothing downstream would show it.
      if (body.indexOf(oldStr, first + 1) !== -1) {
        return no(`cannot edit ${path}: old_string appears more than once; include more context to disambiguate`);
      }
      const next = body.slice(0, first) + newStr + body.slice(first + oldStr.length);
      const delta = Buffer.byteLength(next, "utf-8") - Buffer.byteLength(body, "utf-8");
      if (stats.writes >= lim.maxWrites) {
        return no(`write limit reached (${lim.maxWrites} files); no further edits are possible this turn`);
      }
      if (stats.bytesWritten + Math.max(0, delta) > lim.maxBytesWritten) {
        return no(`byte budget exhausted (${lim.maxBytesWritten} bytes for this turn)`);
      }
      const w = await writeAtomically(r.dest, next);
      if (!w.ok) return no(`cannot edit ${path}: ${w.error}`);
      stats.writes += 1;
      stats.bytesWritten += Math.max(0, delta);
      return ok(`edited ${path}`);
    },
  };

  return {
    schemas: TOOL_SCHEMAS,
    names: TOOL_NAMES,
    stats,
    limits: lim,
    /** Never throws. An unknown tool is a readable refusal, not a crash. */
    async execute(name, args) {
      stats.calls += 1;
      stats.byTool[name] = (stats.byTool[name] || 0) + 1;
      const fn = tools[name];
      if (!fn) return no(`unknown tool "${name}". Available: ${TOOL_NAMES.join(", ")}`);
      try {
        return await fn(args && typeof args === "object" ? args : {});
      } catch (err) {
        // Defensive: a tool bug must not kill the turn silently.
        return no(`${name} failed: ${err?.message ?? err}`);
      }
    },
  };
}
