---
name: ruflo
description: Orchestrate multi-agent AI swarms via Ruflo (Claude Flow fork). Spawn specialized agents, coordinate parallel tasks, manage memory across sessions, and run federated workflows. Use when user needs to parallelize complex work, set up agent swarms, or manage long-running multi-step orchestrations.
trigger: /ruflo
---

# /ruflo

Multi-agent orchestration for Claude Code. Coordinates swarms of specialized agents, persistent memory, and federated task execution.

## Quick Start

```bash
ruflo init              # set up Ruflo in current project (.claude/, hooks, agents)
ruflo start             # start Ruflo daemon + MCP server
ruflo status            # show active agents and swarm health
ruflo stop              # stop daemon
```

## Usage

```
/ruflo init                          # bootstrap Ruflo in this project
/ruflo spawn <agent-type> <task>     # spawn a specialized agent
/ruflo swarm <goal>                  # create agent swarm for a complex goal
/ruflo task create <description>     # create a task for agents to pick up
/ruflo task list                     # list all tasks + status
/ruflo memory store <key> <value>    # persist cross-session memory
/ruflo memory search <query>         # semantic search across stored memory
/ruflo workflow create <name>        # define a multi-step workflow
/ruflo workflow execute <name>       # run a workflow
/ruflo federation status             # check federated agent connections
/ruflo agents list                   # list all available agent types
```

## Agent types (98 available)

Key types: `architect`, `coder`, `reviewer`, `tester`, `debugger`, `docs-writer`, `security-auditor`, `devops`, `researcher`, `data-analyst`, `optimizer`

## When to invoke

- User has a task too large for single context (parallelize across agents)
- User wants agents to coordinate and share memory across sessions
- User sets up a project and wants Ruflo's hooks/routing auto-installed
- User wants to run recurring workflows on a schedule

## Steps

1. Check if Ruflo is initialized: `ruflo status`
2. If not initialized: `ruflo init` in project root
3. For a complex goal: `ruflo swarm "<goal>"` — Ruflo decomposes and assigns agents
4. Monitor via `ruflo task list`
5. Results stored in memory, accessible via `ruflo memory search`

## Notes

- Ruflo = Claude Flow (ruvnet) rebranded. CLI: `ruflo` or `ruvflo`
- Full install (npx ruflo init) adds `.claude/`, hooks, and MCP server to project
- Plugin path: `WaahyuTools/ruflo/plugins/` — 280+ skills available per plugin
- MCP tools exposed when daemon running: `mcp__claude-flow__*`
