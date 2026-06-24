import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Crown, Send, Loader2, X, Bot, User, AlertTriangle, Zap, Check } from "lucide-react";
import { tok } from "../lib/agentMeta";
import { PermissionGate } from "./PermissionGate";
import type { CommandRequest, CommandResult, CommandType } from "../data/types";
import { runtimeToken, runtimeUrl } from "../lib/runtimeBase";

// A single CEO-proposed dispatch directive parsed from a ```dispatch``` block.
interface Directive {
  type: CommandType;
  target: string;
  body: string;
}
const VALID_VERBS = new Set<CommandType>(["task", "ack", "respawn"]);

// Pull the ```dispatch``` block out of a CEO reply. Returns the prose (block
// stripped) + the parsed directives. Lines: "<verb> <agent-id> <rest...>".
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
  const clean = content.replace(m[0], "").trim();
  return { clean, directives };
}

// Boss Console — the GLOBAL chat. Rohit (BOSS) sits ABOVE the CEO. A persistent,
// top-level slide-over you reach from anywhere in the app: BOSS talks → CEO (the
// supreme agent) answers in strategic prose, streaming live. Talks to the SEPARATE
// agent-runtime over /runtime/boss/chat (CEO persona). Mock now, real Claude w/ key.
// Distinct CEO-gold identity. OKLCH tokens; reduced-motion; per-session thread.
// Phase 1 = conversation. Dispatch-to-agents bridge = follow-up.

interface Msg {
  role: "user" | "assistant";
  content: string;
}

