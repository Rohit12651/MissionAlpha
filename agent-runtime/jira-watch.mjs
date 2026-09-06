// Phase 13 / task 13.2 — THE JIRA WATCH. A board becomes a queue of Jobs, unattended.
//
// This is the only part of Phase 13 that runs with nobody looking, so its bounds are the
// design:
//
//   • CAPPED PER TICK. A JQL that matches 500 tickets must not become 500 Jobs in one beat.
//     Ten per tick, and a capped tick REPORTS what it left — a watch that silently stops
//     short is indistinguishable from one that has caught up.
//   • IDEMPOTENCE IS THE STORE'S. `jobs.externalKey` is UNIQUE and `jobs.create` throws 409
//     on a repeat, so this module keeps no "seen" set. A second set is a second thing that
//     can disagree with the rows it describes, and it would forget everything on a restart.
//   • ONE BAD TICKET IS NOT A BAD TICK. A ticket that 404s or has been deleted is counted and
//     skipped; the rest of the batch still lands.
//   • UNCONFIGURED IS NOT BROKEN. With no Jira account this is a quiet no-op, distinguishable
//     in its own return value — otherwise the heartbeat logs an error every five minutes on
//     every install that does not use Jira.
//
// It does NOT ride the cadence system. `CADENCE_EXPRS` is daily/weekly/2xdaily/ondemand and
// worker rows are daily-capped; a five-minute poll is neither. It rides the existing heartbeat
// with its own interval, exactly as the plan specifies.

import { jiraBrief } from "./adapters/jira.mjs";

/** Ten per beat. At the default 5-minute interval that is 120/hour, which is a queue, not a flood. */
export const MAX_WATCH_PER_TICK = 10;
export const DEFAULT_JIRA_WATCH_MS = 300_000;

/**
 * createJiraWatch({ jira, jobs, jql, max, log })
 * `tick()` → { created, skipped, failed, remaining, skippedNoAccount?, reason? }
 * Never throws and never rejects: this runs on the heartbeat, where a rejected promise is a
 * dead loop rather than an error message.
 */
export function createJiraWatch({ jira, jobs, jql = "", max = MAX_WATCH_PER_TICK, log = () => {} } = {}) {
  return {
    async tick() {
      const out = { created: 0, skipped: 0, failed: 0, remaining: 0, reason: "" };
      if (!jira?.configured?.()) return { ...out, skippedNoAccount: true };
      const query = String(jql ?? "").trim();
      // No query means the operator has not chosen a board. Inventing one would import
      // whatever the account can see.
      if (!query) return { ...out, reason: "no watch jql configured" };

      const cap = Math.max(1, Math.min(MAX_WATCH_PER_TICK, Number(max) || MAX_WATCH_PER_TICK));
      const found = await jira.search(query, { max: 50 });
      if (!found.ok) return { ...out, reason: found.reason };

      const keys = found.issues.map((i) => i.key);
      for (const key of keys.slice(0, cap)) {
        const got = await jira.issue(key);
        if (!got.ok) {
          out.failed += 1;
          log({ event: "jira-watch-issue-failed", key, reason: got.reason });
          continue;
        }
        try {
          // jiraBrief is the ONLY path from ticket text into a Job, and therefore into a
          // prompt. The raw description never appears here.
          jobs.create({
            title: got.issue.summary || key,
            brief: jiraBrief(got.issue),
            source: "jira",
            externalKey: key,
          });
          out.created += 1;
        } catch (e) {
          // 409 is the UNIQUE externalKey doing its job: this ticket already has a Job.
          if (e?.status === 409) out.skipped += 1;
          else { out.failed += 1; log({ event: "jira-watch-create-failed", key, reason: String(e?.message ?? e) }); }
        }
      }
      out.remaining = Math.max(0, keys.length - cap);
      return out;
    },
  };
}
