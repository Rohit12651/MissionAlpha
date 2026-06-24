---
name: codeburn
description: Show AI token/cost analytics across Claude Code, Cursor, Copilot, and 16 other coding tools. Break down spending by project, model, task type, and provider. Track subscription plan usage vs budget. Use when user asks about token costs, AI spend, usage stats, or model efficiency.
trigger: /codeburn
---

# /codeburn

See where AI coding tokens go. Reads session data locally — no proxy, no API keys.

## Usage

```
/codeburn                          # interactive TUI dashboard
/codeburn status                   # one-line cost summary for today
/codeburn today                    # today's spend by project
/codeburn month                    # this month's spend
/codeburn report                   # full report (default)
/codeburn report --week            # last 7 days
/codeburn report --month           # last 30 days
/codeburn report --since 2025-01-01 --until 2025-01-31
/codeburn report --project my-app  # filter to one project
/codeburn optimize                 # detect waste, suggest cheaper models
/codeburn compare                  # compare models by task type and cost
/codeburn models                   # list all tracked models + pricing
/codeburn plan                     # show subscription plan usage vs budget
/codeburn plan set max             # set plan to Max ($200/mo)
/codeburn plan set pro             # set plan to Pro ($20/mo)
/codeburn export --format json     # export data as JSON
/codeburn export --format csv      # export data as CSV
/codeburn currency EUR             # switch display currency
/codeburn yield                    # value per dollar — output quality metric
```

## When to invoke

- User asks "how much have I spent on AI?" or "what's my token usage?"
- User wants to compare Claude vs Cursor vs Copilot costs
- User wants to optimize model selection for cost vs quality
- User asks about plan budget remaining (Max, Pro, etc.)
- User wants a cost breakdown by project or task type

## Steps

1. Run `codeburn status` for quick one-liner cost summary
2. Run `codeburn report` for full breakdown by project/model
3. Run `codeburn optimize` to find inefficiencies
4. Run `codeburn compare` to see which model is most cost-efficient for the user's task mix
5. Report findings to user with specific numbers

## Supported tools tracked

Claude Code, Cursor, GitHub Copilot, Windsurf, Kilo Code, Cline, Continue, Aider, Zed AI, Gemini CLI, Amazon Q, OpenCode, Kiro, and more (19 total).
