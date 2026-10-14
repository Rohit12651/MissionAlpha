import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "framer-motion";
import { tok } from "../../lib/agentMeta";
import { PermissionGate } from "../PermissionGate";
import { ModesPicker } from "./ModesPicker";
import { UsageMeter, type TurnUsage } from "./UsageMeter";
import { PendingIndicator } from "./PendingIndicator";
import { QuotaChip } from "./QuotaChip";
import { MODEL_TIERS, loadTier, saveTier, type ModelTier } from "../../lib/modelTiers";
import { loadAgentModel } from "../../lib/agentModel";
import { loadCatalog, loadedCatalog, type MissionSkill, type SkillCatalog } from "../../lib/skillsCatalog";
import { runtimeToken } from "../../lib/runtimeToken";
import { runtimeUrl } from "../../lib/runtimeBase";
import { outgoingMessage, type AgentMode, type PermissionMode } from "../../lib/agentModes";
import { parseTeamBlock, teamMemberToSpec, type TeamMember } from "../../lib/teamBlock";
import { getSkills, createAgent } from "../../lib/factoryClient";
import type { CommandRequest, CommandResult, CommandType } from "../../data/types";

export interface Msg {
  role: "user" | "assistant";
  content: string;
}

// ADR-049 — client-side attachment caps (mirror agent-runtime/uploads.mjs; server
// re-validates). Instant feedback only — never the security boundary.
const ATTACH_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.pdf,.csv,.txt,.md,.xlsx,image/*";
const ATTACH_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".csv", ".txt", ".md", ".xlsx"]);
const ATTACH_MAX_FILES = 8;
const ATTACH_MAX_BYTES = 25 * 1024 * 1024;
const extLower = (n: string) => { const i = n.lastIndexOf("."); return i < 0 ? "" : n.slice(i).toLowerCase(); };
function attachKind(n: string): "image" | "pdf" | "text" {
  const e = extLower(n);
  if (e === ".pdf") return "pdf";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(e)) return "image";
  // .xlsx is converted to CSV server-side; treat as text for icon/chip purposes
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

// Strip markdown emphasis the model still emits (** __) — chat renders plain text, so the
// markers are visible junk. Mirrors the server's sanitizeReply; applied at display so even
// the live stream is clean (server sanitizes the SAVED copy for history/reload).
const stripEmphasis = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1");

// ChatPane — the PRIMARY center chat (ADR-023 / chat-first-ux §1). One component
// drives every thread: the Boss/Tech-Lead thread (dispatch bridge + F3 gate) and each
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
  // Send indicator — true from the moment the POST leaves until the FIRST token frame
  // arrives (or the turn errors/ends). Distinct from `streaming`, which stays true for
  // the whole turn.
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState("");
  const [err, setErr] = useState("");
  const [usage, setUsage] = useState<TurnUsage | null>(null); // ADR-030 usage meter
  const [tier, setTier] = useState<ModelTier>(() => loadTier(threadId));
  // MODES picker — current agent mode (cockpit-ux §6). Synced to the runtime on mount.
  const [agentMode, setAgentMode] = useState<AgentMode>("acceptEdits");
  // New-session "+" — disables the button while the DELETE round-trips.
  const [clearing, setClearing] = useState(false);
  // STOP button — AbortController for the in-flight send fetch (halts the client read).
  const abortRef = useRef<AbortController | null>(null);
  // Synchronous re-entrancy guards — React state lags a render behind, so a fast double
  // Enter / double-click could slip past a state-only check. Refs flip immediately.
  const sendingRef = useRef(false);
  const clearingRef = useRef(false);
  // MODES — once the operator picks a mode, stop letting the async mount-sync clobber it.
  const modeTouchedRef = useRef(false);
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
  // Tech-Lead-assembles-team (F6). `teamSkills` is the governed factory catalog, fetched once
  // for the boss thread — the parser drops any proposed member naming a skill outside it,
  // so the confirm card can only ever show something the server will accept.
  const [teamSkills, setTeamSkills] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [gateTeamFor, setGateTeamFor] = useState<number | null>(null);
  const [teamBuilt, setTeamBuilt] = useState<Set<number>>(new Set());
  const [teamMsg, setTeamMsg] = useState("");
  const [teamBusy, setTeamBusy] = useState(false);
  // Agent F2b changes state.
  const [changes, setChanges] = useState<ProposedChange[]>([]);
  const [gateApply, setGateApply] = useState(false);
  const [applyMsg, setApplyMsg] = useState("");

  const accentColor = tok(accent);

  // "/" skill menu (Cursor-style) — typing "/" at the start of the composer opens a
  // filterable list of MissionAlpha's own skills (prompt templates). Picking one drops
  // its prompt into the box; the BOSS edits if wanted, then sends. App-scoped, portable.
  const [skillIdx, setSkillIdx] = useState(0);
  // The catalog is a lazily-loaded chunk — fetch it the first time "/" is typed, not on
  // first paint. Until it lands the menu simply has no rows (one frame at most, cached after).
  const [catalog, setCatalog] = useState<SkillCatalog | null>(() => loadedCatalog());
  const slashQuery = input.startsWith("/") && !input.includes("\n") ? input.slice(1) : null;
  useEffect(() => {
    if (slashQuery == null || catalog) return;
    let live = true;
    void loadCatalog().then((c) => { if (live) setCatalog(c); });
    return () => { live = false; };
  }, [slashQuery, catalog]);
  const skillResults = useMemo(
    () => (slashQuery == null || !catalog ? [] : catalog.filterSkills(slashQuery)),
    [slashQuery, catalog],
  );
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
    setPending(false);
    setFired(new Set());
    setGateForMsg(null);
    setDispatchMsg("");
    setGateTeamFor(null);
    setTeamBuilt(new Set());
    setTeamMsg("");
    setChanges([]);
    setApplyMsg("");
    // No focus here: arriving on a page must not steal focus into the composer (the mockup
    // does not). Explicit asks — the palette's prefill, a skill pick, the "/" button — do.
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

  // MODES — load the runtime's current permission mode on mount (server is the source
  // of truth; the picker reflects it). The server only ever stores a PermissionMode, so
  // narrow the cast to it — "plan" is UI-only and must never arrive from the server.
  // Skip if the operator already picked a mode (don't clobber an intentional choice).
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const token = await runtimeToken();
        const r = await fetch(runtimeUrl("/runtime/config"), { headers: { "x-runtime-token": token } });
        if (!r.ok) return;
        const j = (await r.json()) as { permissionMode?: PermissionMode };
        if (live && !modeTouchedRef.current && j.permissionMode) setAgentMode(j.permissionMode);
      } catch {
        /* default stays */
      }
    })();
    return () => { live = false; };
  }, []);

  // F6 — load the governed skill catalog for team-proposal validation (boss thread only).
  useEffect(() => {
    if (!isBoss) return;
    let live = true;
    void getSkills()
      .then((d) => { if (live) setTeamSkills(new Set((d.skills ?? []).map((s) => s.id))); })
      .catch(() => { /* proposal card stays hidden until the catalog loads */ });
    return () => { live = false; };
  }, [isBoss]);

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
      const res = await fetch(runtimeUrl(`/runtime/${encodeURIComponent(threadId)}/changes`), {
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
      const res = await fetch(runtimeUrl(`/runtime/${encodeURIComponent(threadId)}/apply`), {
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
    // Re-entrancy guard is the REF, not `streaming` — state lags a render, so two fast
    // Enters could both pass a state check and clobber abortRef (first fetch un-stoppable).
    if ((!text && !files.length) || sendingRef.current) return;
    sendingRef.current = true;
    setErr("");
    setInput("");
    setAttachments([]);
    const attachLine = files.length ? `\n📎 ${files.map((f) => f.name).join(", ")}` : "";
    setMessages((m) => [...m, { role: "user", content: text + attachLine }, { role: "assistant", content: "" }]);
    setStreaming(true);
    setPending(true);
    // STOP — fresh AbortController per turn; stop() aborts the read, finally clears it.
    const controller = new AbortController();
    abortRef.current = controller;
    // MODES (plan) — message-level plan-only prefix; never changes the server perm mode.
    // Single source of truth for the wrap lives in agentModes.outgoingMessage (tested).
    const outgoing = outgoingMessage(agentMode, text);
    try {
      // multipart when files are attached (ADR-049); plain JSON otherwise (back-compat).
      const url = runtimeUrl(`/runtime/${encodeURIComponent(threadId)}/chat`);
      const res = files.length
        ? await fetch(url, {
            method: "POST",
            signal: controller.signal,
            body: (() => {
              const fd = new FormData();
              fd.append("message", outgoing);
              fd.append("model", tier);
              for (const f of files) fd.append("files", f, f.name);
              return fd; // NB: do NOT set Content-Type — browser sets the multipart boundary
            })(),
          })
        : await fetch(url, {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: outgoing, model: tier }),
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
            setPending(false); // first frame landed — swap the indicator for real text
            setMessages((m) => {
              const c = m.slice();
              c[c.length - 1] = { role: "assistant", content: c[c.length - 1].content + t };
              return c;
            });
          } else if (ev === "error") setErr(String(data));
        }
      }
    } catch (e) {
      // STOP — an AbortError is the user pressing Stop, not a real failure. Stay quiet.
      if ((e as Error).name !== "AbortError") setErr((e as Error).message);
    } finally {
      setStreaming(false);
      setPending(false);
      sendingRef.current = false;
      abortRef.current = null;
      if (!isBoss) void fetchChanges();
    }
  }, [input, attachments, threadId, tier, isBoss, agentMode, setMessages, fetchChanges]);

  // STOP — abort the client read immediately AND tell the runtime to kill the spawned
  // child (otherwise the model keeps generating and burning tokens after the UI frees).
  // /stop is auth-gated (process control), so the token header is REQUIRED, not decorative.
  const stop = useCallback(async () => {
    abortRef.current?.abort();
    setStreaming(false); // optimistic — the finally above will also run
    setPending(false);
    try {
      const token = await runtimeToken();
      await fetch(runtimeUrl(`/runtime/${encodeURIComponent(threadId)}/stop`), {
        method: "POST",
        headers: { "x-runtime-token": token },
      });
    } catch {
      /* child may already have finished — nothing to stop */
    }
  }, [threadId]);

  // New session "+" — clear this agent's history (memory + disk) and reset the meters.
  // Reuses the existing auth-gated DELETE /runtime/:id/thread (server deleteThread()).
  const handleNewSession = useCallback(async () => {
    // Ref guard (not state) so a fast double-click can't dispatch two DELETEs.
    if (streaming || clearingRef.current) return;
    const name = isBoss ? "the Tech Lead" : threadId;
    if (!window.confirm(`Clear ${name}'s conversation history?\nThis deletes the saved history and starts a fresh session. It cannot be undone.`)) return;
    clearingRef.current = true;
    setClearing(true);
    try {
      const token = await runtimeToken();
      await fetch(runtimeUrl(`/runtime/${encodeURIComponent(threadId)}/thread`), {
        method: "DELETE",
        headers: { "x-runtime-token": token },
      });
      setMessages(() => []);
      setUsage(null); // back to the zero-state meter
      setChanges([]);
      setErr("");
    } catch (e) {
      setErr(`clear failed: ${(e as Error).message}`);
    } finally {
      clearingRef.current = false;
      setClearing(false);
    }
  }, [streaming, isBoss, threadId, setMessages]);

  // STOP — ⌘. / Ctrl+. while streaming. Bound on document because the composer textarea
  // is disabled mid-stream and won't receive its own keydown.
  useEffect(() => {
    if (!streaming) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ".") { e.preventDefault(); void stop(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [streaming, stop]);

  // STOP — on unmount (panel closed mid-stream), abort the read AND tell the runtime to
  // kill the child, else the model keeps generating server-side and burns tokens with no
  // UI attached. Fire-and-forget; the component is gone, so no state updates here.
  useEffect(() => {
    return () => {
      if (!abortRef.current) return;
      abortRef.current.abort();
      void runtimeToken().then((token) =>
        fetch(runtimeUrl(`/runtime/${encodeURIComponent(threadId)}/stop`), {
          method: "POST",
          headers: { "x-runtime-token": token },
          keepalive: true, // let the kill survive the unmount/navigation
        }).catch(() => {}),
      );
    };
  }, [threadId]);

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
          body: d.type === "task" ? d.body || "see tech-lead directive" : undefined,
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
        fetch(runtimeUrl(`/runtime/${encodeURIComponent(d.target)}/run`), {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-runtime-token": token },
          body: JSON.stringify({ task: d.body || "see tech-lead directive", model: loadAgentModel(d.target) }),
        }).catch(() => {}),
      ),
    );
    setDispatchMsg(
      `dispatched ${ok}/${dirs.length}` +
        (taskDirs.length ? ` · ${taskDirs.length} agent(s) running — review diffs in their threads` : ""),
    );
    window.setTimeout(() => setDispatchMsg(""), 8000);
  }, [gateForMsg, messages, onCommand]);

  // F6 — batch-create the proposed team. Each member goes through the SAME
  // POST /factory/create the Factory uses, so validateSpec re-checks id/skills/persona
  // server-side. Partial success is reported honestly (created N of M, with the failures).
  const hireTeam = useCallback(async () => {
    const idx = gateTeamFor;
    if (idx == null) return;
    const members = parseTeamBlock(parseDispatch(messages[idx]?.content ?? "").clean, teamSkills).members;
    setGateTeamFor(null);
    if (!members.length) return;
    setTeamBusy(true);
    // The job = the BOSS turn that prompted this reply (the message just above it).
    const job = messages[idx - 1]?.role === "user" ? messages[idx - 1].content : "";
    const results = await Promise.all(
      members.map((mem) =>
        createAgent(teamMemberToSpec(mem, job))
          .then((r) => ({ id: mem.id, ok: !r.error, error: r.error }))
          .catch((e: unknown) => ({ id: mem.id, ok: false, error: (e as Error).message })),
      ),
    );
    setTeamBusy(false);
    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    if (ok.length) setTeamBuilt((s) => new Set(s).add(idx));
    setTeamMsg(
      `hired ${ok.length}/${members.length}` +
        (failed.length ? ` · failed: ${failed.map((f) => `${f.id} (${f.error || "rejected"})`).join(", ")}` : " — live on the board"),
    );
    window.setTimeout(() => setTeamMsg(""), 10000);
  }, [gateTeamFor, messages, teamSkills]);

  const gateTeamMembers = useMemo<TeamMember[]>(
    () => (gateTeamFor == null ? [] : parseTeamBlock(parseDispatch(messages[gateTeamFor]?.content ?? "").clean, teamSkills).members),
    [gateTeamFor, messages, teamSkills],
  );

  // Phase G (ADR G-2): the approved mockup's chat card — two header rows (who, usage, the
  // permission-mode segment; the model tier and the mode hint), the thread of `.bubble`s,
  // the `.composer2` form. Sizing is the mockup's: a rows=2 textarea the operator can drag
  // taller (native `resize: vertical`), replacing the old JS drag handle.
  const modeHint: Record<AgentMode, string> = {
    default: "Ask before every tool call", acceptEdits: "Auto-accept edits, ask for other tools",
    bypassPermissions: "No permission prompts", plan: "Plan only, no execution",
  };
  const whoLabel = (role: Msg["role"]) => (role === "user" ? "You (BOSS)" : isBoss ? "Tech Lead" : threadId);
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }} aria-label="Conversation" role="region">
      <div className="chat-h">
        <b id="chat-h" style={{ fontSize: ".875rem" }} title={`${title} · ${subtitle}`}>{isBoss ? "you (BOSS) → tech lead" : `you (BOSS) → ${threadId}`}</b>
        <UsageMeter usage={usage} />
        <span style={{ marginLeft: "auto" }}>
          <ModesPicker value={agentMode} onChange={(m) => { modeTouchedRef.current = true; setAgentMode(m); }} disabled={streaming} />
        </span>
      </div>
      <div className="chat-h" style={{ border: 0, paddingTop: 8 }}>
        <label className="sub" htmlFor={`chat-tier-${threadId}`}>Model tier</label>
        <select id={`chat-tier-${threadId}`} className="mini-select" value={tier} disabled={streaming} onChange={(e) => changeTier(e.target.value as ModelTier)}>
          {MODEL_TIERS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <span className="sub">{modeHint[agentMode]}</span>
        {/* APP-ONLY: transport, quota, a fresh session, and whatever the host adds. */}
        <span className="pills" data-app-only="chat-extras" style={{ marginLeft: "auto" }}>
          {mode && <span className={mode === "mock" ? "chip warn" : "chip ok"}>{mode === "live" ? "live · claude" : mode === "cli" ? "live · subscription" : "mock"}</span>}
          <QuotaChip />
          <button type="button" className="pill" onClick={() => void handleNewSession()} disabled={streaming || clearing} aria-haspopup="dialog">New session</button>
          {headerExtra}
        </span>
      </div>

      <div ref={scrollRef} className="chat-thread" aria-live="polite" aria-busy={streaming}>
        {messages.length === 0 && (
          <div className="bubble">
            <span className="who">{whoLabel("assistant")} <span className="ai-tag">AI agent</span></span>
            <div className="txt">{isBoss
              ? "I'm the Tech Lead. Tell me what you want built and I'll turn it into a job. The CEO reads it before anything moves."
              : `Message ${threadId}. Edits land in a sandbox you review before they touch the repo.`}</div>
          </div>
        )}
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1;
          const live = streaming && isLast && m.role === "assistant";
          const parsed = isBoss && m.role === "assistant" ? parseDispatch(m.content) : { clean: m.content, directives: [] as Directive[] };
          const team = isBoss && m.role === "assistant" && !live ? parseTeamBlock(parsed.clean, teamSkills) : { clean: parsed.clean, members: [] as TeamMember[] };
          const showDispatch = isBoss && m.role === "assistant" && !live && parsed.directives.length > 0;
          const showTeam = isBoss && m.role === "assistant" && !live && team.members.length > 0;
          return (
            <div key={i} className={m.role === "user" ? "bubble me" : "bubble"}>
              <span className="who">{whoLabel(m.role)}{m.role === "user" ? null : <> <span className="ai-tag">AI agent</span></>}</span>
              <div className="txt" aria-live={live ? "polite" : undefined}>
                {live && pending && !m.content ? <PendingIndicator accent={accentColor} /> : (
                  <>{live ? stripEmphasis(m.content) : stripEmphasis(team.clean)}{live && <span className="ml-0.5 inline-block animate-pulse">▍</span>}</>
                )}
              </div>
              {showDispatch && (
                <div className="propose">
                  <span className="sub">{`Proposal · ${parsed.directives.length} dispatch${parsed.directives.length === 1 ? "" : "es"}`}</span>
                  <ul className="list" style={{ gap: 2 }}>
                    {parsed.directives.map((d, k) => <li key={k} className="mono" style={{ fontSize: ".75rem" }}>{`${d.type} → ${d.target}${d.body ? ` · ${d.body}` : ""}`}</li>)}
                  </ul>
                  {fired.has(i) ? <span className="sub" role="status">dispatched to swarm</span> : (
                    <div className="row"><button className="btn btn-primary" type="button" style={{ minHeight: 38, padding: "8px 18px" }} onClick={() => setGateForMsg(i)}>Review &amp; confirm</button></div>
                  )}
                </div>
              )}
              {showTeam && (
                <div className="propose">
                  <span className="sub">{`Proposal · a team of ${team.members.length}`}</span>
                  <ul className="list" style={{ gap: 2 }}>
                    {team.members.map((t) => <li key={t.id} className="mono" style={{ fontSize: ".75rem" }}>{`${t.id} · ${t.role}${t.skills.length ? ` · ${t.skills.join(", ")}` : ""}`}</li>)}
                  </ul>
                  {teamBuilt.has(i) ? <span className="sub" role="status">team created, live on the board</span> : (
                    <div className="row"><button className="btn btn-primary" type="button" style={{ minHeight: 38, padding: "8px 18px" }} disabled={teamBusy} onClick={() => setGateTeamFor(i)}>Review &amp; hire team</button></div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {err && <p className="sub" role="alert" style={{ color: "var(--bad-ink)", margin: 0 }}>{err}</p>}
        {/* Agent F2b — proposed sandbox changes + gated apply. */}
        {!isBoss && changes.length > 0 && (
          <div className="propose">
            <span className="sub">{`${changes.length} proposed change${changes.length === 1 ? "" : "s"} (sandbox)`}</span>
            <ul className="list" style={{ gap: 2 }}>{changes.map((c) => <li key={c.path} className="mono" style={{ fontSize: ".75rem" }}>{`${c.status} ${c.path}`}</li>)}</ul>
            <div className="row"><button className="btn btn-primary" type="button" style={{ minHeight: 38, padding: "8px 18px" }} onClick={() => setGateApply(true)}>Review &amp; apply to repo</button></div>
          </div>
        )}
        {applyMsg && <p className="sub" role="status" aria-live="polite" style={{ margin: 0 }}>{applyMsg}</p>}
      </div>

      {(dispatchMsg || teamMsg) && <p className="sub" role="status" aria-live="polite" style={{ margin: "0 0 6px" }}>{dispatchMsg || teamMsg}</p>}
      {/* "/" skill menu — opens above the composer. */}
      {slashOpen && (
        <div role="listbox" aria-label="Skills" className="card" style={{ padding: 0, marginBottom: 8, maxHeight: 256, overflowY: "auto" }}>
          {skillResults.map((sk, i) => {
            const showHeader = i === 0 || skillResults[i - 1].kind !== sk.kind;
            return (
              <Fragment key={sk.id}>
                {showHeader && <p className="sub" style={{ margin: 0, padding: "6px 12px" }}>{catalog?.KIND_LABEL[sk.kind] ?? sk.kind}</p>}
                <button type="button" role="option" aria-selected={i === skillIdx} onMouseEnter={() => setSkillIdx(i)} onClick={() => pickSkill(sk)}
                  className="r-row" style={{ width: "100%", padding: "8px 12px", gridTemplateColumns: "auto minmax(0,1fr)", background: i === skillIdx ? "var(--indigo-10)" : "transparent" }}>
                  <b className="mono">{sk.title}</b><small>{sk.hint}</small>
                </button>
              </Fragment>
            );
          })}
          <p className="sub" style={{ margin: 0, padding: "6px 12px" }}>↑↓ pick · Enter insert · Esc close</p>
        </div>
      )}
      {/* ADR-049 — staged attachments (APP-ONLY: the mockup composer has no attach). */}
      {attachments.length > 0 && (
        <div className="pills" aria-label="Attachments" data-app-only="attachments" style={{ marginBottom: 8 }}>
          {attachments.map((f, i) => (
            <span key={`${f.name}-${f.size}-${i}`} className="chip">
              {`${attachKind(f.name)} · ${f.name} · ${fmtBytes(f.size)}`}
              <button type="button" className="linkish" onClick={() => removeAttachment(i)} aria-label={`Remove ${f.name}`}>×</button>
            </span>
          ))}
        </div>
      )}
      <input ref={fileRef} type="file" multiple accept={ATTACH_ACCEPT} className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
      <form
        className="composer2"
        autoComplete="off"
        onSubmit={(e) => { e.preventDefault(); void send(); }}
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer?.files); }}
      >
        <button className="iconbtn" type="button" aria-label="Insert a skill" disabled={streaming}
          onClick={() => { setInput((v) => (v.startsWith("/") ? v : `/${v}`)); inputRef.current?.focus(); }}>/</button>
        <div style={{ position: "relative" }}>
          <label className="sr" htmlFor={`chat-in-${threadId}`}>{isBoss ? "Message the tech lead" : `Message ${threadId}`}</label>
          <textarea
            ref={inputRef}
            id={`chat-in-${threadId}`}
            rows={2}
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
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
            }}
            placeholder={isBoss ? "Tell the tech lead what you want. Type / for skills." : `Message ${threadId}. Type / for skills.`}
            disabled={streaming}
          />
        </div>
        {streaming ? (
          <button className="iconbtn" type="button" onClick={() => void stop()} aria-label="Stop generation" aria-description="Keyboard shortcut: Command or Control period"
            style={{ background: "var(--bad-ink)", color: "var(--color-pure-white)", borderColor: "var(--bad-ink)" }}>■</button>
        ) : (
          <button className="iconbtn" type="submit" aria-label="Send" disabled={!input.trim() && attachments.length === 0}
            style={{ background: "var(--brand)", color: "#fff", borderColor: "var(--brand)" }}>
            <svg width="18" height="18" aria-hidden="true"><use href="#i-send" /></svg>
          </button>
        )}
      </form>
      {/* APP-ONLY: attach files (image · pdf · csv · txt) through the same composer. */}
      <div className="row" data-app-only="attach" style={{ marginTop: 6, gap: 8 }}>
        <button type="button" className="linkish" disabled={streaming || attachments.length >= ATTACH_MAX_FILES} onClick={() => fileRef.current?.click()}>Attach files</button>
        <span className="sub">{`drag & drop or paste · png jpg pdf csv txt · max ${ATTACH_MAX_FILES} files · 25 MB each`}</span>
      </div>

      {/* Boss dispatch gate */}
      {isBoss && (
        <PermissionGate
          open={gateForMsg !== null}
          title="Confirm Tech Lead dispatch"
          summary={`Fire ${gateDirectives.length} command${gateDirectives.length === 1 ? "" : "s"} to the swarm, as directed by the Tech Lead. Each is recorded in the audit log.`}
          affected={gateDirectives.map((d) => `${d.type}→${d.target}`)}
          confirmLabel={`Dispatch ${gateDirectives.length}`}
          accent="ceo-gold"
          onConfirm={() => void fireDispatch()}
          onCancel={() => setGateForMsg(null)}
        />
      )}
      {/* Tech Lead team-hire gate (F3) */}
      {isBoss && (
        <PermissionGate
          open={gateTeamFor !== null}
          title={`Hire ${gateTeamMembers.length} agent${gateTeamMembers.length === 1 ? "" : "s"}?`}
          summary={`Creates ${gateTeamMembers.length} new agent${gateTeamMembers.length === 1 ? "" : "s"} in the factory registry, each live on the board with a BOSS badge. Every spec is re-validated server-side; none can post externally.`}
          affected={gateTeamMembers.map((t) => `${t.id} — ${t.role}${t.skills.length ? ` (${t.skills.join(", ")})` : ""}`)}
          confirmLabel={teamBusy ? "Hiring…" : `Hire ${gateTeamMembers.length}`}
          accent="factory-violet"
          onConfirm={() => void hireTeam()}
          onCancel={() => setGateTeamFor(null)}
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
    </div>
  );
}
