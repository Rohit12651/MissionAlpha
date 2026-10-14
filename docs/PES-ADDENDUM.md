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

---

## Write-scope visibility (2026-09-07)

Found while answering a BOSS question about UI placement — "why is the Roster on the page at
all?" The panel was a symptom; four new classes came out of chasing it.

57. **A value can be composed, stored, and then DROPPED one layer before the screen.** The
    runtime built a precise sentence — *"the agent wrote N path(s) OUTSIDE the appliable scope:
    src/x.ts (out-of-scope for seat sr-backend)"* — persisted it as `error.msg`, and one mapper
    (`queueModel.ts:126`) kept only `error.kind` on the way to the surface the operator actually
    watches. A second layer (`queue.mjs:172`) dropped it again on the live SSE path. The control
    worked; its REPORT was severed twice, and the operator read `empty-diff` for weeks.
    This is #1's mirror image: not a control that enforces nothing, but a control that enforces
    correctly and **cannot say so**. **For every message the system composes, grep for the
    render site.** A string that is written and never displayed is not a diagnostic.

58. **An identity short-circuit must compare every field it carries.** `applyQueueEvent`
    returned the SAME state reference when `agentId`, `bucket` and `kind` matched — a deliberate
    re-render optimisation. Adding `detail` to the payload without adding it to that comparison
    would have frozen the FIRST message ever seen for that task, forever, while looking correct
    in review and in a naive test. Pinned by QM-D5, which asserts `next !== first` on a
    detail-only change. **When you widen a memoised record, widen its equality check in the same
    edit, and test the change-only case.**

59. **A retry brief that contradicts the refusal teaches the agent to repeat the failure.**
    `engine.mjs:311` enriched every `empty-diff` retry with *"prior attempt produced no diff;
    make the concrete file edit in the working directory NOW."* When the cause was an
    out-of-scope write that is FALSE — the seat did write, and the broker refused the paths — so
    the brief instructed it to do exactly what had just been rejected. Live on the Tech Lead
    station. The fix NARROWS rather than replaces, and ships with ENG-SC2 pinning that an honest
    empty diff keeps the original wording. **A generic retry hint over a specific failure is a
    lie with a loop around it. Branch the hint on the cause, and pin the unaffected branch too.**

60. **The test suite dirties a TRACKED file.** A full `npm run test:runtime` leaves
    `.claude/agents/notifications-engineer.md` modified: the hr-live test re-hires the seat and
    HR rewrites its durable record with a fresh timestamp. So `git write-tree ==
    HEAD^{tree}` is FALSE immediately after any contract run, and the repo-untouched invariant
    this project leans on reports a false negative until someone reads the diff. **A suite must
    write only into fixtures and temp dirs; assert the tree is clean AFTER the contract, not
    only before.**

### Method notes that paid off this round

* **Mutate each ratchet SEPARATELY.** QM-D4/D5 and QM-D6/D9 were each proven by their own
  mutation, producing `fail 1` rather than `fail 3` — which is what proves a ratchet is not
  redundant with its neighbour. A single mutation that reds three tests proves only that one of
  them works.
