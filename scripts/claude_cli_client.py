"""
Subscription-backed Claude client - shells out to the local `claude` CLI
(Claude Code) instead of the Anthropic API, so calls run against your own
Claude subscription rather than a separate API key/credits.

Prerequisite: `claude auth login` must already be run once on this machine.

NOTE ON AUTH (verified 2026-08-05): in `--output-format stream-json` mode the CLI
emits a `control_request` with subtype `oauth_token_refresh` and expects the HOST to
answer it over the control channel. A bare piped `claude -p` has no responder, so an
EXPIRED access token is never refreshed and every turn returns a result event with
`is_error: true, api_error_status: 401`. Run this from a context where the CLI can
self-refresh (a valid refresh token), or the result-error branch below will raise.
"""

import json
import os
import platform
import re
import shutil
import subprocess
import threading
from dataclasses import dataclass
from typing import Iterator, Optional


_SECRET_ENV_RE = re.compile(r"(_KEY|_SECRET|_TOKEN|_TOKEN_DIR|PASSWORD|APIKEY)$", re.IGNORECASE)


class ClaudeCliError(RuntimeError):
    pass


def _resolve_claude_bin() -> str:
    # shutil.which() already checks PATHEXT (.exe/.cmd) on Windows, unlike a bare
    # subprocess.Popen(["claude"], shell=False) call, so no manual path guessing needed.
    override = os.environ.get("CLAUDE_BIN")
    if override:
        return override

    found = shutil.which("claude")
    if found:
        return found

    if platform.system() == "Windows":
        appdata = os.environ.get("APPDATA", "")
        candidate = os.path.join(
            appdata, "npm", "node_modules",
            "@anthropic-ai", "claude-code", "bin",
            "claude.exe",
        )
        if os.path.isfile(candidate):
            return candidate

    raise ClaudeCliError(
        "claude CLI not found on PATH - install Claude Code, or set CLAUDE_BIN."
    )


def _child_env() -> dict:
    # The CLI authenticates from its own stored session, never from env vars - this
    # strip is defense-in-depth in case a parent process env ever carries a real key.
    return {k: v for k, v in os.environ.items() if not _SECRET_ENV_RE.search(k)}


@dataclass
class ClaudeResult:
    text: str
    usage: Optional[dict] = None


def _run_turn(
    prompt: str,
    *,
    model: Optional[str] = None,
    allowed_tools: Optional[list] = None,
    timeout: float = 120.0,
) -> Iterator[dict]:
    """Spawns one `claude -p` turn, yields each parsed stream-json event.

    Shared engine behind stream_claude() and call_claude() below.
    """
    args = [
        _resolve_claude_bin(),
        "-p",
        "--output-format", "stream-json",  # required for streaming events
        "--verbose",                        # required by stream-json in -p mode
        "--include-partial-messages",       # drives real token-by-token deltas
        "--no-session-persistence",
    ]
    if model:
        args += ["--model", model]
    for t in allowed_tools or []:
        args += ["--allowed-tools", t]

    proc = subprocess.Popen(
        args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",   # locale codec (e.g. cp1252 on Windows) breaks on emoji
        errors="replace",
        env=_child_env(),
        shell=False,  # prompt content must never be shell-interpreted
    )

    # Drain stderr concurrently: --verbose can emit more than a pipe buffer's worth,
    # and an undrained stderr pipe blocks the child, which stalls stdout - a deadlock
    # the watchdog would misreport as a timeout.
    stderr_chunks: list = []

    def _drain_stderr():
        try:
            for ln in proc.stderr:
                stderr_chunks.append(ln)
        except ValueError:
            pass  # pipe closed under us during shutdown

    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_thread.start()

    killed_for_timeout = threading.Event()

    def watchdog():
        killed_for_timeout.set()
        proc.terminate()
        try:
            if proc.wait(timeout=2) is None:
                proc.kill()
        except subprocess.TimeoutExpired:
            proc.kill()

    timer = threading.Timer(timeout, watchdog)
    timer.start()

    saw_result = False  # a `result` event means the turn reported its own outcome
    closed_early = False  # consumer abandoned us (e.g. raised on an error result)

    try:
        proc.stdin.write(prompt)
        proc.stdin.close()

        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue  # non-JSON noise on stdout - ignore, don't crash the turn
            if event.get("type") == "result":
                saw_result = True
            yield event
    except GeneratorExit:
        # The consumer closed us mid-stream (raised on an error result, or a
        # streaming UI stopped reading). Kill the child now: without this the
        # finally-wait below blocks close() until the CLI finishes the whole turn.
        closed_early = True
        proc.terminate()
        raise
    finally:
        timer.cancel()
        try:
            code = proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            code = proc.wait()
        stderr_thread.join(timeout=2)
        for pipe in (proc.stdin, proc.stdout, proc.stderr):
            try:
                if pipe:
                    pipe.close()
            except OSError:
                pass

        # closed_early guard: never raise a new exception out of generator close().
        if killed_for_timeout.is_set() and not closed_early:
            raise ClaudeCliError(f"claude turn timed out after {timeout}s")

        # A nonzero exit is only worth raising when the turn produced NO result event
        # to explain itself and the consumer didn't already bail on one. When a result
        # event was seen, its is_error/api_error_status is the authoritative signal
        # (handled by the caller) - re-raising the bare exit code here would mask it.
        if code != 0 and not saw_result and not closed_early:
            stderr = "".join(stderr_chunks).strip()
            is_auth_err = re.search(
                r"not logged in|login|auth|credential|permission|unauthorized",
                stderr, re.I,
            )
            hint = " - run `claude auth login` to re-authenticate" if is_auth_err else ""
            raise ClaudeCliError(f"claude exited (code {code}): {stderr[:400]}{hint}")


