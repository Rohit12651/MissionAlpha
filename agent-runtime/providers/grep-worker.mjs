// PHASE 1 SECURITY FIX — Grep runs HERE, in a worker, never on the server's event loop.
//
// THE DEFECT THIS EXISTS FOR (found by independent verification of Phase 1, HIGH):
// `Grep` hands an UNTRUSTED third-party model's `pattern` straight to JS's backtracking
// RegExp and matched it synchronously inside the main server process. The model also
// controls the haystack — it can `Write` the file it then greps. Measured blowup on the
// real code path with `(a+)+$`:
//
//     line length 22  ->   794 ms
//     line length 26  ->  1131 ms
//     line length 30  -> 18127 ms
//     line length 34  -> never returned
//
// That is a whole-process denial of service: a synchronous regex freezes every HTTP
// handler, every other agent, and the kill-switch registration. The Claude CLI path is
// isolated in a spawned child and uses ripgrep (linear-time); the non-Claude path was
// in-process and backtracking, so "the same tools, the same guards" was false and the
// UNTRUSTED path had the weaker one.
//
// Worse, it defeated the entire cap system: steps, wall-clock, writes, bytes and USD are
// all checked BETWEEN tool calls, so a single unbounded call inside `execute` trips none
// of them. Task 1.4 named caps as "the real risk control"; one regex walked past all five.
//
// THE FIX IS ISOLATION, NOT PATTERN INSPECTION. Trying to detect "dangerous" regexes is a
// losing game — the safe-regex literature is a graveyard of bypasses. A worker that the
// parent can `terminate()` bounds ANY pattern, including ones nobody has thought of yet.
// The parent enforces the deadline; this file just does the work and reports.

import { parentPort, workerData } from "node:worker_threads";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Anchored glob -> RegExp. Duplicated from exec-tools rather than imported so the worker
 *  stays a leaf module with no cycle back into the tool surface. */
function globToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") { out += "(?:.*/)?"; i += 2; } else { out += ".*"; i += 1; }
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

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

async function run() {
  const { workdir, pattern, glob, limits } = workerData;

  let re;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    parentPort.postMessage({ ok: false, content: `invalid regular expression: ${err?.message ?? err}` });
    return;
  }

  let files = await walkFiles(workdir, limits);
  if (typeof glob === "string" && glob) {
    let g;
    try {
      g = globToRegExp(glob);
    } catch (err) {
      parentPort.postMessage({ ok: false, content: `invalid glob: ${err?.message ?? err}` });
      return;
    }
    files = files.filter((f) => g.test(f));
  }

  const hits = [];
  for (const f of files) {
    if (hits.length >= limits.maxGrepMatches) break;
    let body;
    try {
      body = await readFile(join(workdir, f), "utf-8");
    } catch {
      continue; // binary or unreadable — skip rather than fail the whole search
    }
    // Bounds what is SEARCHED, not what is READ. The full file is still allocated by
    // readFile above and only then sliced. Said precisely because the first version of this
    // comment called it a "per-file ceiling" closing Grep's unbounded-read gap, which
    // overstated it — the read is still unbounded, the MATCH is not. That matters little
    // here (this runs off the main loop, and the model can write at most 2MB per turn, so
    // only large pre-existing operator-owned files are affected) but a comment that claims
    // more than the code delivers is the defect class this program keeps paying for.
    if (body.length > limits.maxGrepFileBytes) body = body.slice(0, limits.maxGrepFileBytes);
    const lines = body.split("\n");
    for (let i = 0; i < lines.length && hits.length < limits.maxGrepMatches; i++) {
      const line = lines[i];
      // Defence in depth: catastrophic backtracking scales with input length, so an
      // absurdly long line is skipped rather than matched. The deadline is still the real
      // guarantee — this only makes the common case cheap.
      if (line.length > limits.maxGrepLineLength) continue;
      if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.slice(0, 300)}`);
    }
  }

  parentPort.postMessage({
    ok: true,
    content: hits.length ? hits.join("\n") : `no matches for ${pattern}`,
  });
}

run().catch((err) => {
  parentPort.postMessage({ ok: false, content: `grep failed: ${err?.message ?? err}` });
});
