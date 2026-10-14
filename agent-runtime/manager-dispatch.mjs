// Phase 9 / task 9.3 — THE MANAGER'S DISPATCH. Two modes, one interface.
//
// mode "claude"        — a real `claude -p` turn, read-only, on a throwaway worktree.
// mode "deterministic" — canned answers keyed by stage, no model at all.
//
// The deterministic mode is not a test double bolted on afterwards: it is how the WHOLE loop
// runs in CI (14.1's "paste → shipped with no model"), and it is how Phase 9 was proven while
// the Manager prompts still await the BOSS's read (9.0 is a blocking checkpoint).
//
// PARSING IS FAIL-CLOSED. The model's reply is scanned for the LAST fenced ```json block.
// Missing, malformed, or not an object ⇒ `{ok:false, error}` — never an empty success. A
// Manager that reads `{}` as "no questions, no tasks" would mark a job planned with nothing
// in it (PES: a fallback may say "unknown", it may never state a fact).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { intakePrompt, clarifyPrompt, planPrompt, managePrompt, reviewPrompt, strategyPrompt, parseVerdict, STRATEGY_PROMPT_APPROVED } from "./manager-prompts.mjs";

// Phase F · 20 — the CEO's persona lives in the RUNTIME's own repo, never the target's: a target
// repo must not be able to choose who judges its jobs. Read per turn (it is small) so an edit by
// the operator takes effect without a restart; unreadable ⇒ "" ⇒ strategyPrompt returns null.
const CEO_MD = join(dirname(fileURLToPath(import.meta.url)), "..", ".claude", "agents", "ceo.md");
const readCeo = () => { try { return readFileSync(CEO_MD, "utf8"); } catch { return ""; } };

/** The Manager's tools. READ-ONLY: no Write, no Edit, and Bash is a command allow-list. */
export const MANAGER_TOOLS = Object.freeze([
  "Read", "Glob", "Grep",
  "Bash(ls:*)", "Bash(rg:*)", "Bash(cat:*)", "Bash(git log:*)", "Bash(git show:*)",
]);
export const MANAGER_MAX_TURNS = 40;

/**
 * PURE. Pull the LAST fenced json block out of a model reply.
 * The last, not the first: a model that shows its working may fence an example on the way to
 * the real answer, and the answer is what it ends with.
 */
