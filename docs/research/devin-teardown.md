# Devin (devin.ai / Cognition AI): Full Teardown

**As of:** 2026-10-12
**Method:**
- Read devin.ai live in a browser: home, /cloud, /pricing, /security, /customers, and the full blog index back to 2024.
- Read ~40 docs.devin.ai pages and the 2025 and 2026 release notes.
- Ran web research on the company, funding, independent evaluations and Cognition's engineering posts.

**Evidence tags:**

| Tag | Meaning |
|---|---|
| **[P]** | Primary source: Cognition, Devin, or a partner page I or an agent read directly |
| **[M]** | Major outlet (Bloomberg, Fortune and similar) |
| **[S]** | Secondary or aggregator source |
| **[U]** | Unverified |
| **[C]** | Sources conflict |

---

## 0. Executive summary

1. **Devin is no longer one cloud bot.** It is a single agent sold across four surfaces:
   - **Devin Cloud**: autonomous agents, each in its own VM.
   - **Devin Desktop**: Windsurf, renamed on Jun 2, 2026. It is an IDE plus an "Agent Command Center".
   - **Devin CLI**: Devin in the terminal.
   - **Devin Review**: AI review on every PR.

   Around these sit Automations, Security Swarm, Code Scans, DeepWiki and Ask Devin. **[P]**
2. **Core mechanism:**
   - A stateless "Brain" (agent loop, inference, planning) runs in Cognition's cloud.
   - It drives a "Devbox" VM that boots from your org's prebuilt **snapshot**, with repos cloned and dependencies installed.
   - The agent plans, edits code, runs a shell, tests in its own browser or desktop, opens a PR and watches CI.
   - Devin Review (a separate reviewer with a clean context) checks the diff, and Auto-Fix responds to review findings and CI failures.
   - Skills, Playbooks and Memory carry learning into later sessions. **[P]**
3. **Model strategy: a router that does not depend on one model provider.**
   - Devin routes across Anthropic, OpenAI, Google, xAI and open-weight models, plus Cognition's own SWE-2, which is post-trained from Moonshot's Kimi K3 **[S]**.
   - "Fusion" pairs a lead model with a cheaper "sidekick" model.
   - The company sells this independence as its edge over the model labs. **[P]**
4. **Business:**
   - Valued at $48B (Series E, Sep 8, 2026, more than $2B raised) **[P]**.
   - "Almost $900M" run-rate revenue **[P, unaudited]**.
   - About $800M planned burn in 2026 and about 50% enterprise gross margin **[S, The Information via secondary]**.
   - About 53x revenue multiple.
5. **Evidence quality:**
   - The 2024 launch claims were overstated: the benchmark ran on a SWE-bench subset, and the Upwork demo was publicly debunked.
   - Answer.AI's January 2025 test succeeded on 3 of 20 tasks.
   - In 2025–26 the product got much better at **scoped, verifiable work**: migrations, upgrades, CVE fixes, tests, small tickets.
   - Third-party trackers put the PR merge rate at roughly 54–64%; Cognition claims 67%.
   - No independent SWE-bench Verified score exists for Devin. Cognition now reports on its own benchmark, FrontierCode.
6. **CEO read:**
   - Devin's moat is **distribution** (enterprise sales and Windsurf's user base) and **harness and infrastructure**: VM fleet, snapshots, review loop, automations.
   - The core LLM is not the moat.
   - The biggest risk is the model labs selling agents directly at their own inference cost, which squeezes Cognition's margin.

---

## 1. Page-by-page: devin.ai (read live 2026-10-12)

### 1.1 Home: https://devin.ai/
- **Headline:** "Meet Devin, your team's autonomous software engineer… runs in the cloud or on your machine, tests in its own browser, and won't stop until the PR is ready to merge."
- **Hero mock-up:**
  - Session sidebar: Sessions, Automations, Security, Review, Wiki.
  - A task, "Add enterprise SSO", sized **XL**.
  - Devin "Explored authentication across 3 repositories". It posts a PR, a **test recording on a Mac OS X VM**, "5 tests passed", and "Devin's analysis" on the PR.
  - Prompt box with mode selector "Ultra".
- **Pillars:**
  - Tests end to end on its own computer: Windows, Mac and Linux VMs, and it records itself clicking through.
  - "Gets the best from every frontier model": "up to 60% less" cost through mixing models.
  - Keeps working while the laptop is closed: splits tasks across **parallel cloud agents** and manages them.
  - @Devin in Slack and Teams.
  - Automations: handles bugs, failed CI and alerts proactively.
- **Four-stage SDLC story:**
  1. Understand and plan (Wiki, code maps).
  2. Code and test (Cloud, Desktop, CLI, @Devin).
  3. Review (Devin Review, one-click fix).
  4. Automate and maintain (scheduled and trigger automations, "Devin swarms", Security Swarm).
- **Integration tiles:** triage bugs, fix CI, investigate alerts, errors to fixes, assign a ticket and get a PR, build from a spec page.
- **"Recently shipped":**
  - Claude Haiku 5.5 (10/07)
  - Memory & Dreaming (10/05)
  - GPT-6.1 Sol (9/29)
  - Sign in with ChatGPT (9/29)
  - MongoDB partnership (9/29)
  - Sonnet 5.5 (9/28)
  - "40% more cost-efficient" (9/28)
- **Security claims:**
  - Inputs and outputs are your IP.
  - **Zero data retention enforced with model providers.**
  - Audit logs.
  - **Every session runs in its own VM.**
  - RBAC, SSO, SCIM and OIDC.
  - Private networking.

### 1.2 Devin Cloud: https://devin.ai/cloud
- **Tagline:** "Close your laptop. Come back to finished PRs."
- **Use cases with claimed metrics:**
  - Issue triage: 10,000+ hours saved per month.
  - Vulnerability remediation: 70% auto-remediated.
  - Migrations: "18-month migration completed in weeks".
  - Features: "90% of Cognition's code written by Devin".
  - Tests: 10–15x velocity.
