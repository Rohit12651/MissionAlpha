import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Sparkles, Loader2, Wand2, Check, RotateCcw, Trash2, ChevronDown, Send, Wrench, Plug, AlertTriangle } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import { authorAgent, createAgent, type AgentSpec, type Skill } from "../../lib/factoryClient";

// Surface 1 — Create-Agent flow. A console flow (NOT a stacked form): describe →
// Claude authors (streamed reasoning) → editable SPEC REVIEW CARD → confirm.
// Only the BOSS reaches this; the server validates every spec again on create.

type Phase = "describe" | "authoring" | "review";

export function CreateAgentFlow({
  skills,
  onCreated,
  onClose,
}: {
  skills: Skill[];
  onCreated: (spec: AgentSpec) => void;
  onClose: () => void;
}) {
  const reduce = useReducedMotion();
  const violet = tok("factory-violet");
  const gold = tok("ceo-gold");

  const [phase, setPhase] = useState<Phase>("describe");
  const [desc, setDesc] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [spec, setSpec] = useState<AgentSpec | null>(null);
  const [err, setErr] = useState("");
  const [personaOpen, setPersonaOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const reasonRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    reasonRef.current?.scrollTo({ top: reasonRef.current.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [reasoning, reduce]);

  const skillLabel = useCallback((id: string) => skills.find((s) => s.id === id)?.label ?? id, [skills]);
  const canPost = !!spec && spec.integrations.length > 0;

  const runAuthor = useCallback(async () => {
    const d = desc.trim();
    if (!d) return;
    setErr("");
    setReasoning("");
    setSpec(null);
    setPhase("authoring");
    const result = await authorAgent(d, (t) => setReasoning((r) => r + t));
    if (result.error || !result.spec) {
      setErr(result.error || "authoring failed");
      setPhase("describe");
      return;
    }
    setSpec(result.spec);
    setPhase("review");
  }, [desc]);

  const confirmCreate = useCallback(async () => {
    if (!spec) return;
    setCreating(true);
    setErr("");
    const r = await createAgent({
      id: spec.id,
      role: spec.role,
      title: spec.title,
      persona: spec.persona,
      skills: spec.skills,
      tools: spec.tools,
      integrations: spec.integrations,
    });
    setCreating(false);
    if (r.error || !r.spec) {
      setErr(r.error || "create failed");
      return;
    }
    onCreated(r.spec);
  }, [spec, onCreated]);

  const chip = (label: string, accent: string) => (
    <span
      key={label}
      className="rounded font-mono text-[10px]"
      style={{
        padding: "2px 7px",
        color: accent,
        backgroundColor: `color-mix(in oklch, ${accent} 10%, transparent)`,
        border: `1px solid color-mix(in oklch, ${accent} 24%, transparent)`,
      }}
    >
      {label}
    </span>
  );

  return (
    <div className="rounded-lg border p-4" style={{ borderColor: `color-mix(in oklch, ${violet} 34%, var(--c-border))`, backgroundColor: `color-mix(in oklch, ${violet} 5%, transparent)` }}>
      <div className="mb-3 flex items-center justify-between">
        <p className="inline-flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide" style={{ color: violet }}>
          <Wand2 size={13} aria-hidden /> New Agent — describe what it should do
        </p>
        <button type="button" onClick={onClose} aria-label="Close create flow" className="rounded-md px-2 py-1 text-[11px] text-muted outline-none hover:text-text focus-visible:ring-2">
          Close
        </button>
      </div>

      {/* describe */}
      {phase === "describe" && (
        <>
          <textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void runAuthor();
              }
            }}
            rows={3}
            autoFocus
            placeholder="e.g. A growth marketer that drafts punchy launch posts for X and LinkedIn and proposes them for my approval."
            aria-label="Describe the agent"
            className="w-full resize-y rounded-md border border-border/60 bg-bg/60 px-3 py-2.5 text-[13px] leading-relaxed text-text/90 outline-none placeholder:text-muted/50 focus-visible:ring-2"
          />
          <div className="mt-2.5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => void runAuthor()}
              disabled={!desc.trim()}
              className="inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-[12px] font-semibold outline-none focus-visible:ring-2 disabled:cursor-default disabled:opacity-40"
              style={{ color: violet, backgroundColor: `color-mix(in oklch, ${violet} 14%, transparent)`, border: `1px solid color-mix(in oklch, ${violet} 34%, transparent)` }}
            >
              <Sparkles size={13} aria-hidden /> Author agent
            </button>
          </div>
        </>
      )}

      {/* authoring (streamed reasoning) */}
      {phase === "authoring" && (
        <div>
          <div className="mb-2 inline-flex items-center gap-2 text-[11px] font-mono uppercase tracking-wide" style={{ color: violet }}>
            <Loader2 size={13} className={reduce ? "" : "animate-spin"} aria-hidden /> Claude is designing your agent…
          </div>
          <div ref={reasonRef} className="max-h-40 overflow-y-auto rounded-md border border-border/50 bg-bg/40 p-3 font-mono text-[11px] leading-relaxed text-text/80">
            {reasoning || "…"}
            <span className="ml-0.5 inline-block animate-pulse">▍</span>
          </div>
        </div>
      )}

      {/* spec review card */}
      {phase === "review" && spec && (
        <motion.div
          initial={{ opacity: 0, y: reduce ? 0 : 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduce ? 0 : 0.22, ease: "easeOut" }}
          className="space-y-3"
        >
          {/* identity (editable) */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-muted">Title</span>
              <input
                value={spec.title}
                onChange={(e) => setSpec({ ...spec, title: e.target.value })}
                className="w-full rounded-md border border-border/60 bg-bg/60 px-2.5 py-1.5 text-[12px] text-text/90 outline-none focus-visible:ring-2"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-muted">Role</span>
              <input
                value={spec.role}
                onChange={(e) => setSpec({ ...spec, role: e.target.value })}
                className="w-full rounded-md border border-border/60 bg-bg/60 px-2.5 py-1.5 text-[12px] text-text/90 outline-none focus-visible:ring-2"
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] text-muted">id: {spec.id}</span>
            {canPost && (
              <span className="inline-flex items-center gap-1 rounded font-mono text-[9px] font-semibold uppercase tracking-wide" style={{ padding: "1px 6px", color: gold, backgroundColor: `color-mix(in oklch, ${gold} 12%, transparent)`, border: `1px solid color-mix(in oklch, ${gold} 30%, transparent)` }}>
                <Send size={9} aria-hidden /> Can post
              </span>
            )}
          </div>

          {/* persona (collapsible) */}
          <div className="rounded-md border border-border/50 bg-bg/40">
            <button type="button" onClick={() => setPersonaOpen((v) => !v)} aria-expanded={personaOpen} className="flex w-full items-center justify-between px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted outline-none focus-visible:ring-2">
              Persona (system prompt)
              <ChevronDown size={13} className={`transition-transform ${personaOpen ? "rotate-180" : ""}`} aria-hidden />
            </button>
            {personaOpen && (
              <textarea
                value={spec.persona}
                onChange={(e) => setSpec({ ...spec, persona: e.target.value })}
                rows={5}
                className="w-full resize-y rounded-b-md border-t border-border/50 bg-bg/50 px-3 py-2 text-[11px] leading-relaxed text-text/85 outline-none focus-visible:ring-2"
              />
            )}
          </div>

          {/* capabilities */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-muted"><Sparkles size={10} aria-hidden /> Skills</span>
              {spec.skills.length ? spec.skills.map((s) => chip(skillLabel(s), violet)) : <span className="text-[10px] text-muted">none</span>}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-muted"><Wrench size={10} aria-hidden /> Tools</span>
              {spec.tools.length ? spec.tools.map((t) => chip(t, tok("muted"))) : <span className="text-[10px] text-muted">none</span>}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-muted"><Plug size={10} aria-hidden /> Integrations</span>
              {spec.integrations.length ? spec.integrations.map((i) => chip(i, tok("accent-cyan"))) : <span className="text-[10px] text-muted">none</span>}
            </div>
          </div>

          {/* actions */}
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <button type="button" onClick={() => { setPhase("describe"); setSpec(null); }} className="inline-flex items-center gap-1.5 rounded-md border border-border/70 px-3 py-1.5 text-[12px] font-medium text-muted outline-none hover:text-text focus-visible:ring-2">
              <Trash2 size={13} aria-hidden /> Discard
            </button>
            <button type="button" onClick={() => void runAuthor()} className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-medium outline-none focus-visible:ring-2" style={{ color: tok("muted"), borderColor: "var(--c-border)" }}>
              <RotateCcw size={13} aria-hidden /> Re-author
            </button>
            <button
              type="button"
              onClick={() => void confirmCreate()}
              disabled={creating}
              className="inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-[12px] font-semibold outline-none focus-visible:ring-2 disabled:opacity-50"
              style={{ color: gold, backgroundColor: `color-mix(in oklch, ${gold} 14%, transparent)`, border: `1px solid color-mix(in oklch, ${gold} 34%, transparent)` }}
            >
              {creating ? <Loader2 size={13} className={reduce ? "" : "animate-spin"} aria-hidden /> : <Check size={13} aria-hidden />}
              {creating ? "Creating…" : "Confirm & create"}
            </button>
          </div>
        </motion.div>
      )}

      {err && (
        <p className="mt-2 inline-flex items-center gap-1.5 font-mono text-[10px]" style={{ color: tok("stale-red") }}>
          <AlertTriangle size={12} aria-hidden /> {err}
        </p>
      )}
    </div>
  );
}
