// Phase 13 / task 13.3 — THE SHIP HOOK. A shipped Job tells its ticket.
//
// One comment naming what landed, then a move to Done.
//
// IT MAY NEVER BLOCK THE SHIP, and that is the whole design. By the time this runs the commits
// are on the branch and the Job is already `shipped`. A Jira outage, a revoked token, or a
// project whose workflow has no "Done" transition must leave all of that standing and record
// why the ticket did not move. Rolling back a real ship because a ticket tracker was
// unreachable would be a worse outcome than a ticket that is briefly out of date — so every
// path here returns a report, and nothing rejects.
//
// The two actions are INDEPENDENT: a refused comment does not cancel the transition, because
// "the work is done" is the more important of the two facts to get onto the ticket.

/** Kept in its own module so manager.mjs never learns what Jira is — it calls an injected hook. */
export function createJiraShipHook({ jira, log = () => {} } = {}) {
  return {
    /**
     * `job`  — the shipped Job row (needs `source` and `externalKey`).
     * `ship` — { prUrl, branch } from the ship ladder.
     */
    async onShipped(job = {}, ship = {}) {
      const out = { commented: false, transitioned: false, reason: "" };
      if (job.source !== "jira" || !job.externalKey) return { ...out, skipped: true };
      if (!jira?.configured?.()) return { ...out, reason: "no jira account is configured" };

      const key = String(job.externalKey);
      // A PR url when there is one, the branch when there is not. NEVER a constructed link:
      // a fabricated URL on a ticket is read as fact by whoever opens it next.
      const what = ship?.prUrl ? `PR: ${ship.prUrl}` : `Branch: ${String(ship?.branch ?? "(unnamed)")}`;
      const reasons = [];

      try {
        const c = await jira.comment(key, `Shipped by MissionAlpha.\n${what}`);
        if (c.ok) out.commented = true; else reasons.push(c.reason);
      } catch (e) { reasons.push(String(e?.message ?? e)); }

      try {
        const t = await jira.transition(key, "Done");
        if (t.ok) out.transitioned = true; else reasons.push(t.reason);
      } catch (e) { reasons.push(String(e?.message ?? e)); }

      out.reason = reasons.join(" · ").slice(0, 400);
      if (out.reason) log({ event: "jira-ship-partial", jobId: job.id, key, reason: out.reason });
      return out;
    },
  };
}