- **Event-driven automations:** triggered by Slack mentions, Linear issues, CI failures, Snyk alerts and PagerDuty incidents.
- **Model-agnostic routing** across Anthropic, OpenAI, Google and Cognition models, "selecting the strongest for each task".
- **Computer use:** browser, terminal and GUI on Linux, Windows or Android.

### 1.3 Pricing: https://devin.ai/pricing
| Plan | Price | Key contents |
|---|---|---|
| Free | $0 | Light agent quota, limited models, unlimited inline edits and Tab completions |
| Pro | $20/mo | Frontier models (OpenAI, Claude, Gemini, SpaceXAI, open-source), **Devin Cloud access**, extra usage at API pricing, up to 10 concurrent sessions |
| Max | $200/mo | Pro with "significantly higher quotas" |
| Teams | $80/mo plus $40 per full dev seat | Up to 200 users, admin analytics, priority support. Flex seats are free but draw from shared credits and have no Desktop **[P docs]** |
| Enterprise | Custom | VPC deployment, SAML/OIDC, centralized multi-org admin, teamspace isolation, dedicated account team, ACU billing at the contracted rate |

- **Usage:** quotas refresh daily and weekly. The FAQ tells users to stretch them with smaller models (Haiku, GPT-5.2 Mini, Kimi K2.5).
- **Banner:** "SWE-2… free in Devin Desktop and CLI through Oct 16, 2026."

### 1.4 Security: https://devin.ai/security
- **Security Swarm** is powered by **"Agentic MapReduce"**. Its claimed result is **72% recall on 50 real GitHub Security Advisories at $90.23 per run**. Cognition's comparison figures:

  | Harness | Recall | $ per run |
  |---|---|---|
  | Devin | 72% | $90.23 |
  | Claude | 68% | $131.87 |
  | Codex | 48% | $118.20 |
  | Cursor | 26% | $4.60 |

  This is a vendor benchmark.
- **How a scan works:**
  1. A threat-model agent builds matchers and turns them into "signals", which it batches.
  2. **Parallel investigation agents**, one per batch, trace each signal across files.
  3. An aggregator agent dedupes, assigns owners, composes attack chains and prioritises.
  4. Optional **runtime validation**: the app is stood up and the exploit reproduced in a sandbox. Each finding comes back confirmed, false positive, or inconclusive.
  5. An optional report.
  - Incremental scans only analyse the diff.
- **Enterprise:** a 6-week "Devin Security Program" engagement, in which Cognition engineers embed with the customer.
- **FAQ note:** "Swarm does not rely on Fable and was not affected by Fable being pulled." See §8.4.

### 1.5 Customers: https://devin.ai/customers
- **Named customers (~40):** GE Aerospace, Modal, Mercedes-Benz, Itaú, Nubank, Ramp, Gumroad, AngelList, Rivian/VW (RV Tech), Cognizant, Infosys, Endava, WPP, EBANX, Airbyte, Comarch, Litera, Eight Sleep, Linktree, Bilt, and others.
- **Headline claims (vendor-reported):**

  | Customer | Claim |
  |---|---|
  | (headline) | COBOL migration from 8 months to 8 days |
  | EBANX | 92% of merged PRs written by Devin |
  | Gumroad | Devin is the #1 contributor, 1,500+ merged PRs |
  | Finch Legal | 3,000 PRs |
  | Modal | 80% of incidents investigated before an engineer looks |
  | The Access Group | 5x output across 2,000+ engineers |
  | Cognizant + Cognition at Odyssey Logistics | 37% net cost saving |
  | Litera | Regression cycles cut 90% |

### 1.6 Blog: https://devin.ai/blog (128 posts; the Windsurf/Codeium blog history is merged in)
**2026 Devin product timeline**, from blog and release notes:

| Date | Release |
|---|---|
| Jan 9 | Native Linear |
| Jan 22 | Devin Review |
| Feb 13 | Fast Mode and Skills |
| Feb 20 | API v3 GA |
| Feb 24 | Devin 2.2: desktop computer use, 3x faster startup |
| Mar 19 | Devin Manages Devins |
| Apr 14 | New self-serve plans |
| Apr 15 | Windsurf 2.0 with Agent Command Center |
| **Jun 2** | **Windsurf is now Devin Desktop.** Cascade is replaced by **Devin Local**, rewritten in Rust and about 30% more token-efficient; ACP support lets Codex, Claude Agent and OpenCode run inside it |
| Jun 4 | AI Productivity Guarantee |
| Jun 18 | Security in Devin Review |
| Jul 1 | Agentic MapReduce; Fable 5 restored |
| **Jul 21** | **Devin Outposts** |
| Jul 30 | Stacked PRs |
| Aug 7 | Security Profiles, Automations API, Terraform provider |
| Sep 9 | **Devin Plugins** (enterprise governance, with BlackRock) |
| Sep 10 | **SWE-2** |
| Sep 15 | macOS VMs |
| Sep 16 | Code Scans |
| Sep 18 | Knowledge folded into Skills |
| Sep 21 | Devin Cloud from the terminal (`devin --cloud`) |
| Sep 23 | Microsoft Teams and M365 |
| Sep 28 | 30–40% cheaper |
| Sep 29 | Sign in with ChatGPT; MongoDB partnership |
| **Oct 5** | **Memory & Dreaming** |
| Oct 9 | Resume window cut to 14 days; AGENTS.md read on setup |

Model drops are frequent: Opus 5/5.5, Sonnet 5/5.5, Haiku 5.5, Fable 5/5.1, GPT-5.6/6/6.1, Grok 4.6/4.7, Gemini 3.7 Flash, Kimi K3, GLM 5.2. Each post quotes a score on **FrontierCode 1.1, Cognition's own benchmark**.

---

## 2. How Devin works end to end