export function parseFencedJson(text) {
  const s = String(text ?? "");
  const blocks = [...s.matchAll(/```json\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  if (!blocks.length) return { ok: false, error: "no fenced json block in the reply" };
  const raw = blocks[blocks.length - 1].trim();
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return { ok: false, error: `unparseable json: ${e.message}` }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "the json block is not an object" };
  }
  return { ok: true, data: parsed };
}

/**
 * PURE-ish. A deterministic, runtime-produced summary of the repo, so intake starts from real
 * ground rather than the model's guess and the same job yields the same start on a re-run.
 */
export function repoFacts(repoRoot, { seedDirs = ["src", "agent-runtime", "docs"], cap = 60 } = {}) {
  const out = [];
  for (const d of seedDirs) {
    try {
      const names = readdirSync(join(repoRoot, d), { withFileTypes: true })
        .filter((e) => e.isFile() || e.isDirectory()).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
      out.push(`${d}/: ${names.slice(0, cap).join(", ")}${names.length > cap ? ` … (+${names.length - cap} more)` : ""}`);
    } catch { out.push(`${d}/: (not present)`); }
  }
  return out.join("\n");
}

const promptFor = (stage, job, ctx) => {
  if (stage === "intake") return intakePrompt(job, ctx.facts);
  if (stage === "strategy") return strategyPrompt(job, readCeo(), ctx.findings);
  if (stage === "clarify") return clarifyPrompt(job, ctx.needs);
  if (stage === "plan") return planPrompt(job, ctx.roster, ctx.findings, ctx.answers, ctx.catalog);
  if (stage === "manage") return managePrompt(job, ctx.inbox, ctx.tasks);
  // 11.1 — the review turn's input is RUNTIME-COMPUTED (each task's diff, and a fresh re-run
  // of its scoped gate). It arrives on `ctx.reviewTasks`, not from the job row, because this
  // module can reach neither the worktrees nor the jail.
  if (stage === "review") return reviewPrompt(job, ctx.reviewTasks);
  return null;
};

/**
 * createManagerDispatch({ mode, spawn, repoRoot, roster, jobs, mailbox, worktrees, managerId })
 * `spawn({ prompt, tools, maxTurns, cwd })` → Promise<string>  (injected; the real one is the
 * server's claude runner, so this module spawns nothing itself and stays unit-testable).
 */
export function createManagerDispatch({
  mode = "deterministic", spawn, repoRoot = process.cwd(), roster,
  jobs, mailbox, worktrees, managerId = "tech-lead", catalog = [], log = () => {},
  // /cso 2026-09-24 — false when the target is not MissionAlpha (repo-scripts.mjs trust). The
  // claude spawn loads `--setting-sources project`; only a worktree has had `.claude/` stripped.
  repoTrusted = true,
  // REV-8 — injectable ONLY so tests can reach the parse path; server.mjs must never pass it
  // (REV-8-WIRED), so production follows the header's governing approval line.
  strategyApproved = STRATEGY_PROMPT_APPROVED,
} = {}) {
  async function deterministic({ stage, job, ctx: extra }) {
    const facts = repoFacts(repoRoot);
    if (stage === "intake") {
      // A brief that says "ask" is how a test drives the clarify branch deterministically.
      const needs = /\bask\b/i.test(job?.brief || "") ? ["What should the default be?"] : [];
      return { ok: true, findings: facts.split("\n").slice(0, 3), needs };
    }
    if (stage === "clarify") return { ok: true, questions: job?.questions || [] };
    // Phase F · 20 — the harness has no opinion about strategy: it proceeds, and says so. A brief
    // containing the word "defer" is how a test drives the defer branch (the same convention as
    // "ask" → a question at intake).
    if (stage === "strategy") {
      const defer = /\bdefer\b/i.test(job?.brief || "");
      return { ok: true, verdict: defer ? "defer" : "proceed", why: "deterministic harness — no model consulted", costs: "", cheaper: defer ? "do nothing yet" : "", assumes: "" };
    }
    if (stage === "plan") {
      const brief = String(job?.brief || "");
      const tasks = [];
      if (/\bui\b|component|render|screen/i.test(brief)) tasks.push({ title: "UI change", skillsRequired: ["ui"], steps: [`Update the component for: ${job.title}`] });
      if (/\bapi\b|endpoint|route|lib\b/i.test(brief)) tasks.push({ title: "API change", skillsRequired: ["api"], steps: [`Update src/lib for: ${job.title}`] });
      if (/\btest|spec\b/i.test(brief)) tasks.push({ title: "Tests", skillsRequired: ["test"], steps: [`Add tests for: ${job.title}`] });
      // 10.2 / 14.1 need a deterministic HIRE, so a brief naming notifications asks for a
      // skill no seed seat holds.
      if (/notification/i.test(brief)) tasks.push({ title: "Notify", skillsRequired: ["notifications"], steps: [`Send a notification for: ${job.title}`] });
      if (!tasks.length) tasks.push({ title: "Implement the brief", skillsRequired: ["api"], steps: [String(job?.brief || "").slice(0, 500)] });
      return { ok: true, tasks };
    }
    if (stage === "manage") {
      const tasks = jobs?.tasks?.(job.id) || [];
      const blocked = tasks.filter((t) => t.status === "blocked");
      // Deterministic policy: a block is an ORDERING problem, so move the blocker last.
      if (blocked.length && tasks.length > 1) {
        const order = [...tasks.keys()].map((i) => i + 1)
          .sort((a, b) => (tasks[a - 1].status === "blocked" ? 1 : 0) - (tasks[b - 1].status === "blocked" ? 1 : 0));
        return { ok: true, action: "replan", reason: "reordered around the blocked task", order };
      }
      // A blocked task that cannot be reordered around (there is nothing to reorder) is a
      // human's problem. Returning `proceed` here would leave the job spinning in `building`
      // forever, waiting for news that has already arrived.
      if (blocked.length) {
        return { ok: true, action: "escalate", reason: "a task is blocked and there is nothing to reorder",
          question: `Task "${blocked[0].title}" is blocked: ${blocked[0].blockedOn || "no reason given"}. How should I proceed?` };
      }
      return { ok: true, action: "proceed", reason: "nothing needs the Manager" };
    }
    if (stage === "review") {
      // Judge on the RE-RUN, exactly as the live prompt asks the model to: a task whose gate
      // failed is not done. Deterministic mode must reach the same verdict a model should, or
      // the no-model loop proves a different system from the one that ships.
      const rt = extra?.tasks || [];
      const notDone = rt.filter((t) => t?.retest?.ok === false).map((t) => String(t.title));
      const done = rt.filter((t) => t?.retest?.ok !== false).map((t) => String(t.title));
      return {
        ok: true, done, notDone,
        risk: notDone.length ? "high" : "low",
        notes: notDone.length
          ? `${notDone.length} of ${rt.length} task(s) did not pass a re-run of their tests.`
          : `All ${rt.length} task(s) finished and their tests were re-run green.`,
        filesChanged: rt.reduce((n, t) => n + (t.changedPaths?.length || 0), 0),
        testsRun: rt.length,
      };
    }
    return { ok: false, error: `unknown stage: ${stage}` };
  }

  async function claude({ stage, job, ctx: extra }) {
    if (typeof spawn !== "function") return { ok: false, error: "no spawn function is wired for mode=claude" };
    // REV-8 — the prompt gate is a refusal, not a sentence: an unapproved CEO prompt never reaches a model.
    if (stage === "strategy" && !strategyApproved) {
      return { ok: false, error: "strategy: the CEO prompt is awaiting the BOSS's approval (manager-prompts.mjs header)" };
    }
    const ctx = {
      facts: repoFacts(repoRoot),
      needs: job?.questions || [],
      roster: roster?.all?.() || [],
      // The GOVERNED CATALOG, not just the staffed skills. Without it the Manager can only
      // ever ask for a skill that already has a seat, and the hire path is unreachable on a
      // live model — measured in the Phase 10 live run. Pinned by MDW-1.
      catalog,
      findings: job?.summary?.findings || [],
      answers: job?.answers || [],
      inbox: mailbox?.read?.(managerId) || [],
      tasks: jobs?.tasks?.(job.id) || [],
      // Whatever runStage computed for this stage — today, the review turn's diffs + re-runs.
      reviewTasks: extra?.tasks || [],
    };
    const prompt = promptFor(stage, job, ctx);
    if (!prompt) {
      return { ok: false, error: stage === "strategy" ? "strategy: the CEO persona (.claude/agents/ceo.md) is missing or empty" : `unknown stage: ${stage}` };
    }

    // A THROWAWAY read-only checkout, through the EXISTING worktree manager — no
    // worktree.mjs change and therefore no CORE_GUARD edit. "Read-only" is enforced by
    // --allowed-tools excluding Write/Edit and by the Bash allow-list, not by file modes.
    let cwd = repoRoot, release = () => {};
    if (worktrees?.create) {
      try {
        const wt = worktrees.create(`mgr_${job.id}`);
        cwd = wt.path;
        release = () => { try { worktrees.release?.(`mgr_${job.id}`); } catch { /* best effort */ } };
      } catch (e) { log({ event: "manager-worktree-failed", jobId: job.id, error: e?.message }); }
    }
    // `-p` skips workspace trust: in the live target the CLI would run that repo's own
    // `.claude/settings.json` hooks on the host. Untrusted + no isolated checkout ⇒ refuse.
    if (cwd === repoRoot && !repoTrusted) {
      log({ event: "manager-refused-untrusted-root", jobId: job.id, stage });
      return { ok: false, error: "the Manager will not run inside an untrusted repo without an isolated worktree" };
    }
    try {
      const text = await spawn({ prompt, tools: MANAGER_TOOLS, maxTurns: MANAGER_MAX_TURNS, cwd, stage, jobId: job.id });
      const parsed = stage === "strategy" ? parseVerdict(text) : parseFencedJson(text);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return { ok: true, ...parsed.data };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    } finally {
      release();
    }
  }

  const impl = mode === "claude" ? claude : deterministic;
  return { mode, dispatch: (args) => impl(args), parseFencedJson, repoFacts: () => repoFacts(repoRoot) };
}
