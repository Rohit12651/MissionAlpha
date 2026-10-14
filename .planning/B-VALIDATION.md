# Phase B — Recovery (steps 3–6): validation coverage audit

Written 2026-09-17 at the Phase B exit, per `/gsd-validate-phase`. Reconstructed from
artifacts — this repo keeps phase records in `.planning/STATE.md` and the plan document,
not in a GSD `.planning/<phase>/` tree, so there was no prior VALIDATION.md (state B).

Method: every CLAIM the phase makes is listed, then the test that would go RED if the claim
stopped being true. A claim with no such test is MISSING, not "covered by the suite".
Every id below was confirmed to exist in the tree by name before it was written here — the
first pass of that check reported `MBX-ROUTE-3 *** NOT FOUND ***` because the probe required
a colon the title does not have (addendum #9: check the probe's premise before believing it).

| # | Claim | Proof | Verdict |
|---|-------|-------|---------|
| B1 | A message whose `from` disagrees with the sending seat is unlinked, not delivered, and logged `mail-forged` | MBX-ROUTE-1..4 (`mailbox.test.mjs`) | COVERED |
| B2 | A message with no id is refused `mail-invalid` on the route path | MBX-ROUTE-4 + `envelopeError(..., {requireId:true})` | COVERED |
| B3 | Reading an inbox over HTTP does not consume it | MAILHTTP-4 (`mailbox-http.test.mjs`, rewritten to glance semantics) | COVERED |
| B4 | `POST /runtime/mail` is approver-only | MBX-HTTP-1 / MBX-HTTP-2 (`auth-http.test.mjs`, inside the active-auth window) | COVERED |
| B5 | Forged and invalid events reach the audit log, carrying the jobId | STORIES-MAILLOG-1 (`stories.test.mjs`) | COVERED |
| B6 | A worker's own `done` claim cannot close a task — only the engine's | MGR-DONE-ID-1 (`manager.test.mjs`) | COVERED |
| B7 | A task closes carrying the taskId the engine named | MGR-DONE-ID-1 | COVERED |
| B8 | A ship whose commit rung fails blocks the job with the reason | SHIP-1 (`manager-ship.test.mjs`) | COVERED |
| B9 | A ship that produces zero commits is refused | SHIP-2 | COVERED |
| B10 | The outcome is recorded as pr / pushed / local-branch | SHIP-3, SHIP-4 (GOOD leg) | COVERED |
| B11 | The chip's tone and label follow the outcome | JOBS-OUTCOME-1 / -2 (`jobsClient.test.ts`) | COVERED |
| B12 | The chip actually RENDERS on the shipped card | `jobs-shipped-card-{light,dark}` locator screenshot + `toHaveText("PR")` + `toBeInViewport` | COVERED (see L1) |
| B13 | A new question round clears the previous answers | ANS-2 (`jobs.test.mjs`) | COVERED |
| B14 | EVERY site that mints a `kind:"question"` gate opens an answerable round | MGR-ANS-ROUND-1 (escalate), -2 (hire-failed), -3 (blocked-no-replan) | COVERED |
| B15 | A stranded `awaiting-you` with no gate is reconciled to `blocked` at boot | MGR-RECOVER-1 | COVERED |
| B16 | A blocked job can be resumed and re-plans | MGR-RESUME-1 | COVERED |
| B17 | Resume refuses while a task is still live in the engine | MGR-RESUME-2 | PARTIAL (see G1) |
| B18 | The resume route is approver-gated | RESUME-HTTP-1 (`auth-http.test.mjs`) | COVERED |
| B19 | The ship stage is persisted before each rung; a failed branch rung blocks | SHIP-5, SHIP-6 | COVERED |
| B20 | A rung that THROWS blocks by reason rather than rejecting into a decided gate | SHIP-7 | COVERED |
| B21 | The Resume button is on screen for a blocked job | `jobs-blocked-detail-head-{light,dark}` locator screenshot | COVERED (see L1) |
| B22 | The mail MCP env binds an unforgeable identity and leaks no writeScope | MAILENV-1..3 (behavioural) + SEAT-12 (wiring + shape, re-pointed) | COVERED |

Every row above except B12/B21 is mutation-proven: the fix was removed, the named test went
red, the file was restored and md5-checked. B12/B21 are pixel baselines — their proof is the
regeneration diff, not a mutation.

## Gaps found by this audit

**G1 — B17 is PARTIAL, and the partiality is load-bearing.** `resume()` refuses only when a
task is `queued`. A task in `building` is already dispatched into the engine; resuming then
still re-plans over live work and orphans the goal. The honest fix is goal cancellation,
which is not in Phase B. Carried as ROADMAP **C18**.

**L1 — the light and dark baselines are the SAME IMAGE.** Verified by md5, not by eye:

    jobs-shipped-card-light-darwin.png       16cb7fac3000ad5312a1013495c15e6f
    jobs-shipped-card-dark-darwin.png        16cb7fac3000ad5312a1013495c15e6f
    jobs-blocked-detail-head-light-darwin.png 079e403faaab7eb169b3609dccafbde5
    jobs-blocked-detail-head-dark-darwin.png  079e403faaab7eb169b3609dccafbde5

The Helm skin (`data-skin="helm"`) paints dark regardless of `data-theme`, so the theme loop
produces four files carrying two distinct images. The dark assertions add **zero** coverage
over the light ones — they are not wrong, they are redundant, and a reader counting "4 new
baselines" is counting twice. This is addendum #18's shape (a parametrised case that tests
the author's model rather than the code): the parameter is inert and the suite cannot say so.
Carried as ROADMAP **C20**; the cheap fix is one assertion that the two themes DIVERGE for a
surface where they should, so the day the skin gains a light mode the redundancy self-reports.

**G2 — three duplicate test names in `mailbox.test.mjs`** (`MAIL-RULE-4`, `MAIL-RULE-7`,
`MAIL-SEND-7` each appear twice). Pre-existing, not introduced by Phase B. `node --test`
permits duplicates, which makes `--test-name-pattern` ambiguous for those ids — the exact
tool used to "verify a single test in isolation". Not fixed here (untouched-code rule).