```
          ┌──────────── Cognition cloud ─────────────┐
 Trigger  │  "Brain": agent loop · model router      │   Devbox (VM per session)
 ───────► │  (Fusion lead+sidekick / Normal / Ultra) │ ◄──► shell · VSCode · browser
 Slack    │  context compaction · Skills · Memory    │      Linux/Win/macOS/Android
 Linear   │  Devin Review (clean-context verifier)   │      booted from org SNAPSHOT
 Jira     │  Manager Devin → child Devins            │      (or Outpost on your HW)
 GitHub   └──────────────────────────────────────────┘
 API/cron                 │
                          ▼
              Branch → PR (stacked) → CI watch → Review → Auto-Fix → human merge
```

### Step 1: Onboard
- **Connect source control:** GitHub, GitLab, Bitbucket or Azure DevOps. Enterprise admins also grant repos to each org.
- **Indexing:** repos are indexed for **Ask Devin and DeepWiki**.
- **Write a Blueprint**, a YAML file that works like a Dockerfile:

  | Section | What it does |
  |---|---|
  | `initialize` | Tools and runtimes |
  | `maintenance` | Dependency installs |
  | `knowledge` | Lint, test and build commands loaded into context |
  | `post-build` | Validation |
  | `clone` | Per-repo clone overrides |

- **Build a snapshot:** the build produces an org **snapshot** (a frozen bootable image). It rebuilds on save and about every 24 hours.
- **Setup by prompt:** you can say "Set up your environment for this repo" and approve the cards Devin suggests.
- **Hierarchy:** blueprints come in three tiers (enterprise, org, repo).
- The docs call environment setup "the single highest-leverage thing you can do." **[P]**

### Step 2: Hand it a task
**Entry points:**
- **Web app:** Ask (read-only, cited code search, plan mode) generates a "Devin Prompt", which you send to Agent mode.
- **Slack or Teams:** `@Devin` in a thread. Bang commands pick the mode (`!ultra`, `!fusion`, `!swe2`, `!mac`, `!outpost <name>`…).
- **Linear:** assign Devin to an issue. The `!plan` playbook is the default; labels select `!implement`, `!triage` or `!review`.
- **Jira:** a Rovo/Forge agent, or the `devin` label.
- **GitHub PR comment:** `/devin <prompt>` or `/devin review`.
- **REST API v3:** `POST /v3/organizations/{org}/sessions`. Optional fields include `prompt`, `repos`, `playbook_id`, `devin_mode`, `platform`, `max_acu_limit`, `structured_output_schema`, `security_profile` and `bypass_approval`.
- **CLI:** `devin --cloud`.
- **Automations:** triggered by Slack, GitHub, GitLab, Linear, Jira, PagerDuty, Pylon, cron or webhook.

**Agent modes:**

| Mode | What it is |
|---|---|
| Lite | Cheapest |
| Normal | Default |
| Ultra | Hardest tasks |
| Fusion | Frontier lead model plus cheap sidekick |
| SWE-2 | Medium / High / Max effort |
| Fast | Speed mode |
| DANA | Data analyst agent |

### Step 3: The session runs
- **A fresh VM boots from the snapshot.** Changes never write back to the snapshot.
- **Workspace:** Shell (with time travel), embedded VSCode (a human can take over after pausing Devin), Browser/"Computer" (computer use, screen recordings, manual MFA handoff, persistent cookies) and a Progress log.
- **Side chats:** `/btw` asks a question without interrupting the session.
- **Agent loop:** plan, act through tools, observe, repeat.
- **Batching:** recent harness changes batch shell commands and run independent tools in parallel, giving 2 turns instead of 4 and about 49% fewer tokens in Cognition's example. The harness is designed to maximise **prompt-cache** hits (71% fewer tokens processed from scratch in the example). **[P blog]**
- **Context handling:** a single linear writer agent. A separate **context-compression model** condenses history into decisions, and Cognition fine-tunes smaller models for this. **[P "Don't Build Multi-Agents"]**
- **Model handling:**
  - Ran on Anthropic Claude at launch.
  - The 1M-token context was capped at 200k to stop "context anxiety", where the model wraps up early. **[P Sonnet 4.5 rebuild]**
  - "Smart Friend" escalation forks the context to a stronger model (Claude and GPT together). **[P Apr 2026]**
- **Session states:**
  - API status values: `new → claimed → running → exit/error/suspended/resuming`.
  - A session sleeps after 30 minutes idle and is not billed while asleep.
  - It can be resumed for 14 days (cut from 30 on Oct 9, 2026).
  - Suspend reasons include `out_of_quota` and `org_usage_limit_exceeded`. **[P docs]**

### Step 4: Verify and ship
- Devin tests in its own browser or desktop and records itself.
- It opens a branch and a PR (or **stacked PRs** for large work) and monitors CI.
- **Devin Review:**
  - Starts with a **clean context and sees only the diff**: a generator-verifier pair.
  - Groups the diff logically, catches bugs with confidence levels, and lists security findings with CWE.
  - Cognition claims it averages 2 bugs per PR, about 58% of them severe. **[P]**
  - Public PRs can be reviewed free at devinreview.com.
- **Auto-Fix** responds to review findings and CI failures.
- **A human merges.**

### Step 5: Scale out
- **Managed Devins (Mar 2026):** a coordinator session spawns child Devins, each in its own VM. It messages and monitors them, has ACU caps, is woken when a child finishes, and can sleep or kill children.
- **Dynamic Workflows:** Devin writes a deterministic Python orchestration script. Runs are recorded and resumable. Recommended for about 5 or more fan-out units, or staged pipelines such as audit → fix → verify.
- **Security Swarm and Code Scans:** "Agentic MapReduce", in which a planner slices the repo, parallel investigators work the slices, and a reducer dedupes and ranks.
- **Cognition's rule from 2025–26:**
  - Parallel *writers* fail.
  - Use **one writer** plus read-only helpers: reviewers, DeepWiki lookups, smart-friend models.
  - Fan-out works only for independent units (per-file migrations, per-batch scans). **[P]**

