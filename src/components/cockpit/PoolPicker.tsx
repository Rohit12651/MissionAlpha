import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Users, Search, X, Check, ShieldHalf, Sparkles, ListChecks, Loader2, Square } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import { runtimeUrl } from "../../lib/runtimeBase";
import { runtimeToken } from "../../lib/runtimeToken";

// Pool agent as returned by GET /factory/pool (persona elided to a preview).
interface PoolAgent {
  id: string;
  role: string;
  tools: "read" | "write";
  personaPreview: string;
  imported: boolean;
}
type Mode = "pool" | "ceo";

// PoolPicker — "Add agents to the board". Two modes:
//   • Pull from pool — pick N of the .claude/agents/*.md → POST /factory/pool/import.
//   • Let CEO assemble — describe the job → CEO recommends ids → pre-selects them.
// Importing binds the agent's persona + pins it on the board. No new tool/exec capability.
export function PoolPicker({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const [mode, setMode] = useState<Mode>("pool");
  const [pool, setPool] = useState<PoolAgent[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ceoTask, setCeoTask] = useState("");
  const [ceoThinking, setCeoThinking] = useState(false);
  const [ceoNote, setCeoNote] = useState("");
  const firstRef = useRef<HTMLInputElement | null>(null);
  const importingRef = useRef(false); // synchronous re-entrancy guard (state lags a render)
  const askingRef = useRef(false);
  const ceoAbortRef = useRef<AbortController | null>(null);

  const loadPool = useCallback(async () => {
    setErr("");
    try {
      const r = await fetch(runtimeUrl("/factory/pool"), { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { pool?: unknown };
      // Validate the shape — never trust the wire (a numeric id would crash .includes()).
      const raw = Array.isArray(j.pool) ? j.pool : [];
      setPool(raw.filter(isPoolAgent));
    } catch {
      setErr("Could not load the agent pool — is the runtime up?");
    }
  }, []);

  useEffect(() => { if (open) { void loadPool(); setSel(new Set()); setQ(""); setCeoNote(""); } }, [open, loadPool]);
  useEffect(() => { if (open) firstRef.current?.focus(); }, [open]);
  // Document-level Escape so it closes even if focus drifts outside the dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? pool.filter((a) => a.id.includes(s) || a.role.toLowerCase().includes(s)) : pool;
  }, [pool, q]);

  const toggle = (id: string) => setSel((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectable = (a: PoolAgent) => !a.imported;
  const pickable = filtered.filter(selectable).map((a) => a.id);

  const doImport = useCallback(async () => {
    const ids = [...sel];
    if (!ids.length || importingRef.current) return;
    importingRef.current = true;
    setBusy(true); setErr("");
    try {
      const token = await runtimeToken();
      const r = await fetch(runtimeUrl("/factory/pool/import"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-runtime-token": token },
        body: JSON.stringify({ ids }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      onImported();
      onClose();
    } catch (e) {
      setErr(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      importingRef.current = false;
      setBusy(false);
    }
  }, [sel, onImported, onClose]);

  // Assemble — ask the Tech Lead which pool roles the task needs; pre-select its picks.
  const askCeo = useCallback(async () => {
    const task = ceoTask.trim();
    if (!task || askingRef.current) return;
    askingRef.current = true;
    setCeoThinking(true); setCeoNote(""); setErr("");
    const ids = pool.map((a) => a.id).join(", ");
    const prompt =
      `TEAM PICK ONLY. Task: "${task}". Available agent ids: [${ids}]. ` +
      `Reply with ONLY a JSON array of the ids needed for this task, e.g. ["architect","senior-web-1"]. No prose.`;
    const controller = new AbortController();
    ceoAbortRef.current = controller;
    try {
      const res = await fetch(runtimeUrl("/runtime/boss/chat"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: prompt, model: "sonnet" }),
        signal: controller.signal,
      });
      const text = await readStream(res);
      const picked = parseIds(text, new Set(pool.map((a) => a.id)));
      if (picked.length) {
        setMode("pool");
        setSel(new Set(picked));
        setCeoNote(`CEO picked ${picked.length}: ${picked.join(", ")} — review + import.`);
      } else {
        setCeoNote("CEO returned no matching ids — pick manually.");
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setErr("Tech Lead recommendation failed — pick manually.");
    } finally {
      askingRef.current = false;
      ceoAbortRef.current = null;
      setCeoThinking(false);
    }
  }, [ceoTask, pool]);

  // Stop the assemble call mid-think: abort the read + kill the boss child.
  const stopCeo = useCallback(async () => {
    ceoAbortRef.current?.abort();
    setCeoThinking(false);
    setCeoNote("Stopped.");
    try {
      const token = await runtimeToken();
      await fetch(runtimeUrl("/runtime/boss/stop"), { method: "POST", headers: { "x-runtime-token": token } });
    } catch { /* may already be done */ }
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-6" style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      role="dialog" aria-modal="true" aria-label="Add agents to the board"
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <div className="w-full max-w-[560px] overflow-hidden rounded-xl border shadow-2xl"
        style={{ backgroundColor: tok("panel"), borderColor: tok("border") }}>
        {/* header + tabs */}
        <div className="border-b px-4 py-3" style={{ borderColor: tok("border") }}>
          <div className="flex items-center gap-2">
            <Users size={17} aria-hidden style={{ color: tok("accent-cyan") }} />
            <span className="text-[14px] font-semibold" style={{ color: tok("text") }}>Add agents to the board</span>
            <button onClick={onClose} aria-label="Close" className="ml-auto rounded p-1 outline-none hover:bg-panel-2 focus-visible:ring-2" style={{ color: tok("muted") }}>
              <X size={16} aria-hidden />
            </button>
          </div>
          <div className="mt-2.5 flex gap-1" role="tablist" aria-label="Mode">
            <Tab active={mode === "pool"} onClick={() => setMode("pool")} icon={<ListChecks size={12} />}>Pull from pool</Tab>
            <Tab active={mode === "ceo"} onClick={() => setMode("ceo")} icon={<Sparkles size={12} />}>Let the Tech Lead assemble</Tab>
          </div>
        </div>

        {mode === "ceo" && (
          <div className="border-b px-4 py-3" style={{ borderColor: tok("border") }}>
            <label className="mb-1.5 block text-[11px]" style={{ color: tok("muted") }}>Describe the job — the Tech Lead picks the team</label>
            <div className="flex gap-2">
              <input value={ceoTask} onChange={(e) => setCeoTask(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void askCeo(); }}
                placeholder="e.g. ship auth + payments for the mobile app"
                className="min-w-0 flex-1 rounded-md border px-3 py-2 text-[12px] outline-none focus-visible:ring-2"
                style={{ color: tok("text"), backgroundColor: tok("bg"), borderColor: tok("border") }} />
              {ceoThinking ? (
                <button onClick={() => void stopCeo()}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-[12px] font-semibold text-white outline-none transition-transform focus-visible:ring-2 active:scale-95"
                  style={{ backgroundColor: tok("stale-red") }} aria-label="Stop the Tech Lead">
                  <Square size={11} fill="currentColor" aria-hidden /> Stop
                </button>
              ) : (
                <button onClick={() => void askCeo()} disabled={!ceoTask.trim()}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-[12px] font-semibold outline-none focus-visible:ring-2 disabled:opacity-40"
                  style={{ color: tok("ceo-gold"), backgroundColor: `color-mix(in oklch, ${tok("ceo-gold")} 14%, transparent)`, border: `1px solid color-mix(in oklch, ${tok("ceo-gold")} 34%, transparent)` }}>
                  <Sparkles size={13} aria-hidden /> Ask Tech Lead
                </button>
              )}
            </div>
            {/* Phase D — Claude-style loading while the Tech Lead assembles the team. */}
            {ceoThinking && (
              <div className="mt-2 inline-flex items-center gap-2 text-[11px]" style={{ color: tok("ceo-gold") }} role="status" aria-live="polite">
                <ThinkingDots />
                <span>Tech Lead is assembling the team…</span>
              </div>
            )}
            {!ceoThinking && ceoNote && <p className="mt-2 text-[11px]" style={{ color: tok("done-green") }}>{ceoNote}</p>}
          </div>
        )}

        {/* search */}
        <div className="px-4 pb-1.5 pt-3">
          <div className="flex items-center gap-2 rounded-md px-2.5 py-1.5" style={{ backgroundColor: tok("panel-2") }}>
            <Search size={14} aria-hidden style={{ color: tok("muted") }} />
            <input ref={firstRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${pool.length} pool agents…`}
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none" style={{ color: tok("text") }} aria-label="Search agents" />
            <span className="shrink-0 text-[10px]" style={{ color: tok("muted") }}>{sel.size} selected</span>
            {pickable.length > 0 && (
              <button onClick={() => setSel((p) => p.size >= pickable.length ? new Set() : new Set(pickable))}
                className="shrink-0 rounded px-1.5 py-0.5 text-[10px] outline-none hover:bg-bg focus-visible:ring-2" style={{ color: tok("accent-cyan") }}>
                {sel.size >= pickable.length ? "none" : "all"}
              </button>
            )}
          </div>
        </div>

        {/* rows */}
        <div className="max-h-[280px] overflow-y-auto px-2 pb-2">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-[11px]" style={{ color: tok("muted") }}>No agents match.</p>
          ) : filtered.map((a) => {
            const checked = sel.has(a.id);
            const accent = a.tools === "write" ? tok("ceo-gold") : tok("accent-cyan");
            return (
              <button key={a.id} type="button" disabled={a.imported} onClick={() => toggle(a.id)}
                aria-pressed={checked}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-panel-2/60 focus-visible:ring-2 disabled:opacity-60"
                style={{ backgroundColor: checked ? `color-mix(in oklch, ${tok("accent-cyan")} 12%, transparent)` : "transparent" }}>
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded"
                  style={{ border: `1.5px solid ${checked ? tok("accent-cyan") : tok("border")}`, backgroundColor: checked ? tok("accent-cyan") : "transparent" }}>
                  {checked && <Check size={11} color="#fff" aria-hidden />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium" style={{ color: tok("text") }}>{a.id}</span>
                  <span className="block truncate text-[10px]" style={{ color: tok("muted") }}>{a.role}</span>
                </span>
                <span className="shrink-0 rounded font-mono text-[8px] uppercase tracking-wide" style={{ padding: "1px 6px", color: accent, backgroundColor: `color-mix(in oklch, ${accent} 14%, transparent)` }}>{a.tools}</span>
                {a.imported && <span className="inline-flex shrink-0 items-center gap-1 text-[9px]" style={{ color: tok("done-green") }}><Check size={11} aria-hidden />live</span>}
              </button>
            );
          })}
        </div>

        {/* footer */}
        <div className="flex items-center gap-3 border-t px-4 py-3" style={{ borderColor: tok("border") }}>
          <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: tok("muted") }}>
            <ShieldHalf size={13} aria-hidden /> Bash stripped · Write→sandbox
          </span>
          {err && <span role="alert" className="truncate text-[11px]" style={{ color: tok("stale-red") }}>{err}</span>}
          <button onClick={() => void doImport()} disabled={!sel.size || busy}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-[12px] font-semibold outline-none focus-visible:ring-2 disabled:opacity-40"
            style={{ color: "#fff", backgroundColor: tok("accent-cyan") }}>
            {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Check size={13} aria-hidden />}
            Import {sel.size || ""} agent{sel.size === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Claude-style 3-dot thinking indicator — staggered bounce, static under reduced-motion.
function ThinkingDots() {
  return (
    <span className="inline-flex gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1.5 w-1.5 rounded-full animate-bounce motion-reduce:animate-none"
          style={{ backgroundColor: "currentColor", animationDelay: `${i * 0.15}s` }} />
      ))}
    </span>
  );
}

function Tab({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button role="tab" aria-selected={active} onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium outline-none focus-visible:ring-2"
      style={{ color: active ? tok("text") : tok("muted"), backgroundColor: active ? tok("panel-2") : "transparent" }}>
      {icon}{children}
    </button>
  );
}

// Runtime shape guard for a pool agent (never trust the wire).
function isPoolAgent(x: unknown): x is PoolAgent {
  const a = x as Record<string, unknown> | null;
  return !!a && typeof a.id === "string" && typeof a.role === "string"
    && (a.tools === "read" || a.tools === "write");
}

// Read an SSE token stream into the full assistant text. Throws on non-2xx so the caller
// doesn't mistake an auth/error body for an empty CEO reply. Always releases the lock.
async function readStream(res: Response): Promise<string> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", out = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split("\n\n"); buf = frames.pop() || "";
      for (const f of frames) {
        const ev = /event: (.+)/.exec(f)?.[1];
        const data = /data: ([\s\S]*)/.exec(f)?.[1];
        if (ev === "token" && data) { try { out += String(JSON.parse(data)); } catch { /* skip malformed frame */ } }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return out;
}

// Parse a JSON-ish id array from the Tech Lead reply, keep only real pool ids.
function parseIds(text: string, valid: Set<string>): string[] {
  const m = /\[[\s\S]*?\]/.exec(text);
  let arr: unknown[] = [];
  if (m) { try { arr = JSON.parse(m[0]); } catch { /* */ } }
  const ids = (Array.isArray(arr) ? arr : []).map((x) => String(x).toLowerCase().trim());
  return [...new Set(ids)].filter((id) => valid.has(id));
}
