---
name: headroom
description: Context compression layer for AI agents — cuts token usage 60-95% by compressing tool outputs, logs, RAG, files, and history before the LLM, with the same accuracy. Use when a session is token-heavy, context is overflowing, or you want a cost/usage report.
argument-hint: "[wrap | proxy | mcp | learn | perf]"
---

# headroom — context compression for AI agents

Headroom compresses everything an agent feeds an LLM (tool outputs, logs, retrieval chunks, file
contents, conversation history) **before** the model sees it — 60-95% fewer tokens at the same accuracy.
Local-first, reversible, 6 algorithms.

## When to apply

- A session is running long / expensive, or context is close to overflowing.
- You want to compress agent output, reduce tokens, or share memory across Claude/Codex/Cursor.
- You want a token-savings or cost report.

## Modes

| Mode | Command | Use when |
|---|---|---|
| Wrap agent | `headroom wrap claude` | Compress all Claude Code sessions automatically |
| Proxy | `headroom proxy --port 8787` | Zero-code compression for any language/tool |
| MCP server | `headroom mcp` | Direct MCP integration with Claude |
| Learn | `headroom learn` | Mine failed sessions → write fixes to CLAUDE.md |
| Perf | `headroom perf` / `headroom output-savings` | Token-savings stats |

Binary: `~/.local/bin/headroom`. Repo: `WaahyuTools/headroom`.