### Step 6: Learn
- **Skills:** `.agents/skills/<name>/SKILL.md`, on the open Agent Skills standard. Devin suggests new skills and opens a PR for them. Knowledge was migrated into Skills on Sep 18, 2026.
- **Playbooks:** reusable prompt templates (Procedure / Specs / Advice / Forbidden / Required), invoked as `!macro`.
- **Memory (Oct 2026):**
  - Stored per user per org as a **git repo of markdown notes**.
  - `MEMORY.md` is the index and is injected at session start. Other notes are pulled with search tools.
  - Each session works on its own checkout and commits. Stale writes are rejected by a revision check and conflicts are surfaced.
  - **Dreaming** is a daily background pass that dedupes, links, prunes unused notes and extracts missed lessons.
  - Sessions started by automations don't read or write memory.
  - The spec is open-sourced as "Agent Memory Repo". **[P]**
- **AGENTS.md** and `.cursorrules`/`CLAUDE.md`-style files are imported automatically.

### Step 7: Where it runs (deployment)

| Option | What it is | Who runs the infrastructure |
|---|---|---|
| Multi-tenant (default) | One isolated VM per session | Cognition |
| Customer Dedicated | Single-tenant VPC via AWS PrivateLink, IPSec or OpenVPN | Cognition |
| Enterprise Assured | Dedicated plus customer-managed keys | Cognition |
| **Outposts (Jul 2026)** | Sessions run on your own GPU box, VPC VM, Kubernetes cluster or Mac mini | You |

- **How Outposts work:**
  - Outposts are named queues.
  - Workers (`devin worker start --outpost=<name>`) **dial out only** and claim sessions atomically.
  - Workers run as an unprivileged user.
  - **The Brain stays in Cognition's cloud.**
  - An API exposes the queue so orchestrators can autoscale. Partners include Modal, Cloudflare, Daytona, E2B, NVIDIA OpenShell and Namespace (macOS on M5).
  - Cognition recommends Outposts only for teams already experienced at running remote dev VMs.
- **Security features:**
  - SOC 2 Type II since Sep 2024.
  - Encryption in transit and at rest.
  - Secrets scoped org, personal, repo or session (including cookies and TOTP), never written into snapshots.
  - Security Profiles: network allowlists plus MCP, git and gh restrictions.
  - RBAC with custom roles, SCIM, IP allowlists, audit logs.
  - **By default Cognition may train on your data.** Paid plans can opt out, which also enables zero retention. Enterprise data is excluded unless the customer agrees in writing. **[P docs]**

### Integrations and extensibility
- **MCP:** stdio, SSE or HTTP servers at personal, org or enterprise scope.
- **Plugins:** bundle MCP servers and skills; distributed through a marketplace.
- **Devin's own MCP server:** manages sessions and config. A DeepWiki MCP server is also available.
- **Other integrations:** PagerDuty, Pylon, Databricks, MongoDB, Microsoft 365.
- **Devin Desktop runs third-party agents via ACP** (Agent Client Protocol), showing them in a Kanban view with shared "Spaces".
- **Handoff:** `/handoff` and the `devin-handoff` plugin move work from Claude Code, Codex or Cursor into Devin Cloud.

---

## 3. Pricing and billing history

| Date | Model |
|---|---|
| Mar 2024 | Waitlist only |
| Dec 10, 2024 | GA: **$500/mo** per team, unlimited seats |
| Apr 3, 2025 (Devin 2.0) | Core **$20** plus $2.25/ACU (1 ACU ≈ 15 minutes of work); Team $500 including 250 ACUs; Enterprise custom |
| Apr 14, 2026 | Core and Team retired. **Free / Pro $20 / Max $200 / Teams $80 + $40/seat / Enterprise**. Self-serve moves to quota plus credits; enterprise stays on ACUs; Core users moved to Free |
| Jun 4, 2026 | **AI Productivity Guarantee**: if measured value (AI-estimated hours × a standard rate) falls short of an enterprise's annual spend, Cognition issues credits up to **$10M** **[P]** |
| Sep 28, 2026 | 30–40% cheaper in Fusion/Normal, 15–20% in Ultra, up to 70% in Review **[P]** |
| Sep 29, 2026 | ChatGPT Plus/Pro plans can pay for OpenAI-model usage in Devin |

- **What an ACU measures:** number and complexity of actions, plus VM time and bandwidth.
- **Not billed:** waiting for the user or for tests, and while asleep.
- **Platform rates:** Windows sessions cost about 9% more. macOS is at Linux rates for now, labelled "promotional launch pricing".
- **User complaint:** ACU burn is opaque; users split work into chunks of 10–20 ACU to keep it under control. **[S]**

---

## 4. Company and business

### 4.1 Founding
- **Founders:** Scott Wu (CEO), Steven Hao (CTO) and Walden Yan (CPO). All are IOI gold medallists; the team had 10 IOI golds at launch.
- **Prior roles:** Wu co-founded Lunchclub; Hao was an early Scale AI engineer; Yan interned at Anysphere (Cursor).
- **Founded:** 2023. Month conflicts **[C]**: August or November.
- **Debut:** Devin was unveiled Mar 12, 2024.

### 4.2 Funding
| Date | Round | Raised | Valuation | Leads |
|---|---|---|---|---|
| ~Mar 2024 | A | $21M | ~$350M | Founders Fund [S] |
| Apr 2024 | B | $175M | $2B | Founders Fund [M] |
| Mar 2025 | — | n/a | ~$4B | 8VC [S] |
| Sep 8, 2025 | C | >$400M | $10.2B | Founders Fund [P] |
| May 27, 2026 | D | >$1B | $26B | Lux, General Catalyst, 8VC [P][M] |
| **Sep 8, 2026** | **E** | **>$2B** | **$48B** | **a16z, Accel**, plus about 40 others [P] |

