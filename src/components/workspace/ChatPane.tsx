import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "framer-motion";
import { Send, Loader2, Bot, User, AlertTriangle, Zap, Check, FileEdit } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import { PermissionGate } from "../PermissionGate";
import { ModelTierPicker } from "./ModelTierPicker";
import { loadTier, saveTier, type ModelTier } from "../../lib/modelTiers";
import type { CommandRequest, CommandResult, CommandType } from "../../data/types";

export interface Msg {
  role: "user" | "assistant";
  content: string;
}

// ── shared runtime-token (same-origin via vite), cached ──────────────────────
let tokenPromise: Promise<string> | null = null;
function runtimeToken(): Promise<string> {
  if (!tokenPromise) {
    tokenPromise = fetch("/api/runtime-token", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { token: "" }))
      .then((j) => (j as { token?: string }).token ?? "")
      .catch(() => "");
  }
  return tokenPromise;
}

interface Directive {
  type: CommandType;
  target: string;
  body: string;
}
const VALID_VERBS = new Set<CommandType>(["task", "ack", "respawn"]);
function parseDispatch(content: string): { clean: string; directives: Directive[] } {
  const m = /```dispatch\s*\n([\s\S]*?)```/.exec(content);
  if (!m) return { clean: content, directives: [] };
  const directives: Directive[] = [];
  for (const raw of m[1].split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const verb = parts[0] as CommandType;
    const target = parts[1] || "";
    const body = parts.slice(2).join(" ");
    if (VALID_VERBS.has(verb) && /^[a-z0-9_-]{1,64}$/i.test(target)) {
      directives.push({ type: verb, target, body });
    }
  }
  return { clean: content.replace(m[0], "").trim(), directives };
}

interface ProposedChange {
  path: string;
  status: "new" | "modified";
  before: string | null;
  after: string;
}

// ChatPane — the PRIMARY center chat (ADR-023 / chat-first-ux §1). One component
// drives every thread: the Boss/CEO thread (dispatch bridge + F3 gate) and each
// agent thread (F2b sandbox-changes bridge). Model tier is per-thread (ADR-022),
// sent as {model} on every /chat + /run. Messages are CONTROLLED by the shell so
// history survives thread switches; the runtime persists them to disk too.

