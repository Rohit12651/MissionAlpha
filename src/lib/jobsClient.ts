// Phase 12 / task 12.2 — the jobs client. Typed fetcher over the vite-proxied /runtime/jobs
// routes, plus the PURE layer JobBoard renders from (zero DOM, zero network, so it is
// unit-testable under `node --experimental-strip-types`).
//
// Token pattern is cloned verbatim from rosterClient.ts / storiesClient.ts: same same-origin
// runtime token, same x-runtime-token header, same runtimeUrl() base so it works dev-proxied
// AND packaged.
//
// THE PARSER IS DEFENSIVE, for the same reason the roster's is: this board is the operator's
// only window onto what the swarm is doing, and one malformed row must not white-screen it.
// Seven honest cards beat a blank page.
//
// AN UNKNOWN STATUS IS NEVER RE-HOMED. The runtime owns a CLOSED status set; if a job arrives
// carrying one this build does not know, it goes to `unplaced` and the board labels it as
// unknown. Bucketing it into `blocked` or `building` would put a false status in front of the
// operator, which is addendum #2 exactly: a fallback may say "unknown", never state a fact.

import { runtimeToken, runtimeUrl } from "./runtimeBase.ts";

/** MIRRORS the runtime's closed set (agent-runtime/jobs.mjs JOB_STATUSES). Order is the board's
 *  left-to-right reading order: intake → shipped, with `blocked` last as the exception lane.
 *  jobsClient.test.ts JC-6 asserts this list IS the runtime's, so a status added there and
 *  forgotten here fails at once instead of silently hiding a whole column. */