Total raised is at least about $3.5B.

### 4.3 Revenue and burn (all self-reported or reported second-hand)
- **Run-rate revenue (ARR) trajectory:**

  | Date | ARR | Note |
  |---|---|---|
  | Sep 2024 | ~$1M | |
  | Jun 2025 | $73M | Devin only |
  | Jul 2025 | +$82M from Windsurf | |
  | Early 2026 | ~$280M | [S] |
  | May 2026 | $492M | [P] |
  | Sep 2026 | **~$900M** | [P] |

- **Reported internal targets:** $1.5B by end of 2026 and $4–5B in 2027 **[S]**.
- **Burn:** about **$800M** planned for 2026, mostly leased NVIDIA compute for running the product and training models. About $200M burned in Q2 alone.
- **Margin:** about **50%** enterprise gross margin **[S, The Information]**.
- **Contrast:** in 2025 the company said it had burned under $20M since inception.

### 4.4 Windsurf deal (July 2025)
- **How it happened:**
  - OpenAI's roughly $3B deal for Windsurf collapsed.
  - Google paid about $2.4B to license the tech and hire CEO Varun Mohan and some staff.
  - Cognition bought the rest on Jul 14, 2025: IP, product, brand, go-to-market and about 200 staff. The price was undisclosed.
- **What it brought:** $82M ARR, 350+ enterprise customers, an IDE user base and an enterprise sales force. Customer overlap was under 5%.
- **Fallout (Aug 2025):**
  - About 30 people were laid off.
  - The rest were offered **9 months' pay to leave, or 6 days and 80+ hours a week** to stay **[M]**.
- **Integration timeline:**
  - SWE-1.5 (Oct 2025): about 950 tok/s on Cerebras.
  - Windsurf 2.0 (Apr 2026).
  - Renamed Devin Desktop (Jun 2026).
  - SWE-2 (Sep 2026).

### 4.5 Go-to-market
- **Positioning:** an "AI software engineer" sold as a teammate, not a copilot.
- **Enterprise focus:** regulated buyers such as Goldman Sachs ("hundreds to thousands of Devins" alongside 12k developers), Citi, Itaú, Santander, Mercedes, the US Army and Navy.
- **Government:** "Cognition for Government" launched Feb 2026. Windsurf reportedly holds FedRAMP High and supports DoD IL4–IL6 deployments **[S]**.
- **Channels:** systems integrators (Infosys from Jan 2026, Cognizant, Endava, AHEAD), Microsoft/Azure (2024), and a MongoDB modernization partnership (Sep 2026).
- **Expansion beyond coding:** Auto-Triage (on-call/SRE), Security Swarm (AppSec budget), Automations, and the 6-week Security Program services engagement.
- **Bottom-up:** the free and Pro tiers, plus the free DeepWiki and devinreview.com as lead generation.
- **Offices:** San Francisco, New York, Austin, DC, Tokyo, Singapore, London, São Paulo, Madrid.
- **Headcount:** somewhere around 230–400 **[C]**.

---

## 5. Does it actually work? Claims vs evidence

### 5.1 Claims vs independent findings

| Claim (source) | Independent finding |
|---|---|
| Mar 2024: 13.86% SWE-bench, vs a "1.96% unassisted" prior best [P] | Measured on a **random 25% subset** (79/570) with a 45-minute cap. Assisted and unassisted results are not comparable. Cognition did publish the harness. |
| "Devin did real Upwork jobs" [P] | **Internet of Bugs** video (Apr 2024): the task was only partly given to Devin, Devin took hours on what a human could do in about 30 minutes, and it fixed bugs it had introduced itself. No public rebuttal found. |
| "Senior-level understanding, junior execution" (Nov 2025 performance review) [P] | **Answer.AI (Jan 2025):** 3 successes, 14 failures and 3 inconclusive out of 20. Failures included loops, hallucinated platform features, ignored constraints, and success that couldn't be predicted from task type. |
| PR merge rate 67%, up from 34% [P] | PRarena about 64%; another tracker about 60%; the MSR 2026 AIDev dataset 53.8%, **below** the 71.5% agent average [S]. Roughly consistent with the claim, but these PRs are self-selected tasks. |
| FrontierCode leaderboards: SWE-2 at 50.0%, Fusion at 68.8% [P] | **FrontierCode is Cognition's own benchmark.** Terminal-Bench 4: SWE-2 at 27.3% vs about 56% for the leaders [S]. No independent SWE-bench Verified score exists for Devin. |
| Security Swarm 72% recall [P] | Vendor-run benchmark of 50 GHSA advisories. Not reproduced independently. |

### 5.2 Where it works and where it fails
**Sweet spot:**
- Clear spec plus a verifier (tests, CI, linter, scanner).
- Roughly 4–8 hours of junior-engineer work.
- Repetitive work across many units: framework and version upgrades, COBOL/ETL/Java migrations, CVE and SAST fixes, test generation, docs, lint backlogs, incident first-pass triage.

**Failure modes:**
- Vague or architectural work.
- Visual design without exact specs.
- Requirements that change mid-task.
- Loops on errors.
- Hallucinated APIs.
- Convoluted workarounds instead of root-cause fixes.
- "Context anxiety".
- Cost blowups on big monolithic tasks.

The docs' own guidance matches this list: keep sessions XS–M, one task per session, and give success criteria.

---

## 6. Architecture lessons Cognition has published (high value)

1. **"Don't Build Multi-Agents" (Jun 2025):**
   - Share full traces, not just messages.
   - Actions carry implicit decisions, so parallel writers conflict.
   - Default to a **single-threaded writer** plus a context-compression model.
2. **Edit model:** in 2024 a big model described edits and a small "apply" model rewrote files. This was fragile, so one model now both decides and applies edits.
3. **Sonnet 4.5 rebuild (Sep 2025):**
   - The model's own notes are insufficient, so Devin keeps its own memory and compaction.
   - Parallel tool calls burn context faster.
   - Capping context below the maximum curbs early wrap-up.