export function ChatPane({
  threadId,
  title,
  subtitle,
  accent,
  isBoss,
  messages,
  setMessages,
  onCommand,
  headerExtra,
}: {
  threadId: string;
  title: string;
  subtitle: string;
  accent: string; // token name for this thread's identity
  isBoss: boolean;
  messages: Msg[];
  setMessages: (updater: (prev: Msg[]) => Msg[]) => void;
  onCommand: (cmd: CommandRequest) => Promise<CommandResult>;
  headerExtra?: ReactNode;
}) {
  const reduce = useReducedMotion();
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [mode, setMode] = useState("");
  const [err, setErr] = useState("");
  const [tier, setTier] = useState<ModelTier>(() => loadTier(threadId));
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Boss dispatch bridge state.
  const [gateForMsg, setGateForMsg] = useState<number | null>(null);
  const [fired, setFired] = useState<Set<number>>(new Set());
  const [dispatchMsg, setDispatchMsg] = useState("");
  // Agent F2b changes state.
  const [changes, setChanges] = useState<ProposedChange[]>([]);
  const [gateApply, setGateApply] = useState(false);
  const [applyMsg, setApplyMsg] = useState("");

  const accentColor = tok(accent);

  // Reload per-thread tier + reset transient state when the active thread changes.
  useEffect(() => {
    setTier(loadTier(threadId));
    setInput("");
    setErr("");
    setStreaming(false);
    setFired(new Set());
    setGateForMsg(null);
    setDispatchMsg("");
    setChanges([]);
    setApplyMsg("");
    inputRef.current?.focus();
    if (!isBoss) void fetchChanges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, isBoss]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [messages, reduce]);

  const changeTier = (t: ModelTier) => {
    setTier(t);
    saveTier(threadId, t);
  };

  const fetchChanges = useCallback(async () => {
    try {
      const token = await runtimeToken();
      const res = await fetch(`/runtime/${encodeURIComponent(threadId)}/changes`, {
        cache: "no-store",
        headers: { "x-runtime-token": token },
      });
      if (!res.ok) return;
      const j = (await res.json()) as { changes?: ProposedChange[] };
      setChanges(j.changes ?? []);
    } catch {
      /* ignore */
    }
  }, [threadId]);

  const applyChanges = useCallback(async () => {
    setGateApply(false);
    try {
      const token = await runtimeToken();
      const res = await fetch(`/runtime/${encodeURIComponent(threadId)}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-runtime-token": token },
        body: JSON.stringify({ paths: changes.map((c) => c.path) }),
      });
      const j = (await res.json()) as { results?: Array<{ ok: boolean }> };
      const ok = (j.results ?? []).filter((r) => r.ok).length;
      setApplyMsg(`applied ${ok}/${changes.length} to repo`);
      setChanges([]);
      window.setTimeout(() => setApplyMsg(""), 5000);
    } catch (e) {
      setApplyMsg(`apply failed: ${(e as Error).message}`);
    }
  }, [threadId, changes]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setErr("");
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);
    setStreaming(true);
    try {
      const res = await fetch(`/runtime/${encodeURIComponent(threadId)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, model: tier }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() || "";
        for (const f of frames) {
          const ev = /event: (.+)/.exec(f)?.[1];
          const dataLine = /data: ([\s\S]*)/.exec(f)?.[1];
          if (!dataLine) continue;
          let data: unknown;
          try {
            data = JSON.parse(dataLine);
          } catch {
            continue;
          }
          if (ev === "meta") setMode((data as { mode?: string }).mode ?? "");
          else if (ev === "token") {
            const t = String(data);
            setMessages((m) => {
              const c = m.slice();
              c[c.length - 1] = { role: "assistant", content: c[c.length - 1].content + t };
              return c;
            });
          } else if (ev === "error") setErr(String(data));
        }
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setStreaming(false);
      if (!isBoss) void fetchChanges();
    }
  }, [input, streaming, threadId, tier, isBoss, setMessages, fetchChanges]);

  // Boss: directives for the message awaiting confirm.
  const gateDirectives = useMemo<Directive[]>(
    () => (gateForMsg == null ? [] : parseDispatch(messages[gateForMsg]?.content ?? "").directives),
    [gateForMsg, messages],
  );

  const fireDispatch = useCallback(async () => {
    const idx = gateForMsg;
    if (idx == null) return;
    const dirs = parseDispatch(messages[idx]?.content ?? "").directives;
    setGateForMsg(null);
    const results = await Promise.all(
      dirs.map((d) =>
        onCommand({
          type: d.type,
          target: d.target,
          issuedBy: "BOSS",
          body: d.type === "task" ? d.body || "see CEO directive" : undefined,
        }).catch((e): CommandResult => ({ ok: false, error: (e as Error).message })),
      ),
    );
    const ok = results.filter((r) => r.ok).length;
    setFired((f) => new Set(f).add(idx));
    // Autonomous loop — trigger each task agent to run in its sandbox, with the
    // BOSS thread's selected tier (allowlisted server-side).
    const token = await runtimeToken();
    const taskDirs = dirs.filter((d) => d.type === "task");
    void Promise.all(
      taskDirs.map((d) =>
        fetch(`/runtime/${encodeURIComponent(d.target)}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-runtime-token": token },
          body: JSON.stringify({ task: d.body || "see CEO directive", model: tier }),
        }).catch(() => {}),
      ),
    );
    setDispatchMsg(
      `dispatched ${ok}/${dirs.length}` +
        (taskDirs.length ? ` · ${taskDirs.length} agent(s) running — review diffs in their threads` : ""),
    );
    window.setTimeout(() => setDispatchMsg(""), 8000);
  }, [gateForMsg, messages, onCommand, tier]);

  return (
    <section role="main" aria-label="Conversation" className="grid h-full min-h-0 grid-rows-[auto_1fr_auto]" style={{ backgroundColor: tok("panel") }}>
      {/* sticky header */}
      <header className="flex items-center gap-3 border-b px-5 py-3" style={{ borderColor: tok("border") }}>
        <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: accentColor }} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold" style={{ color: tok("text") }}>{title}</div>
          <div className="truncate font-mono text-[10px] uppercase tracking-wide" style={{ color: tok("muted") }}>{subtitle}</div>
        </div>
        {mode && (
          <span
            className="rounded font-mono text-[9px] uppercase tracking-wide"
            style={{
              padding: "2px 6px",
              color: mode === "mock" ? tok("blocked-amber") : tok("done-green"),
              backgroundColor: `color-mix(in oklch, ${mode === "mock" ? tok("blocked-amber") : tok("done-green")} 12%, transparent)`,
            }}
          >
            {mode === "live" ? "live · claude" : mode === "cli" ? "live · subscription" : "mock"}
          </span>
        )}
        <ModelTierPicker value={tier} onChange={changeTier} disabled={streaming} />
        {headerExtra}
      </header>

      {/* thread (sole scroll owner) */}
      <div ref={scrollRef} className="min-h-0 overflow-y-auto px-5 py-6" style={{ overscrollBehavior: "contain" }} aria-busy={streaming}>
        <div className="mx-auto flex max-w-[760px] flex-col gap-4">
          {messages.length === 0 && (
            <div className="rounded-lg border p-4 text-[13px] leading-relaxed" style={{ borderColor: tok("border"), color: tok("muted") }}>
              {isBoss ? (
                <><span className="font-semibold" style={{ color: tok("text") }}>Talk to your CEO.</span> Give a goal, ask for strategy, or direct the swarm. The CEO thinks first-principles, brings options + a recommendation, and reports to you.</>
              ) : (
                <><span className="font-semibold" style={{ color: tok("text") }}>Message {threadId}.</span> They reply with their Claude brain; edits land in a sandbox you review before they touch the repo.</>
              )}
            </div>
          )}
          {messages.map((m, i) => {
            const isLast = i === messages.length - 1;
            const live = streaming && isLast && m.role === "assistant";
            const parsed = isBoss && m.role === "assistant" ? parseDispatch(m.content) : { clean: m.content, directives: [] as Directive[] };
            const showDispatch = isBoss && m.role === "assistant" && !live && parsed.directives.length > 0;
            return (
              <div key={i} className="flex gap-3">
                <span className="mt-0.5 shrink-0" style={{ color: m.role === "user" ? tok("accent-cyan") : accentColor }}>
                  {m.role === "user" ? <User size={15} aria-hidden /> : <Bot size={15} aria-hidden />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[9px] uppercase tracking-wide" style={{ color: tok("muted") }}>
                    {m.role === "user" ? "you" : isBoss ? "CEO" : threadId}
                  </div>
                  <div
                    className="whitespace-pre-wrap break-words text-[13px] leading-relaxed"
                    style={{ color: tok("text") }}
                    aria-live={live ? "polite" : undefined}
                  >
                    {live ? m.content : parsed.clean}
                    {live && <span className="ml-0.5 inline-block animate-pulse">▍</span>}
                  </div>

                  {showDispatch && (
                    <div className="mt-2 rounded-md p-2.5" style={{ backgroundColor: `color-mix(in oklch, ${accentColor} 8%, transparent)`, border: `1px solid color-mix(in oklch, ${accentColor} 26%, transparent)` }}>
                      <div className="mb-1.5 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: accentColor }}>
                        <Zap size={12} aria-hidden /> CEO proposes {parsed.directives.length} dispatch{parsed.directives.length === 1 ? "" : "es"}
                      </div>
                      <ul className="mb-2 space-y-1">
                        {parsed.directives.map((d, k) => (
                          <li key={k} className="font-mono text-[11px]" style={{ color: tok("text") }}>
                            <span style={{ color: accentColor }}>{d.type}</span> → {d.target}
                            {d.body ? <span style={{ color: tok("muted") }}> · {d.body}</span> : null}
                          </li>
                        ))}
                      </ul>
                      {fired.has(i) ? (
                        <span className="inline-flex items-center gap-1.5 font-mono text-[11px]" style={{ color: tok("done-green") }}>
                          <Check size={13} aria-hidden /> dispatched to swarm
                        </span>
                      ) : (
                        <button type="button" onClick={() => setGateForMsg(i)} className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold outline-none focus-visible:ring-2" style={{ color: accentColor, backgroundColor: `color-mix(in oklch, ${accentColor} 14%, transparent)`, border: `1px solid color-mix(in oklch, ${accentColor} 34%, transparent)` }}>
                          <Zap size={13} aria-hidden /> Review &amp; confirm
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {err && (
            <p role="alert" className="inline-flex items-center gap-1.5 font-mono text-[10px]" style={{ color: tok("stale-red") }}>
              <AlertTriangle size={12} aria-hidden /> {err}
            </p>
          )}

          {/* Agent F2b — proposed sandbox changes + gated apply. */}
          {!isBoss && changes.length > 0 && (
            <div className="rounded-md p-2.5" style={{ backgroundColor: `color-mix(in oklch, ${tok("blocked-amber")} 8%, transparent)`, border: `1px solid color-mix(in oklch, ${tok("blocked-amber")} 26%, transparent)` }}>
              <div className="mb-1.5 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: tok("blocked-amber") }}>
                <FileEdit size={12} aria-hidden /> {changes.length} proposed change{changes.length === 1 ? "" : "s"} (sandbox)
              </div>
              <ul className="mb-2 space-y-0.5">
                {changes.map((c) => (
                  <li key={c.path} className="font-mono text-[10px]" style={{ color: tok("text") }}>
                    <span style={{ color: c.status === "new" ? tok("done-green") : tok("accent-cyan") }}>{c.status}</span> {c.path}
                  </li>
                ))}
              </ul>
              <button type="button" onClick={() => setGateApply(true)} className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold outline-none focus-visible:ring-2" style={{ color: tok("blocked-amber"), backgroundColor: `color-mix(in oklch, ${tok("blocked-amber")} 14%, transparent)`, border: `1px solid color-mix(in oklch, ${tok("blocked-amber")} 34%, transparent)` }}>
                <FileEdit size={13} aria-hidden /> Review &amp; apply to repo
              </button>
            </div>
          )}
          {applyMsg && (
            <p className="inline-flex items-center gap-1.5 font-mono text-[10px]" style={{ color: tok("done-green") }} role="status" aria-live="polite">
              <Check size={12} aria-hidden /> {applyMsg}
            </p>
          )}
        </div>
      </div>

      {/* sticky input */}
      <div className="border-t px-5 py-3" style={{ borderColor: tok("border") }}>
        {dispatchMsg && (
          <p className="mb-1.5 inline-flex items-center gap-1.5 font-mono text-[10px]" style={{ color: tok("done-green") }} role="status" aria-live="polite">
            <Check size={12} aria-hidden /> {dispatchMsg}
          </p>
        )}
        <div className="mx-auto flex max-w-[760px] items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={isBoss ? "Message your CEO…  (Enter to send, Shift+Enter newline)" : `Message ${threadId}…  (Enter to send)`}
            rows={2}
            disabled={streaming}
            aria-label={isBoss ? "Message the CEO" : `Message ${threadId}`}
            className="w-full resize-y rounded-md border px-3 py-2 text-[13px] outline-none focus-visible:ring-2 disabled:opacity-60"
            style={{ color: tok("text"), backgroundColor: tok("bg"), borderColor: tok("border") }}
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={streaming || !input.trim()}
            aria-label="Send"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-3.5 py-2 text-[12px] font-semibold outline-none focus-visible:ring-2 disabled:cursor-default disabled:opacity-40"
            style={{ color: accentColor, backgroundColor: `color-mix(in oklch, ${accentColor} 14%, transparent)`, border: `1px solid color-mix(in oklch, ${accentColor} 34%, transparent)` }}
          >
            {streaming ? <Loader2 size={14} className={reduce ? "" : "animate-spin"} aria-hidden /> : <Send size={14} aria-hidden />}
            {streaming ? "…" : "Send"}
          </button>
        </div>
      </div>

      {/* Boss dispatch gate */}
      {isBoss && (
        <PermissionGate
          open={gateForMsg !== null}
          title="Confirm CEO dispatch"
          summary={`Fire ${gateDirectives.length} command${gateDirectives.length === 1 ? "" : "s"} to the swarm, as directed by the CEO. Each is recorded in the audit log.`}
          affected={gateDirectives.map((d) => `${d.type}→${d.target}`)}
          confirmLabel={`Dispatch ${gateDirectives.length}`}
          accent="ceo-gold"
          onConfirm={() => void fireDispatch()}
          onCancel={() => setGateForMsg(null)}
        />
      )}
      {/* Agent apply gate */}
      {!isBoss && (
        <PermissionGate
          open={gateApply}
          title={`Apply ${changes.length} change${changes.length === 1 ? "" : "s"} to the live repo`}
          summary={`${threadId} edited an isolated sandbox copy. Confirm to write these files into the real repo. Paths are re-validated server-side.`}
          affected={changes.map((c) => `${c.status}: ${c.path}`)}
          confirmLabel={`Apply ${changes.length}`}
          accent="blocked-amber"
          onConfirm={() => void applyChanges()}
          onCancel={() => setGateApply(false)}
        />
      )}
    </section>
  );
}