export function BossConsole({
  open,
  onOpenChange,
  onCommand,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Fire a confirmed dispatch to the swarm (write channel). */
  onCommand: (cmd: CommandRequest) => Promise<CommandResult>;
}) {
  const reduce = useReducedMotion();
  const setOpen = onOpenChange;
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [mode, setMode] = useState("");
  const [err, setErr] = useState("");
  // Dispatch bridge: which message's dispatch is pending confirm, and which fired.
  const [gateForMsg, setGateForMsg] = useState<number | null>(null);
  const [fired, setFired] = useState<Set<number>>(new Set());
  const [dispatchMsg, setDispatchMsg] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [msgs, reduce]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setErr("");
    setInput("");
    setMsgs((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);
    setStreaming(true);
    try {
      const res = await fetch(runtimeUrl("/runtime/boss/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
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
            setMsgs((m) => {
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
    }
  }, [input, streaming]);

  // Directives for the message currently awaiting confirm (gate target).
  const gateDirectives = useMemo<Directive[]>(
    () => (gateForMsg == null ? [] : parseDispatch(msgs[gateForMsg]?.content ?? "").directives),
    [gateForMsg, msgs],
  );

  // BOSS confirmed → fire every directive to the swarm via the write channel.
  const fireDispatch = useCallback(async () => {
    const idx = gateForMsg;
    if (idx == null) return;
    const dirs = parseDispatch(msgs[idx]?.content ?? "").directives;
    setGateForMsg(null);
    // 1) record the directive on the bus (INBOX/audit) via the command channel.
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
    // 2) AUTONOMOUS LOOP — for each task directive, trigger the agent to actually
    //    DO the work in its sandbox (write-mode run). Diff surfaces in that agent's
    //    drawer for operator review+apply. Fire-and-forget; runs stream server-side.
    const token = await runtimeToken();
    const taskDirs = dirs.filter((d) => d.type === "task");
    void Promise.all(
      taskDirs.map((d) =>
        fetch(runtimeUrl(`/runtime/${encodeURIComponent(d.target)}/run`), {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-runtime-token": token },
          body: JSON.stringify({ task: d.body || "see CEO directive" }),
        }).catch(() => {}),
      ),
    );
    setDispatchMsg(
      `dispatched ${ok}/${dirs.length}` +
        (taskDirs.length ? ` · ${taskDirs.length} agent(s) running — review diffs in their drawers` : ""),
    );
    window.setTimeout(() => setDispatchMsg(""), 8000);
  }, [gateForMsg, msgs, onCommand]);

  const gold = tok("ceo-gold");

  return (
    <>
      {/* reopen rail — shown only when the dock is collapsed */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open Boss console"
          className="fixed left-4 top-4 z-40 inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[12px] font-semibold shadow-lg outline-none backdrop-blur-md focus-visible:ring-2"
          style={{
            color: gold,
            backgroundColor: `color-mix(in oklch, ${gold} 16%, var(--c-panel))`,
            border: `1px solid color-mix(in oklch, ${gold} 40%, transparent)`,
            boxShadow: `0 0 24px -8px ${gold}`,
          }}
        >
          <Crown size={15} aria-hidden /> BOSS
        </button>
      )}

      <AnimatePresence>
        {open && (
          <>
            {/* persistent LEFT dock — like the chat pane in Claude. No backdrop;
                the board reserves left space (App adds left padding when open). */}
            <motion.aside
              aria-label="Boss console — chat with the CEO"
              className="fixed inset-y-0 left-0 z-40 flex w-full max-w-[380px] flex-col border-r border-border bg-panel/95 backdrop-blur-md"
              style={{ boxShadow: `8px 0 40px -12px ${gold}` }}
              initial={{ x: reduce ? 0 : "-100%", opacity: reduce ? 0 : 1 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: reduce ? 0 : "-100%", opacity: reduce ? 0 : 1 }}
              transition={{ duration: reduce ? 0 : 0.24, ease: "easeOut" }}
            >
              {/* header */}
              <div className="flex items-center gap-2.5 border-b border-border/60 px-4 py-3">
                <span style={{ color: gold }}>
                  <Crown size={18} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold text-text">Boss Console</div>
                  <div className="font-mono text-[10px] uppercase tracking-wide text-muted">
                    you (BOSS) → CEO · supreme over swarm
                  </div>
                </div>
                {mode && (
                  <span
                    className="rounded font-mono text-[9px] uppercase tracking-wide"
                    style={{
                      padding: "1px 6px",
                      color: mode === "mock" ? tok("blocked-amber") : tok("done-green"),
                      backgroundColor: `color-mix(in oklch, ${mode === "mock" ? tok("blocked-amber") : tok("done-green")} 12%, transparent)`,
                    }}
                  >
                    {mode === "live" ? "live · claude" : mode === "cli" ? "live · subscription" : "mock"}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="rounded-md p-1 text-muted outline-none transition-colors hover:text-text focus-visible:ring-2"
                >
                  <X size={16} aria-hidden />
                </button>
              </div>

              {/* thread */}
              <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
                {msgs.length === 0 && (
                  <div className="rounded-lg border border-border/50 bg-bg/30 p-4 text-[12px] leading-relaxed text-muted">
                    <span className="font-semibold text-text">Talk to your CEO.</span> Give a goal,
                    ask for strategy, or direct the swarm. The CEO thinks first-principles, brings
                    options + a recommendation, and reports to you.
                  </div>
                )}
                {msgs.map((m, i) => {
                  const isLast = i === msgs.length - 1;
                  const live = streaming && isLast && m.role === "assistant";
                  const parsed = m.role === "assistant" ? parseDispatch(m.content) : { clean: m.content, directives: [] };
                  const showDispatch = m.role === "assistant" && !live && parsed.directives.length > 0;
                  return (
                    <div key={i} className="flex gap-2.5">
                      <span className="mt-0.5 shrink-0" style={{ color: m.role === "user" ? tok("accent-cyan") : gold }}>
                        {m.role === "user" ? <User size={14} aria-hidden /> : <Bot size={14} aria-hidden />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-[9px] uppercase tracking-wide text-muted">
                          {m.role === "user" ? "BOSS (you)" : "CEO"}
                        </div>
                        <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-text/90">
                          {live ? m.content : parsed.clean}
                          {live && <span className="ml-0.5 inline-block animate-pulse">▍</span>}
                        </div>

                        {/* dispatch bridge — CEO proposed commands; BOSS confirms (F3 gate). */}
                        {showDispatch && (
                          <div
                            className="mt-2 rounded-md p-2.5"
                            style={{
                              backgroundColor: `color-mix(in oklch, ${gold} 8%, transparent)`,
                              border: `1px solid color-mix(in oklch, ${gold} 26%, transparent)`,
                            }}
                          >
                            <div className="mb-1.5 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: gold }}>
                              <Zap size={12} aria-hidden /> CEO proposes {parsed.directives.length} dispatch{parsed.directives.length === 1 ? "" : "es"}
                            </div>
                            <ul className="mb-2 space-y-1">
                              {parsed.directives.map((d, k) => (
                                <li key={k} className="font-mono text-[11px] text-text/85">
                                  <span style={{ color: gold }}>{d.type}</span> → {d.target}
                                  {d.body ? <span className="text-muted"> · {d.body}</span> : null}
                                </li>
                              ))}
                            </ul>
                            {fired.has(i) ? (
                              <span className="inline-flex items-center gap-1.5 font-mono text-[11px]" style={{ color: tok("done-green") }}>
                                <Check size={13} aria-hidden /> dispatched to swarm
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setGateForMsg(i)}
                                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold outline-none focus-visible:ring-2"
                                style={{
                                  color: gold,
                                  backgroundColor: `color-mix(in oklch, ${gold} 14%, transparent)`,
                                  border: `1px solid color-mix(in oklch, ${gold} 34%, transparent)`,
                                }}
                              >
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
                  <p className="inline-flex items-center gap-1.5 font-mono text-[10px]" style={{ color: tok("stale-red") }}>
                    <AlertTriangle size={12} aria-hidden /> {err}
                  </p>
                )}
              </div>

              {/* input */}
              <div className="border-t border-border/60 px-4 py-3">
                {dispatchMsg && (
                  <p className="mb-1.5 inline-flex items-center gap-1.5 font-mono text-[10px]" style={{ color: tok("done-green") }} role="status" aria-live="polite">
                    <Check size={12} aria-hidden /> {dispatchMsg}
                  </p>
                )}
                <div className="flex items-end gap-2">
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
                    placeholder="Message your CEO… (Enter to send, Shift+Enter newline)"
                    rows={2}
                    disabled={streaming}
                    aria-label="Message the CEO"
                    className="w-full resize-y rounded-md border border-border/60 bg-bg/60 px-3 py-2 text-[12px] text-text/90 outline-none placeholder:text-muted/50 focus-visible:ring-2 disabled:opacity-60"
                  />
                  <button
                    type="button"
                    onClick={() => void send()}
                    disabled={streaming || !input.trim()}
                    aria-label="Send to CEO"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-3.5 py-2 text-[12px] font-semibold outline-none focus-visible:ring-2 disabled:cursor-default disabled:opacity-40"
                    style={{
                      color: gold,
                      backgroundColor: `color-mix(in oklch, ${gold} 14%, transparent)`,
                      border: `1px solid color-mix(in oklch, ${gold} 34%, transparent)`,
                    }}
                  >
                    {streaming ? <Loader2 size={14} className={reduce ? "" : "animate-spin"} aria-hidden /> : <Send size={14} aria-hidden />}
                    {streaming ? "…" : "Send"}
                  </button>
                </div>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* F3 gate — BOSS confirms the CEO-proposed dispatch before anything fires. */}
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
    </>
  );
}