4. **"Multi-Agents: What's Actually Working" (Apr 2026):** what works is a generator-verifier pair (Devin plus Review with a clean context), smart-friend escalation, and a manager spawning children over MCP for independent units.
5. **Cost engineering (Sep 2026):** batching tool calls, prompt-cache-aware harness design, cheap sidekick models in Fusion, and model choice per subtask (planning, testing, computer use).
6. **Infrastructure:** snapshot-booted per-session VMs, sleep/resume billing, an outbound-only worker queue (Outposts), and git-backed memory with optimistic-concurrency writes.

---

## 7. Competitive landscape (2026, mostly secondary figures)

| Player | Position | Threat to Devin |
|---|---|---|
| Claude Code (Anthropic) | Reported >$2.5B run-rate in early 2026 [S] | Lab sells the agent at its own inference cost; Devin depends on Anthropic models |
| OpenAI Codex | ~$2.5B claimed [U] | Same lab-direct risk; "Sign in with ChatGPT" is Devin turning this into a partnership |
| Cursor (Anysphere) | ~$2B ARR; valued at $29B to $50–60B [C] | Owns the IDE habit; background agents overlap with Devin Cloud |
| GitHub Copilot coding agent | 20M users, ~4.7M paid [S] | Default inside GitHub; distribution moat |
| Factory, Replit, Google Jules | Not researched | Gap |

**How Devin differentiates:**
1. Fully autonomous cloud agents running in parallel, plus a local IDE: it covers the most surfaces of any player.
2. Model-agnostic routing plus its own models (SWE-x) as a hedge.
3. Enterprise and government compliance (VPC, Outposts, FedRAMP), integrator channels, and outcome guarantees.
4. Expansion into security and SRE budgets.

---

## 8. CEO assessment

### 8.1 What they got right
- **They sold an outcome (merged PRs) rather than a tool,** and reached the enterprise budget line through a "hybrid workforce" story plus integrator channels.
- **Buying Windsurf when it was distressed** brought distribution and an enterprise sales force, and turned a single-product agent into a platform covering IDE, CLI, cloud and review.
- **Model independence early:** when Fable 5 was pulled by US order (Jun 2026), Devin routed to other models and stayed up.
- **Built the boring infrastructure:** snapshots, VMs on every OS, outbound-only outposts, review loop, automations, RBAC, SCIM, audit. This is what enterprises actually buy.
- **Lowered price as model costs fell,** and offered a $10M guarantee to reduce buyer risk.

### 8.2 Weaknesses and risks
- **Margins:** 50% gross margin on resold inference while labs ship competing agents → margin squeeze. That forces heavy spending on its own models (SWE-2 is post-trained from Kimi K3). It is a capital-intensive race against labs that own their inference.
- **Burn and valuation:** about $800M burn and a 53x run-rate multiple. Revenue is unaudited, and run-rate is not recognised revenue.
- **Credibility debt:** the 2024 demo controversy, self-authored benchmarks, and no independent SWE-bench Verified score.
- **Dependence on Anthropic and OpenAI,** both of which are also competitors.
- **Culture and attrition risk:** the 80-hour-week ultimatum.
- **Pricing churn:** four pricing models in two years confuse buyers, and ACU opacity frustrates users.
- **Trust defaults:** paid self-serve plans train on customer data unless they opt out.

### 8.3 Strategy outlook
- They are moving from "AI engineer" to an "**agent platform and command center**": ACP lets rival agents run in Devin Desktop, and Outposts runs Devin on customer hardware. The bet is to own **orchestration, governance and the review layer** whichever model writes the code.
- Expect more vertical "swarms" (security, migrations, code scans), more services-led enterprise deals, and pressure to show audited revenue before any IPO.

### 8.4 Fable incident (supply-chain risk example)
- Anthropic's Fable 5 launched Jun 9, 2026.
- A US export-control order followed, and Anthropic disabled the model for all customers.
- Cognition removed it on Jun 13. It was restored on Jul 1 with added cyber-query safeguards **[S]**.
- **Lesson:** a frontier-model dependency is a regulatory risk. Routing is the mitigation.

---

## 9. Takeaways for MissionAlpha (our own agent platform)

These are directly applicable patterns, ordered by leverage:
1. **One writer, many readers.** A single code-writing agent per unit of work, with reviewer and verifier agents working from clean context. Fan out only across independent units.
2. **A clean-context reviewer as a hard gate** before any PR is proposed, plus an auto-fix loop on CI and review failures.
3. **Prebuilt environment snapshots** (blueprint → snapshot) to make sessions fast and reproducible. Environment setup is the highest-leverage onboarding step.
4. **Session lifecycle states plus sleep/resume billing** (`waiting_for_user` and `out_of_quota` as explicit states).
5. **Git-backed memory with optimistic concurrency, plus a daily consolidation pass.** It is cheap to build and their spec is open-source.
6. **Event-driven automations** (trigger → condition → preflight → action) are the stickiness engine, more than chat.
7. **Model-agnostic routing** (lead plus sidekick), and a cache-aware harness that batches tool calls.
8. **Outbound-only workers** for customer-hosted execution (no inbound ports).

---

## 9b. Hands-on: inside app.devin.ai (logged in, 2026-10-12)

**Account state:** Free plan with the free credits used up ("You ran out of free credits. Please subscribe…"). No git provider is connected. No session was started, nothing was installed, and no settings were changed.

### Composer (home page)
- **Mode switch:** Agent or Ask.
- **Model and agent picker:** Capability: **Fusion, Ultra, Normal (default), Lite**. Previews: **SWE-2, GPT-6.1 Sol**.
- **"+" menu:** Upload files or folder, @Repositories, Files, Skills, Devin sessions, Playbooks, Plugins, Secrets.
- **Other controls:** mic and voice input.
- **Command palette (Cmd+K):** start a session, search sessions, navigation, theme.
- **Onboarding toast:** "Open PRs with Devin – connect your codebase to try Devin for free."

