import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "framer-motion";
import { Send, Loader2, Bot, User, AlertTriangle, Zap, Check, FileEdit, Paperclip, X, FileText, Image as ImageIcon, Table, Plus } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import { PermissionGate } from "../PermissionGate";
import { ModelTierPicker } from "./ModelTierPicker";
import { UsageMeter, type TurnUsage } from "./UsageMeter";
import { QuotaChip } from "./QuotaChip";
import { loadTier, saveTier, type ModelTier } from "../../lib/modelTiers";
import { loadAgentModel } from "../../lib/agentModel";
import { filterSkills, KIND_LABEL, type MissionSkill } from "../../lib/missionSkills";
import { runtimeToken } from "../../lib/runtimeToken";
import type { CommandRequest, CommandResult, CommandType } from "../../data/types";

export interface Msg {
  role: "user" | "assistant";
  content: string;
}

// ADR-049 — client-side attachment caps (mirror agent-runtime/uploads.mjs; server
// re-validates). Instant feedback only — never the security boundary.
const ATTACH_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.pdf,.csv,.txt,.md,image/*";
const ATTACH_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".csv", ".txt", ".md"]);
const ATTACH_MAX_FILES = 8;
const ATTACH_MAX_BYTES = 25 * 1024 * 1024;
const extLower = (n: string) => { const i = n.lastIndexOf("."); return i < 0 ? "" : n.slice(i).toLowerCase(); };
function attachKind(n: string): "image" | "pdf" | "text" {
  const e = extLower(n);
  if (e === ".pdf") return "pdf";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(e)) return "image";
  return "text";
}
const fmtBytes = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);

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
  prefill,
  tierReloadKey,
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
  // Externally-driven input prefill (onboarding "try a goal" / palette "dispatch a goal").
  prefill?: { text: string; nonce: number };
  // Bumped by the palette's "switch model" so the picker reflects the new tier (S4).
  tierReloadKey?: number;
}) {
  const reduce = useReducedMotion();
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [mode, setMode] = useState("");
  const [err, setErr] = useState("");
  const [usage, setUsage] = useState<TurnUsage | null>(null); // ADR-030 usage meter
  const [tier, setTier] = useState<ModelTier>(() => loadTier(threadId));
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // ADR-049 chat attachments (images/pdf/csv/txt). Mirror the server caps client-side
  // for instant feedback; the server re-validates everything (type/size/count) anyway.
  const [attachments, setAttachments] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // "+" add-menu (Attach lives here, like the Claude composer). Closes on outside click / Esc.
  const [plusOpen, setPlusOpen] = useState(false);
  const plusRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!plusOpen) return;
    const onDown = (e: PointerEvent) => { if (plusRef.current && !plusRef.current.contains(e.target as Node)) setPlusOpen(false); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setPlusOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onEsc); };
  }, [plusOpen]);

  // Boss dispatch bridge state.
  const [gateForMsg, setGateForMsg] = useState<number | null>(null);
  const [fired, setFired] = useState<Set<number>>(new Set());
  const [dispatchMsg, setDispatchMsg] = useState("");
  // Agent F2b changes state.
  const [changes, setChanges] = useState<ProposedChange[]>([]);
  const [gateApply, setGateApply] = useState(false);
  const [applyMsg, setApplyMsg] = useState("");

  const accentColor = tok(accent);

  // "/" skill menu (Cursor-style) — typing "/" at the start of the composer opens a
  // filterable list of MissionAlpha's own skills (prompt templates). Picking one drops
  // its prompt into the box; the BOSS edits if wanted, then sends. App-scoped, portable.
  const [skillIdx, setSkillIdx] = useState(0);
  const slashQuery = input.startsWith("/") && !input.includes("\n") ? input.slice(1) : null;
  const skillResults = useMemo(() => (slashQuery == null ? [] : filterSkills(slashQuery)), [slashQuery]);
  const slashOpen = slashQuery !== null && skillResults.length > 0 && !streaming;
  useEffect(() => { setSkillIdx(0); }, [slashQuery]);
  const pickSkill = (s: MissionSkill) => {
    setInput(s.prompt);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // ADR-049 — stage attachments (file picker / drag-drop / paste). Validates against
  // the mirrored caps and dedupes by name+size; server re-validates on send.
  const addFiles = useCallback((list: FileList | null | undefined) => {
    if (!list || !list.length) return;
    setErr("");
    setAttachments((cur) => {
      const next = [...cur];
      for (const f of Array.from(list)) {
        if (next.length >= ATTACH_MAX_FILES) { setErr(`max ${ATTACH_MAX_FILES} files`); break; }
        if (!ATTACH_EXTS.has(extLower(f.name))) { setErr(`unsupported type: ${f.name}`); continue; }
        if (f.size > ATTACH_MAX_BYTES) { setErr(`${f.name} too large (max 25 MB)`); continue; }
        if (next.some((x) => x.name === f.name && x.size === f.size)) continue;
        next.push(f);
      }
      return next;
    });
  }, []);
  const removeAttachment = useCallback((i: number) => setAttachments((c) => c.filter((_, j) => j !== i)), []);

  // Reload per-thread tier + reset transient state when the active thread changes.
  useEffect(() => {
    setTier(loadTier(threadId));
    setInput("");
    setAttachments([]);
    setErr("");
    setUsage(null);
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

  // External prefill — onboarding "try a goal" and palette "dispatch a goal" push
  // text into the composer (keyed by nonce so the same text can be re-pushed). An
  // empty goal still focuses the composer so "Dispatch a goal" is never a no-op.
  useEffect(() => {
    if (prefill && prefill.nonce > 0) {
      if (prefill.text) setInput(prefill.text);
      inputRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce]);

  // External tier reload — palette "switch model" wrote saveTier(); re-read it so
  // the picker + outgoing {model} reflect the change without a thread switch.
  useEffect(() => {
    if (tierReloadKey != null) setTier(loadTier(threadId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tierReloadKey]);

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
    const files = attachments;
    if ((!text && !files.length) || streaming) return;
    setErr("");
    setInput("");
    setAttachments([]);
    const attachLine = files.length ? `\n📎 ${files.map((f) => f.name).join(", ")}` : "";
    setMessages((m) => [...m, { role: "user", content: text + attachLine }, { role: "assistant", content: "" }]);
    setStreaming(true);
    try {
      // multipart when files are attached (ADR-049); plain JSON otherwise (back-compat).
      const url = `/runtime/${encodeURIComponent(threadId)}/chat`;
      const res = files.length
        ? await fetch(url, {
            method: "POST",
            body: (() => {
              const fd = new FormData();
              fd.append("message", text);
              fd.append("model", tier);
              for (const f of files) fd.append("files", f, f.name);
              return fd; // NB: do NOT set Content-Type — browser sets the multipart boundary
            })(),
          })
        : await fetch(url, {
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
          else if (ev === "usage") setUsage(data as TurnUsage); // ADR-030 — tokens + context%, no $
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
  }, [input, attachments, streaming, threadId, tier, isBoss, setMessages, fetchChanges]);

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
    // Autonomous loop — trigger each task agent to run in its sandbox on ITS OWN
    // chosen model (set per agent in the inspect drawer; falls back to the configured
    // default). Tier is allowlisted server-side.
    const token = await runtimeToken();
    const taskDirs = dirs.filter((d) => d.type === "task");
    void Promise.all(
      taskDirs.map((d) =>
        fetch(`/runtime/${encodeURIComponent(d.target)}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-runtime-token": token },
          body: JSON.stringify({ task: d.body || "see CEO directive", model: loadAgentModel(d.target) }),
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
        <UsageMeter usage={usage} />
        <QuotaChip />
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
        <div className="relative mx-auto max-w-[760px]">
          {/* "/" skill menu — opens above the composer */}
          {slashOpen && (
            <div role="listbox" aria-label="Skills" className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-md border border-border bg-panel shadow-2xl">
              <div className="border-b border-border px-3 py-1.5 text-[9px] font-medium uppercase tracking-wide text-muted">MissionAlpha skills · {skillResults.length}</div>
              <div className="max-h-64 overflow-y-auto">
                {skillResults.map((s, i) => {
                  const showHeader = i === 0 || skillResults[i - 1].kind !== s.kind;
                  return (
                    <Fragment key={s.id}>
                      {showHeader && (
                        <div className="sticky top-0 bg-panel px-3 py-1 text-[9px] font-medium uppercase tracking-wide text-muted">
                          {KIND_LABEL[s.kind]}
                        </div>
                      )}
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === skillIdx}
                        onMouseEnter={() => setSkillIdx(i)}
                        onClick={() => pickSkill(s)}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-left outline-none"
                        style={{ backgroundColor: i === skillIdx ? `color-mix(in oklch, ${accentColor} 14%, transparent)` : "transparent" }}
                      >
                        <span className="shrink-0 font-mono text-[12px] font-medium" style={{ color: accentColor }}>{s.title}</span>
                        <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{s.hint}</span>
                      </button>
                    </Fragment>
                  );
                })}
              </div>
              <div className="border-t border-border px-3 py-1 text-[9px] text-muted">↑↓ pick · Enter insert · Esc close</div>
            </div>
          )}
          {/* ADR-049 — staged attachment chips */}
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Attachments">
              {attachments.map((f, i) => {
                const k = attachKind(f.name);
                const Icon = k === "image" ? ImageIcon : k === "pdf" ? FileText : Table;
                return (
                  <span
                    key={`${f.name}-${f.size}-${i}`}
                    className="inline-flex items-center gap-1.5 rounded-md border py-1 pl-2 pr-1 text-[11px]"
                    style={{ borderColor: tok("border"), backgroundColor: tok("bg"), color: tok("text") }}
                  >
                    <Icon size={13} aria-hidden style={{ color: accentColor }} />
                    <span className="max-w-[160px] truncate font-medium">{f.name}</span>
                    <span className="text-muted">{fmtBytes(f.size)}</span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(i)}
                      aria-label={`Remove ${f.name}`}
                      className="ml-0.5 rounded p-0.5 text-muted outline-none hover:text-[inherit] focus-visible:ring-2"
                    >
                      <X size={12} aria-hidden />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ATTACH_ACCEPT}
            className="hidden"
            onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
          />
          <div
            className="flex items-end gap-2"
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer?.files); }}
          >
          <div ref={plusRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setPlusOpen((o) => !o)}
              disabled={streaming}
              aria-label="Add"
              aria-haspopup="menu"
              aria-expanded={plusOpen}
              title="Add"
              className="inline-flex h-[38px] w-[38px] items-center justify-center rounded-md border outline-none transition-colors focus-visible:ring-2 disabled:opacity-40"
              style={{ color: tok("text"), backgroundColor: tok("bg"), borderColor: tok("border") }}
            >
              <Plus size={16} aria-hidden className="transition-transform" style={{ transform: plusOpen ? "rotate(45deg)" : "none" }} />
            </button>
            {plusOpen && (
              <div
                role="menu"
                className="absolute bottom-[46px] left-0 z-30 min-w-[200px] overflow-hidden rounded-lg border py-1"
                style={{ backgroundColor: tok("panel"), borderColor: tok("border"), boxShadow: "0 8px 24px -8px rgba(0,0,0,0.45)" }}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setPlusOpen(false); fileRef.current?.click(); }}
                  disabled={attachments.length >= ATTACH_MAX_FILES}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] outline-none transition-colors hover:bg-panel-2 focus-visible:bg-panel-2 disabled:opacity-40"
                  style={{ color: tok("text") }}
                >
                  <Paperclip size={15} aria-hidden style={{ color: tok("muted") }} />
                  <span className="flex-1">Attach files</span>
                  <span className="text-[10px]" style={{ color: tok("muted") }}>image · pdf · csv · txt</span>
                </button>
              </div>
            )}
          </div>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => { if (e.clipboardData?.files?.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
            onKeyDown={(e) => {
              if (slashOpen) {
                if (e.key === "ArrowDown") { e.preventDefault(); setSkillIdx((i) => (i + 1) % skillResults.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setSkillIdx((i) => (i - 1 + skillResults.length) % skillResults.length); return; }
                if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSkill(skillResults[skillIdx]); return; }
                if (e.key === "Escape") { e.preventDefault(); setInput(""); return; }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={isBoss ? "Message your CEO…  (Enter to send · / for skills)" : `Message ${threadId}…  (Enter to send)`}
            rows={2}
            disabled={streaming}
            aria-label={isBoss ? "Message the CEO" : `Message ${threadId}`}
            className="w-full resize-y rounded-md border px-3 py-2 text-[13px] outline-none focus-visible:ring-2 disabled:opacity-60"
            style={{ color: tok("text"), backgroundColor: tok("bg"), borderColor: tok("border") }}
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={streaming || (!input.trim() && attachments.length === 0)}
            aria-label="Send"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-3.5 py-2 text-[12px] font-semibold outline-none focus-visible:ring-2 disabled:cursor-default disabled:opacity-40"
            style={{ color: accentColor, backgroundColor: `color-mix(in oklch, ${accentColor} 14%, transparent)`, border: `1px solid color-mix(in oklch, ${accentColor} 34%, transparent)` }}
          >
            {streaming ? <Loader2 size={14} className={reduce ? "" : "animate-spin"} aria-hidden /> : <Send size={14} aria-hidden />}
            {streaming ? "…" : "Send"}
          </button>
          </div>
          <div className="mt-1 px-0.5 text-[10px] text-muted">
            drag &amp; drop or paste · png jpg pdf csv txt · max {ATTACH_MAX_FILES} files · 25 MB each
          </div>
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
