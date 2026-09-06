# PES addendum — defect classes found in this repo (append-only)

MissionAlpha has no CLAUDE.md; this file is the repo's PES addendum (see
`~/Downloads/WaahyuFOLDER/WaahyuPython/CLAUDE.md` for the format and classes 1–13 found in
the Waahyu repo). Every class here shipped, passed review, and was found later. Check them
explicitly before claiming a control works.

## Phase 6 — the Manager Loop milestone (2026-09-04)

14. **A deny list is allow-by-default for everything it does not name.** `SNAPSHOT_DENY`
    named `.env`, key material and `credentials|secrets`; `.npmrc`, `.netrc`, `.envrc`
    (auth tokens, untracked, un-ignored) sailed into the snapshot and therefore the jail.
    Before trusting a deny list, enumerate the credential stores a developer machine
    actually carries and pin each as a fixture row (`worktree-snapshot-deny.test.mjs` SD-5).
    Reviewer question: "name three auth-bearing files this list does not mention."
15. **A config source the agent can write is a privilege escalation.** With
    `--setting-sources project`, `<worktree>/.claude/settings.json` becomes load-bearing;
    the seat holds Write; the 429 retry re-spawns into the same worktree. Any file the CLI
    reads for permissions or hooks is swept before EVERY spawn (`seat-settings-guard.mjs`),
    and a tampered worktree is a refusal (`HOOK_VETO`), never a retry.
16. **A cap that measures the mount measures the repo, not the work.** The jail's disk cap
    counted the whole bind-mounted repo (3.79 GiB), so no deploy could run under 1 GiB
    regardless of what it wrote. State what a limit measures before setting it; prefer
    growth over absolute size (`sandbox.mjs`, CORE_GUARD — Phase 7 item with BOSS gate).
17. **A reviewer's proposed fix is a hypothesis.** The suggested attribution fix (let a
    refused-but-agent-written path fall through) would have routed `src/secrets.yaml` INTO
    `changes`, because `applyAllowed` accepts it. The pinned test BA-5 caught it; the correct
    bucket was `refused`. Run the pinned tests before accepting any fix, including this one.
18. **The wire cannot tell "default" from "unspecified".** The enqueue route filled in the
    default tier, so every caller looked explicit and the $0 codemod tier died. A default
    applied at the edge must be recorded as a default (`requestedTier: null`), not as a choice.
19. **A test runner you kill mid-run leaves its servers behind.** `pkill -f "node --test"`
    orphans the HTTP fixtures' `server.mjs` on fixed ports; the next run's `boot()` hits
    EADDRINUSE and passes health against the wrong process (15 phantom failures). Kill the
    orphan by PID from `lsof -iTCP:<port>`; check the ports before every HTTP suite.

## Phase 7 — Roster + skill lock (2026-09-04)

20. **An ALLOW-LIST of gated routes is ungated-by-default — #14 wearing the other hat.**
    `server.mjs` decides auth with `const needsAuth = url.pathname === "/runtime/doctor" || …`.
    A route that is not named is served to anything that can reach the loopback port. Phase 7
    added `GET /runtime/roster` — which enumerates every seat and the exact globs it may write
    — and it answered with no token at all, while its immediate neighbour `/runtime/doctor`
    returned 401. The code comment claimed "same auth gate as its neighbours"; the comment was
    the only thing making it true. **Adding a route is two edits, not one**: the handler AND
    the `needsAuth` list, plus an HTTP test asserting 401 without a token
    (`roster-http.test.mjs`). Reviewer question: "name the line that gates this route."