### Sidebar
New session · Automations · Security · Review · Wiki · Customize · Sessions (Recent) · Onboarding flow · Settings.

### Automations
- **Tabs:** Mine / All, plus "Create automation".
- **"Suggest automations for me":** Devin mines your recent work for repetitive tasks to automate.
- **Template gallery**, by category (Monitoring & Triage, CI/CD & Release, Security, Project Management):

  | Template | What it does |
  |---|---|
  | Triage Bug Reports (Slack) | Watches a channel, triages incoming bugs |
  | Triage Support Requests (Slack) | Drafts replies to support requests |
  | Triage Customer Bug Tickets (Pylon) | Reproduces and investigates customer bugs |
  | Investigate Support Escalations (Pylon + Slack) | Root cause, then tags the owner and files a Linear ticket |
  | Investigate Alerts (Slack + Datadog MCP) | Root-cause analysis on alerts |
  | Fix Sentry Errors Daily | Opens fix PRs for top errors |
  | Daily Error Report (Datadog) | Daily error summary |
  | Recurring Capacity Planning | Forecasts capacity needs |
  | **Fix CI Failures** | On non-Devin PRs |
  | `/devin` Issue Fix (GitHub) | Turns an issue comment into a fix PR |
  | Weekly Dependency Update | PRs grouped by risk |
  | Weekly Changelog | Updates CHANGELOG.md |
  | Stale PR Cleanup | Nudges stale PRs |
  | Catch bugs in merged PRs | Reviews every push to main |

  More templates exist beyond these.

### Security
Scans, Profiles and Automations tabs. "Create scan" starts Security Swarm.

### Review
- "Paste pull request URL – Review any PR URL", or connect a git provider to list PRs.
- **Review settings:**
  - Post findings as PR comments, split into categories: **Bugs / Security / Flags / Notes**.
  - Post a **GitHub CI check** per review.
  - Auto-review enrollments by repo or user, plus exclusions.
  - **Per-PR on-demand spend cap, $5 by default.**
  - Rule files: `**/REVIEW.md` is read by default, prioritised by how close it is to the changed files.

### Wiki
DeepWiki for each connected repo ("Add wiki"). Empty until git is connected.

### Customize
- **Tabs:** Plugins · Skills · MCPs · **Hooks** · Rules · Memory.
- Plugins are "bundles of skills, rules, hooks, MCPs, and subagents installed across cloud and local", with Personal and Organization scope.
- **Marketplace** (also mirrored on GitHub): over 80 entries in A–F alone, from AWS (many services), Datadog, Databricks (30 skills + 3 hooks), Amplitude (36 skills), Cloudflare (16 skills), Context7, DeepWiki, Figma, Firecrawl, Sentry, and more.

### Settings map
- **Personal:** Preferences, Shortcuts, Notifications, Connections.
- **Org billing:** General, Connections, Plans, Invoices, Usage & Limits.
- **Products:** Devin, Review, DeepWiki, Schedules, Devin Desktop.
- **Resources:** Knowledge (now a banner saying "moved to skills"), Environment, Playbooks, Secrets.
- **Admin:** Repositories, Membership, Devin API, Analytics.

### Notable settings
- **Connections:** GitHub, GitLab, Bitbucket · Slack, Teams · Linear, Jira · PagerDuty. MCPs have moved to Customize.
- **Devin › Sessions:**
  - Enable **native deployments** to the public internet.
  - **Memory** on or off.
  - **Agent computer use** (mouse, keyboard and screen, or browser-only).
  - **SSH into session machines**, with SSH keys.
  - Default agent, plus a separate **API default agent**.
  - **Default platform or outpost** (Ubuntu).
  - Custom `/` commands.
  - **Batch limit: 1–500 sessions per batch.**
  - **Per-message on-demand $ limit.**
- **Devin › Pull requests:**
  - Share the prompt in PRs.
  - Require @Devin to respond.
  - Only forward PR comments from people with session access.
  - Auto-add the creator as reviewer.
  - An allowlist of bots Devin responds to.
- **Security profiles:** reusable session restrictions.
- **Environment:** tabs Blueprints / Snapshots / Advanced / **Outposts**. There is an org blueprint, and repos are cloned in a drag-to-order sequence during snapshot builds.
- **Usage & Limits:** an included quota plus an on-demand $ balance. "Sessions will pause when your included quota is exceeded."
- **Secrets:** reference with `$NAME`, at Org or Personal scope, with bulk add. **OIDC to cloud providers and secret managers, so no credentials are stored.** MCP credentials now live on each server's page.
- **Devin API:** **Service users** (role-scoped, with expiry), **PATs**, and legacy API keys.
- **Analytics:** Usage / **Leaderboard** / Skills. Sessions by size (XS–XL), searches, PRs (open, closed, merged), and Devin Review KPIs (**PRs reviewed, bugs caught, merge-time reduction, $ per review**), with Export.
- **Plans page:** matches the public pricing. Pro adds "Slack, Linear, and MCP integrations" and "Use your ChatGPT plan"; Free includes Devin Review and DeepWiki.

### Playbooks: 32 system playbooks shipped by Cognition (first page)
- **Linear:** `!plan`, `!implement`, `!triage`, `!review`.
- **Automation and onboarding:** `!automation_discovery`, `!first_session`.
- **Quality:** `!visual_qa`, `!bug_catcher`, `!pr_review`, `!pr_documentation`, `!readme`, `!roast` ("Roast My Commits").
- **Migrations:** `!java_8_to_11`, Python 3.8 to 3.13, Ruby 3.1 to 3.3, Rails 7.0 to 7.1, `!angular`.
- **Security and tests:** Checkmarx SAST Resolution, `!java_unit_testing_improvements`.
- **Other:** Microsoft Agent 365 SDK agent.