* **Put the BAD/GOOD/UNRELATED trio INSIDE the test.** RM-2 asserts that the mount counter sees
  a real `<RosterStrip`, ignores a comment and an import naming it, and does not false-positive
  on `<RosterStripHeader />`. That proof runs on every CI pass instead of living in a commit
  message (#13 asked for exactly this; it is cheap and should be the default).
* **#9 fired again, on my own probe.** "All three failures pass in isolation" was nearly claimed
  after running `job-gate.test.mjs` — but `JOBHTTP-8/9` live in `hr-live-http.test.mjs` and
  `manager-dispatch-http.test.mjs`. The green run did not contain the tests it was meant to
  clear. **Confirm the file you ran actually holds the test you are clearing.**
* **#56 recurred, unprovoked.** Host load reached 199 (a VM at 98% CPU) mid-contract; three
  timing tests that pass at 601–11426 ms clean took 6.7–47 s and failed. Baseline timings from
  the same day made the attribution provable in minutes instead of hours. **Keep the clean
  run's output file — it is the control group.**

## Phase B — Recovery (2026-09-17)

Three classes, all found at the Phase B exit gate rather than during the work.

61. **A refactor that MOVES code silently un-pins every ratchet aimed at its old address.**
    Step 1 lifted the mail MCP env out of `server.mjs:2137` into a pure `mailEnvFor()` in
    `mail-env.mjs`. `SEAT-12` hunts the `server.mjs` AST for an `ObjectExpression` carrying
    `MA_MAIL_AGENT_ID`; after the lift there is none, so `envNode` was `null` and the test
    failed — but the claim it protects (identity bound, scopes not leaked) was never in
    danger, because `mail-env.mjs` still built exactly the right env and `MAILENV-1..3`
    proved it behaviourally. The ratchet was not wrong about the code; it was pointed at an
    address the code had left. **When you extract code, grep the test tree for the OLD
    location before you finish the extraction** — a ratchet reading an AST names its target
    by path, and no type checker or linter will tell you the path went stale. The repair is
    not to delete the ratchet: SEAT-12 now pins BOTH halves, the call site
    (`env: mailEnvFor(...)` must exist in `server.mjs`) and the shape (on `mail-env.mjs`'s
    own AST), so the next move breaks it loudly instead of quietly un-pinning the claim.

62. **A gate that ran a SUBSET is not the gate, and it reports the same word.** Phase A and
    Phase B both recorded "runtime regression green" from a partial invocation. The full
    `npm run test:runtime` — all 204 files — had `SEAT-12` red the whole time, from the Step 1
    extraction onward. Two phase exits passed over it. This is #9 ("check the probe's premise")
    at the level of the CONTRACT rather than a single probe: the number in a delivery report is
    a claim about a command, and a subset silently answers a different question than the one
    the gate asked. **The number, once the full suite finally ran: 2647 tests.** Both phase exits
    had recorded "329/329" — one EIGHTH of the suite — and read it as the whole contract. **Record the exact command with the count, and make the phase-exit run the
    whole suite even when the last one was minutes ago.**

    Sub-lesson, cheap and expensive: `npm run test:runtime | tail -20` throws away everything
    but the end of the run. The first full run showed exactly one `✖` and no summary counts —
    the summary counts were not missing, they had scrolled past `tail`, and any earlier failure
    would have scrolled with them. **Redirect a gate's output to a file; never pipe a gate
    through `tail` or `head`.**

63. **A mutation anchored on an indented line can match a DEEPER-indented twin.** Proving the
    three question-gate fixes, the anchor for the blocked-with-no-replan site
    (`        jobs.setQuestions(job.id, [q]); // …`, 8 spaces) is a strict substring of the
    escalate site's identical line at 10 spaces. The patcher's `count(old) == 1` assertion
    refused it. Without that assertion the mutation would have landed on the escalate site —
    already proven by an earlier mutation — and the blocked-site test would have gone red for
    the wrong reason, reading as proof. This is #13 with a new mechanism: not quoting style or
    whitespace normalisation, but **one indent level being a substring of another**. **Every
    mutation asserts its target is unique, and anchors on a neighbouring distinct line when it
    is not.**

### Method notes

* **#11 fired again, and the reviewer caught it, not the author.** `setQuestions()` was fixed
  at the intake path and called done; three other sites mint the same `kind:"question"` gate
  and none of them touched `jobs.questions`. The fix site was where the bug was REPORTED. The
  enumeration that would have caught it is one grep: `mintGate({ kind: "question"`.
* **A behavioural test beats an AST ratchet at the same claim.** `MAILENV-3` (roles only, no
  scope leak) survived the extraction untouched because it calls the function; `SEAT-12`'s AST
  version broke because it reads an address. Prefer the call when the claim can be made by
  calling.

64. **A test that loads REAL seed data while hardcoding the validator's input is a cache that
    fails closed — at IMPORT, as `pass 0`.** `guards-writescope`, `glob-redos` and
    `roster.test` each opened the live `agent-runtime/roster.json` but passed
    `validSkills: new Set(["repo-read", "research-brief", "ui", "api", "db", "test",
    "notifications"])` — a 7-id copy of a catalog that lives in `factory.mjs` and had grown to
    15. Adding the `ceo` seat (skill `strategy-gate`) made the copy stale, `parseRoster` threw
    inside module scope, and all three files died before a single test ran. The reporter says
    `✖ <file>` and `pass 0` — NOT `fail 1` — so the damage looks like one failure and is
    actually an entire file of coverage silently gone. Production was never affected:
    `server.mjs:2371` derives the same set from `factory.SKILL_CATALOG`. **When a test feeds a
    validator, derive the validator's input the way production derives it; a hardcoded copy of
    a governed list two files away buys nothing and goes stale the first time the list grows.**
    Fixed by replacing all three copies with `new Set(SKILL_CATALOG.map((sk) => sk.id))`, and
    mutation-proven: a bogus skill id in `roster.json` still reds 11 tests, so widening the set
    did not disable the check.

    Second-order lesson, and the reason this sat unseen: it was introduced by the CEO-agent
    work EARLIER IN THE SAME SESSION, in a file (`roster.json`) that no gate in that task's
    scope re-ran. `strategy-gate` was correctly added to `factory.mjs`'s catalog — the place the
    task was thinking about — and the three test-side copies were never enumerated. #11 with the
    duplicate living in TEST code, where "fix where the class lives" is easy to forget because
    tests do not feel like call sites. **`grep -rl` the literal you are adding, tests included.**

65. **A `skipped` count can hide SECURITY coverage that an unrelated action switched off.**
    The clean runtime run reported `pass 2636 · fail 0 · skipped 11` and was recorded as the
    gate. Eleven is a small number next to 2636 and reads like housekeeping. It was not: all
    eleven are Docker-gated, and they are the sandbox containment suite — *host filesystem is
    NOT reachable*, *rootfs is read-only*, *network egress is BLOCKED by default*, *runs as
    non-root (uid 65534)*, *the docker socket is NOT present inside the container*, *kill-switch
    terminates a runaway*, plus the three `WIRED-1`/`VETO-LIVE-1`/`VETO-LIVE-2` quality-gate
    tests. They skipped because **I had killed the Docker VM twenty minutes earlier** to quiet
    the host for Playwright. The suite said so in plain text — `# Docker daemon unreachable —
    the jailed quality gate cannot be exercised here` — and the summary line reduced it to the
    word "skipped".

    Two rules. **Read what skipped, never just how many.** A skip is a test that did not run;
    whether that matters depends entirely on which one. And: **an action taken to make a gate
    pass can silently weaken a different gate.** Killing the VM fixed the timing flakes
    (`JOBHTTP-9` 155.9 s → 8.9 s) and disabled the containment suite in the same stroke. The
    honest sequence is restore the dependency, re-run the skipped tests, and record THAT number
    — not to quietly keep the green one.

    Corollary on identification: the VM was killed as an "orphan" because `ps` showed its parent
    as PID 1. macOS reparents XPC children to launchd, so `PPID == 1` is the NORMAL state for a
    Virtualization.framework VM, not evidence of abandonment. It was Docker Desktop's VM, and
    the sibling `com.docker.virtualization` process named its owner plainly. **Identify a
    process by its siblings and its binary path, never by its parent pid.**

66. **A dependency stored as a POSITION dies at the first reorder, and validates on the way.**
    Phase D's `dependsOn` arrives from the planner as 1-based task numbers, which is the only
    shape a model can reliably produce. `job_tasks` rows are then REORDERED by a re-plan
    (`manager.mjs` maps `out.order` onto the existing rows and hands them back to `setTasks`,
    which re-mints every id). Storing the number would silently repoint every edge at whatever
    task landed in that position — a graph that still passes every validation and means
    something else. The store resolves numbers to row ids at write time, and accepts the ids a
    re-plan carries back, so an edge survives the one operation in the runtime that renumbers
    tasks.

    **Rule:** an identifier that indexes a mutable ORDER is not an identifier. Resolve it to a
    stable one at the boundary where the order is still known, and pin it with a test that
    actually performs the reorder — asserting the first write is not the claim.

67. **A gate that greps the WHOLE FILE cannot fail when the file keeps its own history.**
    `MP-GATE` asserted that `manager-prompts.mjs` matched `APPROVED-BY: BOSS <date>`. That file
    deliberately retains every prior approval in its header as a record, so a granted line from
    2026-09-05 satisfied the test while the GOVERNING line at the top read `_PENDING BOSS_`.
    Green for three phases, and cited as evidence twice, on a control surface whose entire
    purpose is to stop a live run.

    This is #5 (a ratchet must be proven to fire) applied to a gate nobody thought of as a
    ratchet, and #13's mutation step is what would have caught it in one command.

    **Rule:** when a file carries both a CURRENT value and its own history, a check that
    searches the file is checking the history too. Anchor on the governing occurrence — the
    first line, a named marker, a parsed field — and ship a synthetic BAD/GOOD pair inside the
    test so the anchoring itself is asserted on every run.

68. **"Unknown" must resolve to the REFUSING answer, not the convenient one.**
    Ready-set dispatch runs two seats at once only when their enforced `writeScope`s are
    disjoint. Three things can make that unreadable: a seat the roster does not hold, a seat
    with no declared scope, and — the one that is easy to miss — a seat whose role is not
    `worker`, because `applyAllowed` narrows ONLY workers and every other role keeps the full
    allow-set. A `station` seat carrying a `writeScope` field is not bounded by it, so reading
    that field as a bound would hand two unbounded seats the same tree.

    Each of those returns "collide", which degrades to the previous phase's sequential
    behaviour. The property worth stating: an install that migrates and changes nothing else
    behaves exactly as it did, and parallelism is granted only where the runtime can PROVE it
    safe.

    **Rule:** when a new optimisation keys off a value read from configuration, enumerate every
    way that read can come back uninformative and make each one take the old, slow, safe path.
    A default that means "go ahead, I found no reason to refuse" is how an optimisation becomes
    a data-loss bug — and check the ROLE-gated case specifically, because a field that exists
    on a record is not the same as a field that is enforced for it (#1).

69. **A condition the spec named can still be UNREACHABLE, and only the mutation tells you.**
    The ready-set spec named three conditions for dispatching a task: predecessors done, seat
    free, scope disjoint. All three were implemented, all the tests were green, and the review
    read fine. Then the mutation that DELETED the seat-free branch reddened nothing — in any
    test, anywhere. The branch could not be reached: a seat's `writeScope` is the same array
    whichever of its tasks you ask about, and the disjointness predicate is reflexively false,
    so the scope check already refused a seat its own second task.

    This is the inverse of #13. There, a ratchet looked correct and could not FAIL. Here, a
    guard looked correct and could not RUN. Both are invisible in review and both are one
    command away from being obvious.

    **Rule:** mutate every branch you add, including the ones a spec or a plan told you to
    write — a design document is a hypothesis about what the code will need, not evidence that
    the code needs it. A branch whose deletion reddens nothing is either untested or
    unreachable; find out which before shipping it. If it is subsumed by a neighbouring check,
    DELETE it and pin the subsumption in a test, so the day the neighbour's property changes a
    test says so instead of a silent gap opening.

70. **A guard that DISARMS ITSELF on its own success.**
    `ship()` refuses when the tree the BOSS approved disagrees with the branch's current tree.
    It works — live run 6 executed the comparison and passed it. Then the same function's final
    `setSummary` rebuilt the `ship` object from scratch instead of spreading the existing one,
    erasing `tree` and `worktree` from the record. The first ship is therefore guarded and
    every subsequent one is not: a resume, a retry or a second operator approval reads
    `known.tree` as `undefined`, skips the comparison, and the branch-moved refusal silently
    stops existing.

    Two things made it invisible. The guard's own test shipped once and asserted the refusal
    fired — nothing asserted the STATE AFTER a successful ship. And the summary is written by
    four different call sites, three of which spread correctly, so the diff of the fourth read
    like its neighbours.

    **Rule:** when a control reads persisted state written by an earlier stage, test the
    SECOND invocation, not only the first. And any write to a shared state object is a MERGE
    (`{...existing, ...changes}`) unless you can name the field you intend to erase — a fresh
    object literal in a multi-writer record is a silent delete of everything the other writers
    put there. Grep the other writers of the same key before writing the one in front of you.

71. **An isolated run isolates the CREDENTIAL too, and it fails as a capability error.**
    Live run 6's first attempt failed both tasks with `kind: "not-capable"`, reason `no account
    is active`. The account record lives in `accounts.json` inside `RUNTIME_TOKEN_DIR`, which
    the isolation set overrides — so a harness that correctly protects the operator's repo also
    silently removes the operator's account. And the record is encrypted with a `cred.key` in
    the same directory, so copying the account without the key yields a record nothing can
    open.

    It reads as a product defect ("the engine says it is not capable") when it is a harness
    fact, which is #9 — check the probe's premise — applied to a whole run rather than a test.

    **Rule:** an isolation set has TWO halves that pull in opposite directions: state that must
    be fresh (repos, worktrees, databases) and state that must be carried (credentials, keys,
    personas, the `.env` values the app reads at boot). Enumerate both before a live run, and
    verify the carried half at the health endpoint — `activeAccount: null` was visible in the
    very first health response, minutes before the first task failed.

72. **A copy re-stamped at delivery time reorders the conversation it copies.**
    The mailbox CC's `question` to the Manager so it can resume the asker. The copy was given a
    FRESH ulid when `route()` ran; the seat's own `blocked`, addressed to the Manager directly,
    kept its send-time id. The inbox is read in id order. Live run 7: question sent at +130.8 s,
    blocked at +134.0 s, question's copy stamped +181.6 s — so the Manager read the block BEFORE
    the question that explained it, filed a plain `blocked`, and replanned a task that was only
    waiting for an answer. Every unit test fed the Manager a hand-built array in the right order,
    so none could see it; only a real mailbox under a real heartbeat could.

    **Rule:** when a system orders by a timestamp-bearing id, a derived record must inherit its
    source's position, never mint a new one at the moment it is derived. Test ordering through
    the REAL store (MAIL-CC-ORDER-1), with a deliberate gap between send and route — an array a
    test builds is already in the order the author imagined.

73. **A message to an agent with no turn left is a message to nobody.**
    Seats get one model turn per task. Phase D's first design let a seat ask a peer and wait,
    and live run 8 showed the flaw in one line of timing: the backend finished its turn at +0 s,
    the frontend asked at +44.5 s, and the question sat addressed to a seat nothing would ever
    run again. The frontend waited correctly — `awaiting-answer`, not blocked — for thirty
    minutes of stall clock. Waiting was right; waiting for something that could not happen was
    the bug. The runtime now GIVES the answerer a turn (`replyOnly`) when it is asked and has
    none of its own, and checks again when its own task finishes, which closes the race where
    a seat's final `mail_read` runs a moment before the question lands.

    **Rule:** in any system of turn-bound agents, every "wait for X" needs a named mechanism that
    makes X happen, and that mechanism must cover the case where X's owner has already left. A
    mailbox is not a conversation if only one side is ever scheduled.

74. **The harness that proves the code is held to the same rules as the code.**
    Four times this phase my own verification tooling broke a rule this file already states.
    (1) The mutation harness piped `node --test` into `grep` (#24): every leg, including the
    restore check, printed nothing, which read as "no failures". (2) TICK-1's first draft
    HUNG on red instead of failing (#8): without the lease the second tick awaited the same
    hanging stage, so the red state was a deadlock. (3) Two mutation runs were about to share
    one `pristine.tmp`; run concurrently, a restore could have written the other file's
    contents back. (4) A `pkill -f server.mjs` identified processes by pattern (#65).

    **Rule:** a verification tool gets the same review as production code — it decides what you
    believe. Specifically: capture to a file, bound every await in a test that is meant to go
    red, give concurrent runs private scratch, and kill by recorded PID.

75. **"Not applicable" and "unknown" are different answers; a write path may not merge them.**
    `applyAllowed(p, { seat: undefined })` returned the legacy allow-set: every seed path. That
    is correct for patch-edit and policy, which never HAD a seat to give. It was wrong on the
    engine broker and the ship ladder, where no seat means the task's seat could not be
    RESOLVED — an agentId off the roster, a swept queue record — so the writeScope narrowing
    never ran and the task inherited the whole tree. One `undefined` stood for both "this caller
    does not narrow" and "I could not tell who wrote this". Phase E · 16 split them: `strict`
    callers (engine, ship) refuse the unresolved case; the census test GUARD-2 pins which callers
    are allowed to stay legacy, by file.

    **Rule:** when a guard's input can be missing, ask WHY it is missing at each call site. If
    the answer is "we failed to look it up", that caller must fail closed, and the guard needs a
    way to be told so.

76. **A name is not a definition — check which one this file uses.**
    Two findings in one task. (1) `factory.mjs` runs `bash <REPO_ROOT>/scripts/agent-heartbeat.sh`,
    which read as the same foreign-script hole as server.mjs. It is not: factory declares its OWN
    `REPO_ROOT = resolve(__dir, "..")`, always the runtime's repo, while guards.mjs's `REPO_ROOT`
    follows RUNTIME_REPO_ROOT. Same name, different meaning. (2) `pr-job-branch.test.mjs`'s
    scaffold passes `allowed: (p) => …` to `createPr`, which reads `deps.applyAllowed`. The
    injection is silently ignored and every test in that file runs the REAL predicate — the
    fixture believes it narrows, and never has (left as is; disclosed, not in scope).

    **Rule:** before calling a site vulnerable, or a fixture effective, open the definition the
    site actually resolves — not the one with the same name you read earlier. An options bag
    that ignores unknown keys turns a typo into a vacuous test.

77. **A model that declines is not a boundary that refuses.**
    The first live JAIL-1 probe asked a worker to `echo pwned > ~/…` with and without the sandbox.
    Both runs ended with no file — and both because the MODEL declined ("suspicious filename"),
    not because anything stopped it. Read naively, the jailed run "passed". The control is what
    exposed it: a control that cannot produce the bad outcome makes the treatment's clean result
    meaningless. The second probe put the write inside `./build.sh` (ordinary work a worker runs
    without a second thought): control → file written; jailed →
    `./build.sh: line 3: …: Operation not permitted`, no file.

    **Rule:** when proving an enforcement boundary live, the control run must SHOW the bad outcome
    first. If the agent refuses on its own, the probe measured the agent's manners, not the fence.

78. **A decision must check it is still the decision's turn.**
    `onGateDecided("approve")` moved a job to `planned` from whatever status it was in, and
    `/answer` called it whenever no gate was open. That was harmless while every status that
    could reach `planned` was one the BOSS had already passed. Phase F added `strategy`, and
    `strategy → planned` is store-legal — so an answer posted while the CEO was still deciding
    skipped the CEO. Nothing about the gate was wrong; the handler never asked whether the job
    was WAITING for it. Found by the independent review, not by any test I had written.

    **Rule:** every approve/decide/answer handler checks that the object is in the state that
    asked for the decision, and refuses (409) otherwise. A transition table says what moves
    are legal; it does not say whose turn it is. And a note that a prompt "must not run live
    until approved" is addendum #1 again — the approval is now a flag the dispatcher enforces,
    and REV-8 fails if the flag and the header disagree.

79. **Consent is a token, not a word search.**
    The first `deferAnswer` looked for yes-words and no-words anywhere in the BOSS's answer. It
    passed its own tests and an independent reviewer still made it say YES to
    "I don’t want to go ahead" (a typographic apostrophe `’` slipped past `don'?t`) and to
    "ok, hold off until Q3" (`ok` matched). Natural language cannot be word-matched into a
    decision that stops or ships work.

    **Rule:** when an answer decides an irreversible branch, accept ONE whole token from a closed
    set (after NFKC and quote normalisation) and refuse everything else as "ask again". A wrong
    guess costs the job; a re-ask costs one message.

80. **A hardening flag can break the command it hardens — and a probe that stops early proves nothing.**
    Two findings on git in one task. (1) `GIT_SAFE_ARGS` carries `-c diff.external=` (empty) to
    stop a repo from naming an external diff program. For a CONTENT diff, git then tries to run
    the program `""` and dies — invisible for years because every hardened diff in the runtime was
    `--name-only`. Adding the same args to the review diff broke it at once (DIFF-1/2); the fix is
    `--no-ext-diff`, which disables drivers outright. (2) The probe for "does `gh pr create` run
    git in the worktree?" stopped at a 401 before reaching any git call, so it could not answer
    the question. The class was closed by mechanism instead — the runner's environment carries the
    hardening, proven with a planted fsmonitor that a plain `git status` DOES fire (PR-GITENV-0).

    **Rule:** test a hardened command's OUTPUT, not just that it ran; and when a probe cannot
    reach the code path in question, say "unverified" and close the class with a mechanism whose
    premise you have watched fire.

81. **An allowlist of "dangerous files" is never finished — invert it where the process loads the code.**
    CORE_GUARD grew from 14 rows to 61 across three security passes, and each pass found more
    control files missing: the last census still left 66 runtime modules appliable by an agent.
    The list could not converge, because the question it answered ("is this module control?") has
    one honest answer for code the runtime process imports: yes — any module that runs in-process
    can patch what the others enforce. Decision #1 (2026-09-27) inverted it: under
    `agent-runtime/`, only the two test dirs are appliable (RUNTIME_FLOOR); everything else,
    including files that do not exist yet, is refused (RTF-1 runs the whole tree, RTF-2 new paths).
    An exemption is only as safe as its premises, so both are pinned and watched fire: the runtime
    never imports from a test dir (RTF-4, mutation M2 red) and a symlink cannot carry a write out
    of one (RTF-7). And one more vacuous test, caught by its mutation: the first "deleting a
    runtime module is refused" test used the job-ship `commitTask`, which copies file bodies and so
    refuses a deletion of ANY path as "unreadable" — green with the floor removed. It now runs on
    the P5 ladder (`git add -- path` stages deletions) with a premise arm that watches the
    deletion land when the gate allows it (RTF-6b/6c).

    **Rule:** when every review adds rows to a deny list, stop adding rows. Deny the directory,
    allow the named exception, and pin the premises that make the exception safe.

82. **A process that starts children owns their death — and a test that boots the product owns its state.**
    `kill <runtime pid>` exited the server and left the `claude -p` seat it had dispatched running as
    an orphan (PPID 1), still spending: no signal handler, and the children shared the server's
    process group, so nothing reached them. Fixed by spawning every CLI child detached through one
    registry and killing each group on SIGTERM/SIGINT, exiting synchronously so no child handler
    records the kill as a failed attempt (SHUT-1…4; an AST census keeps new spawn sites honest).
    Detaching moved a seat's subprocesses into the SEAT's group, which exposed the same class in
    the four per-task kills — each signalled only the CLI — so they now kill the group (SHUT-5/6).
    The live proof then exposed the second half: 12 server-booting tests isolate the DB but not
    `engine-store/`, so a test's seeded cadence planted a task in the LIVE queue and the real runtime
    ran it as a real model turn.

    **Rule:** every spawn site registers its child with whatever handles shutdown, pinned by a census
    of spawn calls, not a list of the ones you know. And a test that boots the product must override
    EVERY durable root it reads — enumerate them from the code, not from the test you copied.
