/* Hallmark · component: list picker · genre: technical (operator cockpit)
 * theme: BOSS locked palette (preserved — reuses the job-board rows, no new tokens)
 * states: default · hover · focus · active · disabled · loading · error · empty
 * contrast: paper/paper-dim on deck ≥ 4.5:1 (existing token pairs, unchanged)
 * pre-emit critique: P5 H4 E4 S5 R5 V4
 */
import { useCallback, useState } from "react";
import { Search } from "lucide-react";
import { createJobFromTicket, fetchTickets, type JiraTicket } from "../../lib/jiraClient";

/*
  Phase 13 / task 13.2 — pick a ticket, get a Job.

  IT DOES NOT LIST ON MOUNT. Every listing spends the operator's Jira credential on an outbound
  request to a third party, so it happens when they ask for it, with a query they typed. A
  picker that polls a board in the background is the watch (`JIRA_WATCH_JQL`), which is opt-in
  and configured once — not a side effect of opening a tab.

  A DUPLICATE IS NOT A FAILURE. `jobs.externalKey` is UNIQUE, so asking twice returns 409 with
  the job that already exists. The row says "already queued" and names it, because that is what
  the operator wanted to know — "failed" would be a lie about a ticket that is already handled.

  THE SUMMARIES ARE STRANGERS' TEXT. They render as text nodes; the runtime is what fences them
  before any of it reaches a prompt.
*/

type RowState = { status: "idle" | "adding" | "added" | "duplicate" | "failed"; note?: string };

export interface JiraPickerProps {
  /** Bumped by the board when a job.changed frame lands, so an added row can settle. */
  liveNonce?: number;
}

export function JiraPicker({ liveNonce = 0 }: JiraPickerProps) {
  const [jql, setJql] = useState("labels = mission ORDER BY created DESC");
  const [tickets, setTickets] = useState<JiraTicket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Record<string, RowState>>({});

  const search = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setTickets(await fetchTickets(jql));
    } catch (e) {
      setTickets(null);
      // The runtime's own words: "no jira account is configured — add one on the Accounts
      // page" tells the operator what to change; "could not load" tells them nothing.
      setError(e instanceof Error ? e.message : "jira unavailable");
    } finally {
      setBusy(false);
    }
  }, [jql]);

  const add = useCallback(async (key: string) => {
    setRows((r) => ({ ...r, [key]: { status: "adding" } }));
    try {
      const out = await createJobFromTicket(key);
      setRows((r) => ({
        ...r,
        [key]: out.duplicate
          ? { status: "duplicate", note: "already queued" }
          : { status: "added", note: out.id.replace(/^job_/, "") },
      }));
    } catch (e) {
      setRows((r) => ({ ...r, [key]: { status: "failed", note: e instanceof Error ? e.message : "failed" } }));
    }
  }, []);

  return (
    <section className="bos-jira-picker" aria-labelledby="jira-picker-h" data-live={liveNonce || undefined}>
      <h3 id="jira-picker-h" className="bos-job-h helm-mono">FROM JIRA</h3>

      <form
        className="bos-jira-form"
        onSubmit={(e) => { e.preventDefault(); void search(); }}
      >
        <label className="sr-only" htmlFor="jira-jql">JQL query</label>
        <input
          id="jira-jql"
          className="bos-jira-input helm-mono"
          value={jql}
          onChange={(e) => setJql(e.target.value)}
          placeholder="labels = mission ORDER BY created DESC"
          spellCheck={false}
        />
        <button type="submit" className="helm-btn" data-variant="quiet" disabled={busy || !jql.trim()}>
          <Search size={13} aria-hidden /> {busy ? "Searching…" : "Search"}
        </button>
      </form>

      {error ? (
        <p className="bos-story-note helm-mono" data-tone="red">{error}</p>
      ) : tickets === null ? (
        <p className="bos-story-note helm-mono">
          Run a JQL query to list tickets. Nothing is fetched until you ask — each search uses
          your Jira credential.
        </p>
      ) : tickets.length === 0 ? (
        <p className="bos-story-note helm-mono">No tickets matched that query.</p>
      ) : (
        <ul className="bos-job-tasks" role="list">
          {tickets.map((t) => {
            const st = rows[t.key] ?? { status: "idle" as const };
            return (
              <li key={t.key} className="bos-job-task">
                <span className="bos-job-task-seq helm-mono">{t.key}</span>
                <span className="min-w-0">
                  <span className="bos-job-task-title">{t.summary}</span>
                  {st.note && <span className="bos-job-task-meta helm-mono">{st.note}</span>}
                </span>
                {st.status === "added" || st.status === "duplicate" ? (
                  <span className="helm-chip" data-tone={st.status === "added" ? "green" : "muted"}>
                    {st.status === "added" ? "queued" : "already queued"}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="helm-btn"
                    data-variant="quiet"
                    disabled={st.status === "adding"}
                    onClick={() => void add(t.key)}
                    aria-label={`Create a job from ${t.key}`}
                  >
                    {st.status === "adding" ? "Adding…" : st.status === "failed" ? "Retry" : "Make a job"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
