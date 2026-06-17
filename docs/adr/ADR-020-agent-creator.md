# ADR-020 — Agent-Creator (NL → spec)

**Status:** Accepted · **Date:** 2026-06-17 · **Author:** architect

## Context
Path B: the BOSS describes a need in natural language; Claude authors the full agent spec for BOSS review. No manual form (Path A) yet.

## Decision
`POST /factory/author {description}` (token+host gated) runs the local `claude` CLI (cli backend = Claude Code subscription, no API key) with `AGENT_CREATOR_SYSTEM`. It streams the model's reasoning over SSE (`token` events), then emits a single `spec` SSE event carrying the server-parsed + validated spec object (or an `error`). The spec is **NOT** auto-created — the BOSS reviews/edits it in the UI and confirms via `POST /factory/create` (ADR-019).

`AGENT_CREATOR_SYSTEM` instructs: pick a kebab id, a sharp persona system-prompt, skills from the closed catalog, minimal tools, integrations only when a matching posting skill is chosen, and end the persona with the `/caveman full` bus mandate. Output is reasoning then exactly one fenced ```spec JSON block.

A `mockAuthorSpec(description)` keyword fallback keeps the create flow demoable when no `claude` binary is available (parity with the runtime's mock backend).

## Security
Authoring is pure text generation — **no tools** (no fs/exec) for the creator child; secret-shaped env stripped. The model's output is untrusted: it is parsed and run through the full ADR-019 validator before it can become an agent. Only the BOSS triggers authoring + creation (gated); agents cannot create agents. Prompt injection in the description can at most produce a spec the BOSS rejects.

## Consequences
The BOSS gets a fast NL→agent loop while every created agent is catalog-constrained and human-confirmed.