def _delta_text(event: dict) -> Optional[str]:
    """Pull a streamed text delta out of a stream_event, if present.

    stream-json + --include-partial-messages wraps Anthropic streaming events as
    {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":...}}}.
    Verify the exact shape against a SUCCESSFUL run (`claude -p "hi" --output-format
    stream-json --verbose --include-partial-messages`) before trusting deltas - a 401
    result never streams, so the delta path can only be confirmed on a 200.
    """
    if event.get("type") != "stream_event":
        return None
    inner = event.get("event", {})
    if inner.get("type") != "content_block_delta":
        return None
    return inner.get("delta", {}).get("text")


def _raise_if_result_error(event: dict) -> None:
    """A result event with is_error/api_error_status is an API failure (e.g. a 401
    token-expired) that arrives on stdout with exit code 0 - it must NOT be returned
    to the caller as if it were normal assistant text."""
    if event.get("type") == "result" and event.get("is_error"):
        status = event.get("api_error_status")
        msg = event.get("result", "") if isinstance(event.get("result"), str) else ""
        auth = status == 401 or re.search(r"auth|expired|log ?in|credential", msg, re.I)
        hint = " - token expired; re-run `claude auth login` (or launch from a host that refreshes it)" if auth else ""
        raise ClaudeCliError(f"claude API error {status}: {msg[:400]}{hint}")


def stream_claude(prompt: str, **kwargs) -> Iterator[str]:
    """Yields text deltas as they stream in - for live-typing UIs."""
    for event in _run_turn(prompt, **kwargs):
        _raise_if_result_error(event)
        text = _delta_text(event)
        if text:
            yield text


def call_claude(prompt: str, **kwargs) -> ClaudeResult:
    """Collects the full reply + usage. Falls back to the result event's text
    if no partial deltas ever arrived (matches server.mjs's fallback).

    Raises ClaudeCliError on an API-error result (e.g. 401) instead of returning
    the error string as if it were a reply."""
    acc, usage, streamed = "", None, False

    for event in _run_turn(prompt, **kwargs):
        _raise_if_result_error(event)  # 401/API errors raise, never masquerade as text

        text = _delta_text(event)
        if text:
            acc += text
            streamed = True
        elif event.get("type") == "result":
            usage = event.get("usage")
            if isinstance(event.get("result"), str) and not streamed:
                acc = event["result"]

    return ClaudeResult(text=acc, usage=usage)
