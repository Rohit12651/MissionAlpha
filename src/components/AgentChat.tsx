import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { Send, Loader2, Bot, User, Sparkles, AlertTriangle, FileEdit, Check } from "lucide-react";
import { tok } from "../lib/agentMeta";
import { PermissionGate } from "./PermissionGate";
import { runtimeToken, runtimeUrl } from "../lib/runtimeBase";

interface ProposedChange {
  path: string;
  status: "new" | "modified";
  before: string | null;
  after: string;
}

// Track B / F1 — streaming chat with an agent's Claude brain. Talks to the SEPARATE
// agent-runtime service over /runtime/:id/chat (vite-proxied). Reads the SSE stream
// token-by-token so replies type in live. Phase 1 = chat-only (runtime has NO tools).
// OKLCH tokens; reduced-motion safe; thread persists in component state per open.

interface Msg {
  role: "user" | "assistant";
  content: string;
}

export function AgentChat({ agentId }: { agentId: string }) {
  const reduce = useReducedMotion();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [mode, setMode] = useState<string>("");
  const [err, setErr] = useState<string>("");
  // F2b — proposed changes (sandbox diff) + gated apply.
  const [changes, setChanges] = useState<ProposedChange[]>([]);
  const [gateOpen, setGateOpen] = useState(false);
  const [applyMsg, setApplyMsg] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const fetchChanges = useCallback(async () => {
    try {
      const token = await runtimeToken();
      const res = await fetch(runtimeUrl(`/runtime/${encodeURIComponent(agentId)}/changes`), {
        cache: "no-store",
        headers: { "x-runtime-token": token },
      });
      if (!res.ok) return;
      const j = (await res.json()) as { changes?: ProposedChange[] };
      setChanges(j.changes ?? []);
    } catch {
      /* ignore */
    }
  }, [agentId]);

  const applyChanges = useCallback(async () => {
    setGateOpen(false);
    try {
      const token = await runtimeToken();
      const res = await fetch(runtimeUrl(`/runtime/${encodeURIComponent(agentId)}/apply`), {
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
  }, [agentId, changes]);

  // Reset thread when the drawer switches agents.
  useEffect(() => {
    setMsgs([]);
    setInput("");
    setErr("");
    setStreaming(false);
    setChanges([]);
    setApplyMsg("");
    void fetchChanges();
  }, [agentId, fetchChanges]);

  // Keep the latest message in view.
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
      const res = await fetch(runtimeUrl(`/runtime/${encodeURIComponent(agentId)}/chat`), {
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
      // Parse SSE frames: "event: <name>\ndata: <json>\n\n"
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
          if (ev === "meta") {
            setMode((data as { mode?: string }).mode ?? "");
          } else if (ev === "token") {
            const t = String(data);
            setMsgs((m) => {
              const copy = m.slice();
              copy[copy.length - 1] = {
                role: "assistant",
                content: copy[copy.length - 1].content + t,
              };
              return copy;
            });
          } else if (ev === "error") {
            setErr(String(data));
          }
        }
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setStreaming(false);
      void fetchChanges(); // surface any sandbox edits the agent just made
    }
  }, [agentId, input, streaming, fetchChanges]);

  const cyan = tok("accent-cyan");
  const gold = tok("ceo-gold");

  return (
    <div className="mt-4 border-t border-border/40 pt-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
          <Sparkles size={12} aria-hidden /> Chat with {agentId}
        </p>
        {mode && (
          <span
            className="rounded font-mono text-[9px] uppercase tracking-wide"
            style={{
              padding: "1px 6px",
              color: mode === "mock" ? tok("blocked-amber") : tok("done-green"),
              backgroundColor: `color-mix(in oklch, ${mode === "mock" ? tok("blocked-amber") : tok("done-green")} 12%, transparent)`,
            }}
          >
            {mode === "live" ? "live · claude" : mode === "cli" ? "live · subscription" : "mock · no key"}
          </span>
        )}
      </div>

      {/* thread */}
      {msgs.length > 0 && (
        <div
          ref={scrollRef}
          className="mb-2 max-h-60 space-y-2 overflow-y-auto rounded-md border border-border/50 bg-bg/40 p-2.5"
        >
          {msgs.map((m, i) => (
            <div key={i} className="flex gap-2">
              <span className="mt-0.5 shrink-0" style={{ color: m.role === "user" ? cyan : gold }}>
                {m.role === "user" ? <User size={12} aria-hidden /> : <Bot size={12} aria-hidden />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[9px] uppercase tracking-wide text-muted">
                  {m.role === "user" ? "you" : agentId}
                </div>
                <div className="whitespace-pre-wrap break-words text-[12px] leading-snug text-text/90">
                  {m.content}
                  {streaming && i === msgs.length - 1 && m.role === "assistant" && (
                    <span className="ml-0.5 inline-block animate-pulse">▍</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {err && (
        <p className="mb-2 inline-flex items-center gap-1.5 font-mono text-[10px]" style={{ color: tok("stale-red") }}>
          <AlertTriangle size={12} aria-hidden /> {err}
        </p>
      )}

      {/* F2b — proposed changes (sandbox) + gated apply to live repo */}
      {changes.length > 0 && (
        <div
          className="mb-2 rounded-md p-2.5"
          style={{
            backgroundColor: `color-mix(in oklch, ${tok("blocked-amber")} 8%, transparent)`,
            border: `1px solid color-mix(in oklch, ${tok("blocked-amber")} 26%, transparent)`,
          }}
        >
          <div className="mb-1.5 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: tok("blocked-amber") }}>
            <FileEdit size={12} aria-hidden /> {changes.length} proposed change{changes.length === 1 ? "" : "s"} (sandbox)
          </div>
          <ul className="mb-2 space-y-0.5">
            {changes.map((c) => (
              <li key={c.path} className="font-mono text-[10px] text-text/85">
                <span style={{ color: c.status === "new" ? tok("done-green") : tok("accent-cyan") }}>{c.status}</span> {c.path}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setGateOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold outline-none focus-visible:ring-2"
            style={{
              color: tok("blocked-amber"),
              backgroundColor: `color-mix(in oklch, ${tok("blocked-amber")} 14%, transparent)`,
              border: `1px solid color-mix(in oklch, ${tok("blocked-amber")} 34%, transparent)`,
            }}
          >
            <FileEdit size={13} aria-hidden /> Review &amp; apply to repo
          </button>
        </div>
      )}
      {applyMsg && (
        <p className="mb-2 inline-flex items-center gap-1.5 font-mono text-[10px]" style={{ color: tok("done-green") }} role="status" aria-live="polite">
          <Check size={12} aria-hidden /> {applyMsg}
        </p>
      )}

      {/* input */}
      <div className="flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={`Message ${agentId}… (Enter to send)`}
          rows={2}
          disabled={streaming}
          aria-label={`Message ${agentId}`}
          className="w-full resize-y rounded-md border border-border/60 bg-bg/60 px-2.5 py-2 font-mono text-[11px] text-text/85 outline-none placeholder:text-muted/50 focus-visible:ring-2 disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={streaming || !input.trim()}
          aria-label="Send message"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-[11px] font-semibold outline-none focus-visible:ring-2 disabled:cursor-default disabled:opacity-40"
          style={{
            color: cyan,
            backgroundColor: `color-mix(in oklch, ${cyan} 12%, transparent)`,
            border: `1px solid color-mix(in oklch, ${cyan} 30%, transparent)`,
          }}
        >
          {streaming ? <Loader2 size={13} className={reduce ? "" : "animate-spin"} aria-hidden /> : <Send size={13} aria-hidden />}
          {streaming ? "…" : "Send"}
        </button>
      </div>

      {/* F3 gate — confirm before sandbox edits land in the live repo */}
      <PermissionGate
        open={gateOpen}
        title={`Apply ${changes.length} change${changes.length === 1 ? "" : "s"} to the live repo`}
        summary={`${agentId} edited an isolated sandbox copy. Confirm to write these files into the real repo. Paths are re-validated server-side.`}
        affected={changes.map((c) => `${c.status}: ${c.path}`)}
        confirmLabel={`Apply ${changes.length}`}
        accent="blocked-amber"
        onConfirm={() => void applyChanges()}
        onCancel={() => setGateOpen(false)}
      />
    </div>
  );
}