21. **A guard that cannot tell the TOOL's own artifact from the AGENT's blocks the tool.**
    `sweepSeatSettings` refuses any `.claude/` in the worktree as settings tampering. The
    Claude CLI creates `.claude/` in its own cwd as ordinary session state, so the retry sweep
    finds it and vetoes the spawn — every engine task now ends `empty-diff`, having authored
    nothing. The control is correct about the risk (#15) and wrong about the evidence. Before
    treating an artifact's PRESENCE as hostile, name which CONTENTS are hostile
    (`settings.json`, `hooks/`) and match on those. A guard whose false-positive rate is 100%
    is an outage, not a control — and this one was never live-proven, because the phase that
    added it ran its live proof BEFORE the fix landed.
22. **A ratchet can fail to fire because the mutation was wrong, not because the test is
    vacuous — and the reverse.** Two cases in one session. `BODY-4` (path traversal) passed
    with its guard removed, because the traversal target did not exist and `readFileSync`
    threw either way: a VACUOUS test that looked proven. Separately a subagent's mutation of a
    SKILL.md prohibition did not fire because its regex was case-sensitive and the heading was
    `## NEVER TOUCH`: a SOUND test that looked vacuous. **When a mutation does not fire, prove
    which of the two you have before touching either.** For a negative assertion, arm the trap:
    make the thing the guard prevents genuinely reachable, and assert the guard is the only
    reason it did not happen.
23. **A seed that mirrors the DESIGN DOC instead of the RUNNING SYSTEM enforces nothing.**
    Phase 7's plan named the roster after the operating-model page's example crew — Manager,
    HR, Ash, Pikachu, Charizard, Bulbasaur, Squirtle. Every one was built, tested and rendered.
    None was an agent this app dispatches, so `rosterSeatFor()` never resolved, the writeScope
    control never engaged in normal use, and the board showed a second CEO above the real one.
    83 green tests and a live GET route, on top of zero production effect (addendum #1).
    **Before seeding a table that joins to the running system, print both key sets and the
    intersection.** An empty intersection is the finding.
24. **`git worktree add` checks out whatever is COMMITTED, including the config you assumed
    was excluded.** `seat-settings-guard.mjs` was written against "the snapshot never carries
    `.claude/` (SNAPSHOT_DENY)". SNAPSHOT_DENY governs the copy-sandbox snapshot; the git
    worktree path ignores it entirely, and `.claude/` is tracked here (3,081 files). Every seat
    worktree therefore arrived carrying `.claude/settings.json`, the guard refused every spawn,
    and the autonomous engine authored nothing for a day. When a guard names a file, run
    `git cat-file -e HEAD:<path>` before believing it cannot be there.

## Phase 9 — Manager loop, found by the 9.6 LIVE run (2026-09-05)

Every one of these was invisible to 2,393 green tests. They were found by pointing the
Manager at a real model for the first time, which is exactly what task 9.6 exists to do.

25. **A dependency every test INJECTS is a dependency no test proves is WIRED.**
    `manager-dispatch.mjs` takes `spawn` by injection and fails closed without it. Every unit
    test passed its own. `server.mjs` constructed `createManagerDispatch({mode, repoRoot,
    roster, jobs, mailbox, worktrees, log})` — no `spawn` — so `mode=claude` could only ever
    return `{ok:false,"no spawn function is wired for mode=claude"}` and the FIRST live job
    went straight to `blocked`. This is #1 in its purest form: the module was covered, the
    WIRING was not. **For every injected seam, assert the production call site's argument
    list, not just the module's behaviour under a test double** — and assert it on the AST,
    since `grep spawn server.mjs` matched hundreds of lines while the bug was live.
    Pinned by `manager-spawn-wiring.test.mjs` (MSW-1/MSW-2).
26. **"It moved on" is not an assertion. Name the destination.**
    `JOBHTTP-9` asserted `notEqual(job.status, "awaiting-you")` — "answering must release the
    job". Meanwhile `deliveries.decide()` fires `onDecided(row, {status, by, feedback})` and
    the job route read `info.decision ?? info.verb ?? null`, so an APPROVED answer arrived as
    `null` and the job went to **`blocked`** with `"question gate null: "`. `blocked` is not
    `awaiting-you`, so the test passed on the defect for the whole of Phase 9. A `notEqual`
    excludes ONE wrong state out of many; the states you did not name are where the bug goes.
    **Assert the state the system should be IN.** (Sibling of #22, and of #4 — the STORY path
    read `info.status` correctly all along; only the job end was wrong.)
27. **A proof run that does not boot the system the documented way proves nothing about the
    system.** The 9.6 live run reported "the engine's test gate cannot run this repo's
    TypeScript tests" — `ERR_UNKNOWN_FILE_EXTENSION` on a correct `.test.ts` the `qa` seat had
    written. Every part of that observation was real and the DIAGNOSIS was wrong. The runtime
    is booted `set -a; . ./.env; set +a; node agent-runtime/server.mjs`; `.env` pins
    `RUNTIME_SANDBOX_IMAGE=node:24-alpine` precisely because Session 16 already found and fixed
    this, and `gate-jail-languages.test.mjs` already pins it by RUNNING the real image. The
    live run was booted WITHOUT sourcing `.env`, so the module default (`node:20-alpine`) applied
    and a solved defect reappeared as a new one. Two follow-on errors came out of the same
    haste: "this repo has no quality.json" (it is at `factory/quality.json`; three wrong paths
    were checked and absence was concluded from them), and a new tag-parsing ratchet that
    duplicated existing coverage while using the exact technique that file argues against
    ("a tag is not a capability"). **Boot the way the runbook boots, and before filing a defect
    against a subsystem, grep the planning record for its name** — this one was one line away
    in STATE.md.

28. **A disposable container is only disposable if something reaps it.**
    Four `ma-sbx-task_*` sandbox containers were still running 6–14 h after the runtime that
    spawned them had exited — one spinning a full core on a hung `node --test`. They carry
    `--rm`, which removes a container when it EXITS, and nothing makes it exit when its parent
    dies. The inflated load then tripped the resource guard (`load/core 1.76` vs a 1.5 ceiling)
    and deferred every worker, so the leak presented as "the engine is idle". **Reap by label
    on boot** (`docker ps --filter label=missionalpha.sandbox=1`), the way `worktree.mjs`
    already collects orphaned checkouts.

29. **A destructive read plus a filter is a delete.** The Manager drained its inbox with
    `mailbox.read()`, which ARCHIVES every message it returns "so nothing is re-read", then
    kept only `m.jobId === job.id`. With one tick per beat round-robining several live jobs,
    the engine's `done` for job B was read by job A's tick and thrown away — delivered, then
    destroyed. Job B sat in `building` forever; its stall clock is deliberately frozen while a
    task is HELD, so it could not even time out. Single-job tests all passed (the one
    end-to-end test deliberately runs on its own server). **When a read consumes, the reader
    must handle EVERYTHING it consumed, or hand back what it did not.** Filtering after a
    destructive read is silent data loss. `MGR-MAIL-1/2/3`.
30. **A join key that the producer re-mints is not a join key.** The engine creates a NEW
    taskId for each retry (`task_c99b… → task_da44… → task_3469…`, attempts 1/2/3) while the
    job task still stores the first. Every terminal signal that followed a retry named an id
    the job store had never seen, so it matched nothing and was dropped by #29's mechanism.
    goalId was identical across all three attempts. **Join on the identifier that survives the
    retry, and check what the producer does to its ids before choosing one.** The fix needed
    all THREE ends — sender, TRANSPORT, reader — and the transport was missed on the first
    pass because `mailbox.send({from, to, kind, body, jobId, taskId})` destructures a fixed
    field list and drops anything else on the floor. Addendum #4, committed by the person
    writing this line, one hour after citing #4 for someone else's code.
31. **"Once" in a comment is not a bound.** `manager.mjs` said "re-plan ONCE (reorder/split)
    then escalate" and nothing counted. A task that could never pass — its dependency was HELD,
    so it never landed in the next seat's worktree — drove blocked → replan → build → blocked
    indefinitely: six Manager turns, 82k input + 268k cache-read tokens on one job, still
    climbing when the run was stopped. The phase's own threat model demanded exactly this
    bound ("…then `blocked` — never silent"). **A limit that is not a variable is not a limit**
    — and it must be PERSISTED, because a counter in memory resets on restart, which on a job
    that outlives a process is the same unbounded loop wearing a hat. `MAX_REPLANS`,
    `MGR-REPLAN-CAP`.

## Phase 10 — HR by Manager (2026-09-05)

32. **A capability the agent is never told about does not exist.** HR was built, unit-tested,
    HTTP-proven end to end, and wired into the heartbeat — and no live model could ever trigger
    it. `planPrompt` listed only the skills that ALREADY had a seat
    (`roster.filter(role === "worker")`), then told the model "if a task needs a skill no seat
    above has, say so — the runtime will hire". The model had never been shown an unstaffed
    skill's NAME, and `validatePlan` refuses any id outside the catalog, so the instruction was
    unfollowable. Measured twice on a real model: a brief reading "purely OUTBOUND NOTIFICATION
    PLUMBING… not API work" came back `["api"]` both times, while the catalog entry it should
    have picked is described as "how a delivery or alert reaches the operator".
    This is #1 with the agent in the loop: every layer worked, and the ONE surface that decides
    whether the feature is ever reached — the prompt — silently could not name it.
    **For any capability an agent is supposed to invoke, print what the agent is actually shown
    and find the capability's name in it.** The descriptions matter as much as the ids:
    `notifications` and `api` are told apart by what they own, not by their names.
33. **An approval gate you granted is a gate you must be willing to re-open.**
    `manager-prompts.mjs` carried `APPROVED-BY: BOSS 2026-09-05` and its own header rule: "a
    material edit re-opens this gate". Fixing #32 changed which skills the Manager may ask the
    runtime to CREATE — as material as an edit there gets — so the line went back to
    `_PENDING BOSS_` and live `claude` dispatch stopped, mid-phase, with the phase's own live
    proof unfinished. **The cost of honouring a checkpoint is always paid at the least
    convenient moment; that is what makes it a checkpoint.** A gate that only holds while it
    is cheap is decoration.
34. **Two implementations of one safety rule will drift; export the first one.**
    Phase 10 needed "is this writeScope safe?" at hire time. `roster.mjs` already had it —
    `fatalScopeProblem`, carrying CORE_GUARD, traversal, absolute-path, backslash and ReDoS
    bounds, several of them added in response to earlier defects here. Writing a second copy in
    `factory.mjs` would have started with today's rules and diverged at the first fix applied to
    only one. It was exported instead. **When a new caller needs an existing rule, the change is
    to the rule's VISIBILITY, not to its number of copies.**
35. **A seed that adds a non-dispatched id to the roster breaks what the roster means.**
    HR needed a mailbox identity, and the first attempt added an `hr` member to `roster.json`.
    `roster.test` LOAD-1 caught it: that file lists agents this app DISPATCHES, and its own
    comment says "it does not invent a second one" (addendum #23, pinned as a test). The right
    shape already existed — `roleOf` resolves the literal id `engine` to role `system` with no
    roster member — and HR now follows it. **When a runtime function needs an identity, give it
    an identity, not a seat.**

## Phase 10 — the live hire proof (2026-09-05)

36. **A roster whose seats cover the whole surface can never need a hire, and three live runs
    were spent learning that.** Briefs written to force a hire (`notifications` work under
    `src/lib/`) came back `["api"]` every time, and the model was RIGHT: the plan prompt shows
    seat coverage, and the seeded workers read `[ui] may write: src/**` and `[api, db] may
    write: src/lib/**, agent-runtime/**`. Every file those briefs named was writable by a seat
    that already existed, so declining to hire was correct reasoning, not a defect. The hire
    fired on the FIRST attempt aimed at the roster's actual gap — `docs/**`, which no worker's
    scope or skills cover. **Before testing that a system reaches for a new resource, check
    whether the resources it already has can do the job** — otherwise the test is asking the
    system to be wrong, and a pass would be the bug.
37. **A derived default is a guess, and a guess about PRIVILEGE fails silently.** The Manager
    proposed a hire's writeScope from the SKILL ID: `repo-edit` → `src/lib/repo-edit/**`. The
    task was to write `docs/alerting.md`. The hire arrived scoped to a directory that does not
    exist, was told its scope in its own SKILL body, correctly refused to write outside it, and
    failed all three attempts with `empty-diff — no diff produced`. Nothing said "wrong scope";
    the seat simply produced nothing, three times, and the job blocked. A hire that cannot do
    the job it was hired for costs a seat AND still blocks the work. The scope now derives from
    the task's STEPS (the paths the work names), with the skill guess only as a fallback, and
    a step naming `agent-runtime` is refused so a sentence in a model-authored plan cannot
    grant a new agent write access to the runtime that dispatches it.
38. **A test whose two branches produce the same value cannot see the bug between them.**
    `MGR-HIRE-6b` was written to prove `requestHire` passes `task.steps`, and it passed with the
    fix mutated out — because the fixture's step named `src/lib/notifications/send.ts` while the
    skill was `notifications`, so the work-derived scope and the skill-name fallback produced
    the IDENTICAL string. The mutation proof is what caught it. **When a test distinguishes two
    code paths, pick fixture values that make them disagree** — and never trust a ratchet that
    has not been watched failing (addendum #13, #22, now a third time).

## Phase 11 — Review + ship, found by the 11.3/11.4 LIVE chain (2026-09-05)

Six new classes. Four Phase-11 defects were RECURRENCES and are not renumbered: the missing
`changedPaths` transport is #4 a third time; the vacuous JA-3 / MR-4 / MR-8 / PJB-2 are #13 /
#22 / #38 again; reading the gate's `body` column when the value lives in `summary` is #9 (the
probe's premise was wrong, and the "defect" it reported did not exist).

39. **A loop that ran over nothing still reported success.** `ship()` skips a task with no
    changed paths — correct, since `git commit` with an empty staged set aborts anyway. But the
    skip is silent and the ship still ends `jobs.setStatus(jobId, "shipped")`. With the
    `changedPaths` transport broken (#4), EVERY task had `paths.length === 0`, so an approved job
    would have produced **zero commits, an empty branch, and a green `job-shipped` log line**.
    2,501 tests were green while this was true. **A completion status must be computed from the
    WORK, not from reaching the end of the loop** — if the loop body never ran, the terminal
    state is not success. Nothing in the ladder asserted `commits.length > 0`.

40. **A diff is evidence only when it is SCOPED to the claim.** `diffFor(taskId)` ran a bare
    `git diff` in the seat's worktree. Every seat worktree has `.claude/` stripped at creation,
    so the honest answer to "what did this seat change" came back as
    `3082 files changed, 1045955 deletions` — and the review turn's 60 KB budget then truncated
    to a wall of deletions, burying the real four-line change entirely. The environment's own
    difference from the base swamped the signal. **Diff by pathspec against the paths being
    claimed**, never the whole tree; a diff that includes what the runtime itself did to the
    checkout is not evidence about the agent.

41. **A prompt that does not say where the truth lives sends a Read-capable agent to the wrong
    source.** `reviewPrompt` handed the Manager each task's diff but never said the work is HELD
    and UNAPPLIED, and that the Manager's own checkout is the BASE COMMIT. The Manager has Read
    and Grep. Its trace: seq9 *"I'll verify the claim by reading the actual test file rather than
    trusting the diff"*, seq12 *"The file on disk does not match the diff"* — and it returned
    `notDone` for work that was correct and shipped cleanly once approved. **The model was not
    wrong to check; nothing told it that checking there could only ever produce the base.** When
    a prompt supplies evidence AND the agent holds tools that can reach a different, stale copy
    of the same fact, the prompt must say which one is authoritative and why.

42. **A fallback may not guess a LOCATION either.** Extends #2 from values to paths.
    `createJobBranch` needed the worktree root; `worktreeMgr.worktreeRoot` is a VALUE, not a
    function, so an accessor-shaped read returned `undefined` and the fallback used
    `dirname(repoRoot)`. The live run created a real git worktree at
    `~/Downloads/WaahyuFOLDER/job_<id>` — outside the repo, beside the operator's unrelated
    projects, where nobody would look for it or clean it up. It now REFUSES when there is no
    root. **A guessed filesystem destination is a fabricated fact with a side effect.**

43. **A test can pass because a LOWER layer enforced the rule, leaving your guard unproven.**
    `PJB-3` ("an existing job branch is refused") passed with our check mutated out, because
    `git worktree add -b` refuses an existing branch on its own. The outcome was right for a
    reason the test was not written to check, so the guard it claimed to pin could have been
    deleted silently. Distinct from the vacuous-ratchet class (#13/#22/#38): the assertion DID
    fire, on someone else's enforcement. **Assert OUR refusal — the reason string, the rung it
    came from — not merely that the operation failed.**

44. **Substituting the enforcement point silently drops a rung.** The 11.3 plan said the ship
    applies via `broker.applyChanges(taskId, task.changedPaths)`, whose seat is resolved by
    `seatFor(taskId)` so the WORKER's `writeScope` is re-checked. The implementation instead
    copies files inside `pr.mjs commitTask` and re-validates with a **seatless** `applyAllowed`
    — which by the LEGACY RULE performs pre-Phase-7 behaviour and does NOT consult `writeScope`.
    The control still exists (paths are seat-filtered once, upstream, in
    `broker.listChangesDetailed`), so this is not a live bypass — but the defence-in-depth rung
    the plan named is gone, and `PJB-7`'s name ("a path the broker would refuse") is broader than
    what it proves: it uses a CORE_GUARD path and never exercises `writeScope` at all.
    **When an implementation moves a check to a different function, diff the rung LIST, not just
    the outcome** — and rename any test whose title now claims more than its fixture can reach.

## Phase 12 — Ash + Board, three found by the LIVE run (2026-09-06)

45. **A persona told it holds a tool the ROAD cannot carry will narrate the call.** Ash's prompt
    names `create_job`. The first live turn resolved to the OpenAI-compatible ADAPTER — a
    recorded custom account — and `adapterReply` composes no `--mcp-config` of any kind, so Ash
    held nothing. The model did the only thing left: it wrote
    `create_job(title="Inbox relative timestamps", brief="…")` as PROSE and stopped. Zero jobs
    were created and no part of the reply said so. The tool surface is a property of the ROAD,
    not of the prompt, and the two are wired in different places — so a prompt that promises a
    tool must be paired with a check that the road can carry it. **When a capability is composed
    on one path and described on another, the description must be conditional on the path.**

46. **A fabricated tool call PERSISTS, and the next turn treats it as history.** The narrated
    call from #45 was saved to `agent-runtime/threads/ash.json` as an assistant message. The
    next turn — on the CLI road, with the tool genuinely present — read it, concluded *"Already
    submitted that job this session"*, and refused to call the tool. One hallucination became
    the premise of the following turn, and the second failure looked nothing like the first.
    **A hallucinated action does not stay in the turn that produced it.** Prevent the
    fabrication (see #45); do not rely on noticing it later, because by then it is evidence.

47. **A log sink that guards on the wrong OWNER TYPE drops every row, silently, forever.**
    `createMailbox`'s `log` sink calls `stories.appendMailLog(row.jobId, row)`, which opens with
    `if (!getStory(storyId)) return null`. A JOB is not a STORY. Every mail row belonging to a
    Job has been discarded since Phase 8 — inside `catch { /* logging must never fail a
    delivery */ }`, which is a correct catch hiding an incorrect guard. Nothing read those rows
    until 12.2 needed a thread, so nothing noticed. Sibling of #1: there the flag had no reader;
    here the writer refused every row and the refusal was swallowed. **When one table is shared
    by two owner types, every guard on it must name which type it is guarding.**

48. **A cap added to a SHARED store rewrites the arithmetic of every test that shares it.**
    12.1's create caps live in `jobs.mjs` on purpose — a rule enforced only at one caller is
    allow-by-default for every other one (#14/#20). The cost is real and was paid immediately:
    `JOBHTTP-5` pinned the detail route's exact key set and `JOBHTTP-11` created its own job,
    and both went red — one for the new `log` key, one because the file makes more than five
    jobs a minute against one server. Neither was testing what it failed on. **A new constraint
    on a shared store is a change to every fixture that touches it: expect the green tests to go
    red, and read each failure for whether it is the constraint working or the constraint wrong.**

49. **An "isolated" run is only isolated for the paths you remembered to override.** The live
    proof pinned `RUNTIME_DB_PATH`, `RUNTIME_MAIL_DIR` and `RUNTIME_TOKEN_DIR` and still wrote
    `agent-runtime/threads/ash.json` **into the repository working tree**, because
    `RUNTIME_THREADS_DIR` defaults to `join(__dir, "threads")`. That stray file is what carried
    #46 from one run into the next. **Before calling a run isolated, grep the process for every
    `process.env.*_DIR ||` default and pin them all** — an unpinned one is state that outlives
    the run and silently joins the next one.

## Phase 13 — Jira in/out, built against stubs (2026-09-06)

Four classes. Three came from MUTATION PROOFS on tests I had just written and believed; the
fourth came from checking a vendor's docs instead of my memory of them.

50. **A stub proves your CLIENT's shape. It can never prove the SERVER still exists.**
    Every test in this phase would have passed against `GET /rest/api/3/search` — an endpoint
    Atlassian deprecated in Oct 2024 and began answering **410 Gone** at the end of Oct 2025.
    The live path is `/rest/api/3/search/jql`, and it pages by an opaque `nextPageToken`, not
    `startAt`. The same check found that v3 descriptions and comment bodies are **ADF documents,
    not strings**: reading one means walking a node tree, and POSTing a bare string gets a 400.
    Two shipped-broken adapters, both invisible to a green suite, both caught by five minutes of
    reading the vendor's own changelog. **Before writing a client, verify the endpoint and the
    field types against current vendor docs — a mock will agree with whatever you assume.**

51. **A credential leaks in whatever ENCODING it is carried in.** `JIRA-5` claims the token
    reaches only the Authorization header. It was vacuous TWICE, and the same mutation — put
    `acc.auth` in a query param — passed both times: the first cut searched for the plaintext,
    but the header carries base64; the second searched for the base64 too, but
    `searchParams.set` percent-encodes `+ / =`, so the needle never matched. A leak check must
    NORMALISE before it looks: flatten the whole request, percent-decode it, and search for
    every form the secret can take. **"I checked for the secret" is not a claim about a string;
    it is a claim about every encoding of it.**

52. **A guard no caller can REACH has a test that cannot fail.** The origin check in the Jira
    client sat inside a function called only with literal paths, so removing it entirely broke
    nothing and its test passed unchanged. Distinct from #43 (where a LOWER layer enforced the
    rule): here nothing enforced it, because nothing could get to it. The fixture made it worse
    — `https://evil.example.com@site` parses with `evil.example.com` as USERINFO, so the origin
    was already correct and the test asserted a truth the guard had no part in. **Extract the
    guard so it can be called directly, or delete it. A defence that cannot be exercised is a
    comment.** (Both were kept here: `resolveJiraUrl` is now unit-proven, and the userinfo case
    is pinned separately precisely because it LOOKS like an escape and is not.)

53. **A bound that excludes its own annotation is not a bound.** `cap(s, n)` returned
    `s.slice(0, n) + "\\n[…truncated at n characters]"` — every capped field came back LONGER
    than the cap it advertised, by the length of the notice saying it had been capped. Harmless
    at 4 KB, not harmless where a cap is the thing keeping external text out of a context
    window. **Measure the value you actually return, not the part you remembered to slice.**

## Phase 14 — Hardening (2026-09-06)

54. **A TEST HARNESS that predates a control proves a system nobody runs.** The deterministic
    engine spawner — the thing whose entire job is proving the loop with no model — wrote its
    canned diff to `src/build-<seat>.txt`. Phase 7 then gave `sr-backend` a writeScope of
    `src/lib/**`. From that day the broker filtered the whole canned diff away, every scoped
    seat reported an empty diff, and the task terminal-failed. The harness stayed green because
    nothing asserted the loop reached `held`; it was proving a pre-Phase-7 system that no longer
    existed. **When a control lands, the harnesses that stand in for real actors are part of its
    call graph (#11) — grep them too.** The fix derives the path from the seat's own scope, and
    the end-to-end test now asserts every changed path is inside its seat's writeScope.

55. **Containment is a question about where a path ENDS UP, never about the characters it was
    written with.** `SPAWN-4` asserted a hostile writeScope could not traverse out of the
    worktree, by slicing the workdir prefix off and checking the remainder for `..` and a
    leading `/`. It passed with the guard removed: `join()` NORMALISES `../../etc/x` first, so
    the escape became `/etc/x`, the prefix-slice produced `c/x`, and neither needle matched. The
    only sound assertion is on the resolved absolute path: `abs.startsWith(workdir + "/")`.
    **Check the destination, not the spelling.**

56. **A contract measured under CONTENTION measures the contention.** Two suites were started
    concurrently on a box already at 3.5 load/core from four leaked containers; load reached
    **96 on 8 cores** and `JOBHTTP-8/9` failed on 30 s and 64 s timeouts. Both pass 12/12 in
    isolation. Nothing had regressed, and for several minutes the report said otherwise.
    **Run the contract SERIALLY, record the host's load beside the numbers, and re-run any
    failure in isolation before calling it a regression** — a timeout is not an assertion
    failure (#8), and the fastest way to manufacture one is to race yourself.