export const JOB_STATUSES = [
  "intake", "clarify", "planned", "building", "review", "awaiting-you", "shipped", "blocked",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type Tone = "amber" | "red" | "green" | "brass" | "muted";

export interface Job {
  id: string;
  title: string;
  /** The RAW status. Not narrowed to JobStatus: an unknown value must survive to be labelled. */
  status: string;
  prUrl: string | null;
  blockedOn: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface JobTask {
  id: string;
  jobId: string;
  seq: number;
  title: string;
  /** "" means UNASSIGNED. An invented seat puts a name on work nobody is doing. */
  seat: string;
  status: string;
  changedPaths: string[];
  blockedOn: string | null;
}

/** One routed message, as the drawer shows it. Bodies are agent-authored: the drawer renders
 *  them as text and never as markup. */
export interface JobMail {
  id: string;
  from: string;
  to: string;
  kind: string;
  body: string;
  at: number;
}

export interface JobGate {
  id: string;
  kind: string;
  title: string;
  status: string;
}

export interface JobColumn {
  status: JobStatus;
  label: string;
  /** `awaiting-you` — the ONE column that means the BOSS is being waited on. */
  isGate: boolean;
  jobs: Job[];
}

/** `unplaced` carries jobs whose status this build does not know. Non-enumerable on the array
 *  would be clever; a plain property is what the board and the test both read. */
export interface JobColumns extends Array<JobColumn> { unplaced?: Job[] }

const str = (v: unknown, fallback = ""): string => (typeof v === "string" && v ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
const nullableStr = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function parseJob(raw: unknown): Job | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const id = str(rec.id);
  if (!id) return null;
  return {
    id,
    title: str(rec.title, "(untitled)"),
    status: str(rec.status, "unknown"),
    prUrl: nullableStr(rec.prUrl),
    blockedOn: nullableStr(rec.blockedOn),
    createdAt: num(rec.createdAt),
    updatedAt: num(rec.updatedAt),
  };
}

/** PURE. Parse a `GET /runtime/jobs` payload. A row with no id is dropped; every other field
 *  degrades to a safe, visibly-neutral default. */
export function parseJobs(raw: unknown): Job[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const rows = (raw as { jobs?: unknown }).jobs;
  if (!Array.isArray(rows)) return [];
  const out: Job[] = [];
  for (const r of rows) {
    const j = parseJob(r);
    if (j) out.push(j);
  }
  return out;
}

/** PURE. Parse a `GET /runtime/jobs/:id` payload — the job, its tasks and its open gates. */
export function parseJobDetail(raw: unknown): { job: Job | null; tasks: JobTask[]; gates: JobGate[]; log: JobMail[] } {
  const empty = { job: null, tasks: [] as JobTask[], gates: [] as JobGate[], log: [] as JobMail[] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const rec = raw as Record<string, unknown>;
  const job = parseJob(rec.job);
  const tasks: JobTask[] = [];
  if (Array.isArray(rec.tasks)) {
    for (const t of rec.tasks) {
      if (!t || typeof t !== "object" || Array.isArray(t)) continue;
      const tr = t as Record<string, unknown>;
      const id = str(tr.id);
      if (!id) continue;
      tasks.push({
        id,
        jobId: str(tr.jobId),
        seq: num(tr.seq),
        title: str(tr.title, "(untitled task)"),
        seat: str(tr.seat, ""),
        status: str(tr.status, "unknown"),
        changedPaths: strings(tr.changedPaths),
        blockedOn: nullableStr(tr.blockedOn),
      });
    }
  }
  const gates: JobGate[] = [];
  if (Array.isArray(rec.gates)) {
    for (const g of rec.gates) {
      if (!g || typeof g !== "object" || Array.isArray(g)) continue;
      const gr = g as Record<string, unknown>;
      const id = str(gr.id);
      if (!id) continue;
      gates.push({ id, kind: str(gr.kind, "unknown"), title: str(gr.title, "(untitled)"), status: str(gr.status, "pending") });
    }
  }
  const log: JobMail[] = [];
  if (Array.isArray(rec.log)) {
    for (const m of rec.log) {
      if (!m || typeof m !== "object" || Array.isArray(m)) continue;
      const mr = m as Record<string, unknown>;
      const id = str(mr.id);
      if (!id) continue;
      log.push({
        id,
        from: str(mr.from, "?"),
        to: str(mr.to, "?"),
        kind: str(mr.kind, "message"),
        body: str(mr.body, ""),
        at: num(mr.at),
      });
    }
  }
  return { job, tasks, gates, log };
}

const LABELS: Record<JobStatus, string> = {
  intake: "Intake",
  clarify: "Clarify",
  planned: "Planned",
  building: "Building",
  review: "Review",
  "awaiting-you": "Awaiting you",
  shipped: "Shipped",
  blocked: "Blocked",
};

const KNOWN = new Set<string>(JOB_STATUSES);

/** PURE. True only for the status that means a human decision is outstanding. The amber column
 *  must mean exactly one thing, or it stops meaning anything. */
export function isGateStatus(status: string): boolean {
  return status === "awaiting-you";
}

/** PURE. Tone for a job status. An unknown status gets `muted` — it must not borrow the colour
 *  of a real outcome. */
export function statusTone(status: string): Tone {
  if (status === "awaiting-you") return "amber";
  if (status === "blocked") return "red";
  if (status === "shipped") return "green";
  if (status === "building" || status === "review") return "brass";
  return "muted";
}

/** PURE. Tone for a TASK status (the engine's vocabulary, not the job's). */
export function taskTone(status: string): Tone {
  if (status === "blocked") return "red";
  if (status === "done") return "green";
  if (status === "running" || status === "queued") return "brass";
  if (status === "held") return "amber";
  return "muted";
}

/** PURE. Bucket jobs into the board's columns, newest-first inside each. Jobs whose status this
 *  build does not know land on `unplaced` — shown, labelled, never re-homed. */
export function columns(jobs: readonly Job[]): JobColumns {
  const by = new Map<JobStatus, Job[]>();
  for (const s of JOB_STATUSES) by.set(s, []);
  const unplaced: Job[] = [];
  for (const j of jobs) {
    if (KNOWN.has(j.status)) by.get(j.status as JobStatus)?.push(j);
    else unplaced.push(j);
  }
  for (const list of by.values()) list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  unplaced.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const cols: JobColumns = JOB_STATUSES.map((status) => ({
    status,
    label: LABELS[status],
    isGate: isGateStatus(status),
    jobs: by.get(status) ?? [],
  }));
  cols.unplaced = unplaced;
  return cols;
}

// ── fetchers (rosterClient.ts token pattern) ─────────────────────────────────

/** Fetch every job. Network + auth; the pure layer above is what tests assert. */
export async function fetchJobs(): Promise<Job[]> {
  const token = await runtimeToken();
  const res = await fetch(runtimeUrl("/runtime/jobs"), {
    cache: "no-store",
    headers: { "x-runtime-token": token },
  });
  if (!res.ok) throw new Error(`jobs: HTTP ${res.status}`);
  return parseJobs(await res.json());
}

/** Fetch ONE job with its tasks and open gates. */
export async function fetchJob(id: string): Promise<{ job: Job | null; tasks: JobTask[]; gates: JobGate[]; log: JobMail[] }> {
  const token = await runtimeToken();
  const res = await fetch(runtimeUrl(`/runtime/jobs/${encodeURIComponent(id)}`), {
    cache: "no-store",
    headers: { "x-runtime-token": token },
  });
  if (!res.ok) throw new Error(`job: HTTP ${res.status}`);
  return parseJobDetail(await res.json());
}