Playbooks are versioned and record which sessions used them.

**What "Linear: Implement" (`!implement`) actually instructs.** This is the best look at Devin's working method:
1. **Disambiguation phase:**
   - Fetch the ticket through the Linear MCP, and read **every comment and attachment**.
   - Call the **Devin MCP `ask_question` and `read_wiki_contents`** (DeepWiki) across all possibly relevant repos.
   - Mine past tickets by the same author, related commits and PRs, and linked docs.
   - Resolve jargon itself. "Don't block on the user for preferences. Just simulate what the user would want."
   - Ask questions only for critical ambiguity, then stop and wait.
2. **Implementation phase:**
   - Set the ticket to In Progress.
   - Trace data and control flow, and **map callers and callees**.
   - Create a branch, implement, and **verify with the LSP** (`goto_definition` / `goto_references` / `hover_symbol`).
   - Write tests, lint, and run tests.
   - Commit referencing the ticket, open a PR, link it on the ticket, and set the status to For Review.
3. **Iteration phase:**
   - **Self-review the diff** against the ticket, the playbook criteria, and conventions (no dead code, no unnecessary abstractions, backwards compatibility).
   - Wait for CI.
   - **Read review-bot comments even when their CI check shows "passed"** (CodeRabbit, Graphite, devin-ai-integration).
   - Resolve every human comment and triage bot feedback.
   - Loop until clean, then post "ready for human review".

**Takeaway for MissionAlpha:** Devin's quality comes largely from **long, phase-gated playbook prompts with explicit verification checklists**, plus tools (LSP, DeepWiki Q&A, tracker MCPs). These are not secret models, and the pattern is directly copyable.

---

## 10. Known gaps and risks of this report
- **Revenue, burn, margin and headcount are unaudited or second-hand.** The Information articles were paywalled and read via summaries.
- **The 2026 model-generation names** (Opus 5.5, GPT-6 Sol, Fable 5.1, SWE-2 and others) come from Devin's own blog. SWE-2's base model (Kimi K3) and its Terminal-Bench figure are secondary.
- **No independent SWE-bench Verified score for Devin** was found. Community (HN/Reddit) evidence is thin and mostly aggregator-level.
- **Quota sizes, enterprise ACU rates and API rate limits are unpublished.** The concurrency row on the pricing page is ambiguous across plan columns.
- **Not researched:** competitor coverage of Factory, Replit and Jules.
- **I walked through the logged-in app (§9b) but could not run a session**: the Free plan's credits were used up and no git provider is connected. Session-runtime behaviour (the VM view, the agent loop in action, PR quality) is therefore still sourced from docs and third parties, not observed.
- **Docs change weekly.** Treat anything here as stale after about 2 weeks.

---

## 11. Sources (primary first)
**devin.ai:** https://devin.ai/ · /cloud · /pricing · /security · /customers · /blog · /blog/memory-and-dreaming · /blog/more-efficient-devin · /blog/windsurf-is-now-devin-desktop · /blog/introducing-devin-outposts · /blog/claude-fable-5-available-in-devin

**Docs:** https://docs.devin.ai (get-started/devin-intro, first-run, onboard-devin/environment, blueprints, work-with-devin/devin-review, devin-session-tools, advanced-capabilities, dynamic-workflows, mcp, deepwiki, product-guides/skills, memory, automations, creating-playbooks, secrets, security-profiles, integrations/slack, linear, jira, gh, api-reference/v3, admin/billing/usage, self-serve, enterprise, admin/security, enterprise/deployment/overview, cloud/outposts/overview, release-notes/2025, 2026)

**Cognition:**
- https://cognition.com/blog/series-d
- https://cognition.com/blog/series-e
- https://cognition.com/blog/windsurf
- https://cognition.com/blog/ai-guarantee
- https://cognition.com/blog/new-self-serve-plans-for-devin
- https://cognition.com/blog/introducing-devin
- https://cognition.com/blog/swe-bench-technical-report
- https://cognition.com/blog/dont-build-multi-agents
- https://cognition.com/blog/devin-sonnet-4-5-lessons-and-challenges
- https://cognition.com/blog/multi-agents-working
- https://cognition.com/blog/devin-annual-performance-review-2025
- https://cognition.com/blog/introducing-devin-2-2
- https://cognition.ai/blog/devin-2
- https://cognition.ai/blog/devin-generally-available

**Independent:**
- https://www.answer.ai/posts/2025-01-08-devin
- https://www.theregister.com/2025/01/23/ai_developer_devin_poor_reviews
- https://www.youtube.com/watch?v=tNmgmwEtoWE
- https://arxiv.org/pdf/2602.00164
- https://github.com/aavetis/PRarena
- https://arxiv.org/pdf/2507.11948

**Press:**
- https://www.bloomberg.com/news/articles/2026-05-27/ai-coding-startup-cognition-raises-1-billion-at-26-billion-value
- https://www.bloomberg.com/news/articles/2026-08-12/ai-startup-cognition-in-new-funding-talks-at-40-billion-value
- https://fortune.com/2025/07/14/goldman-sachs-ai-powered-software-engineer-devin-new-employee-increase-productivity-fears-of-job-replacement
- https://www.entrepreneur.com/business-news/ai-windsurf-take-the-9-month-pay-buyout-or-work-6-days/495554
- https://cryptobriefing.com/cognition-900m-arr-800m-cash-burn/
- https://thenextweb.com/news/cognition-series-e-48bn-flat-multiple
- https://techradar.com/ai-platforms-assistants/claude/anthropics-fable-5-is-back-after-us-shutdown-it-called-a-misunderstanding
- https://www.aipricing.guru/news/cognition-swe-2-launch-pricing-impact-september-2026/
- https://www.infosys.com/newsroom/press-releases/2026/collaboration-accelerate-ai-value-journey.html
