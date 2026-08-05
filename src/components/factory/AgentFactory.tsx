import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Factory, ChevronDown, Send, Trash2, Plug, KeyRound,
  Loader2, Check, AlertTriangle, ShieldCheck, Link2, Sparkles, UserPlus,
} from "lucide-react";
import { tok } from "../../lib/agentMeta";
import {
  getSkills, getFactoryHealth, listAgents, listConnections, connectAccount,
  deleteConnection, previewPost, executePost,
  type Skill, type Platform, type AgentSpec, type Connection, type PostPreview,
} from "../../lib/factoryClient";
import { CreateAgentFlow } from "./CreateAgentFlow";
import { SkillCatalog } from "./SkillCatalog";
import { PostApprovalGate } from "./PostApprovalGate";
import { PoolPicker } from "../cockpit/PoolPicker";

// Agent Factory panel — a CREATE WIZARD. Collapsible like SessionsBrowser. Tabs:
//   Create (describe → author → confirm) · Skills (catalog) · Accounts (broker)
//   · Post (compose → dry-run → BOSS-confirm → execute).
// Once an agent is created it lives ON THE BOARD (with a BOSS badge) and is managed
// from its board drawer (edit skills / delete) — there is NO duplicate gallery here.
// All color via OKLCH tokens; factory-violet identity; reduced-motion safe.

type Tab = "create" | "skills" | "accounts" | "post";

export function AgentFactory({ openSignal = 0 }: { openSignal?: number }) {
  const reduce = useReducedMotion();
  const violet = tok("factory-violet");

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("create");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [agents, setAgents] = useState<AgentSpec[]>([]);
  const [conns, setConns] = useState<Connection[]>([]);
  const [composio, setComposio] = useState(false);
  const [createKey, setCreateKey] = useState(0); // bump to reset the create flow
  const [toast, setToast] = useState("");
  const [poolOpen, setPoolOpen] = useState(false); // "Add agents" (pool) modal
  const sectionRef = useRef<HTMLElement | null>(null);

  // F5 — the Factory is the single creation home. Other surfaces (the roster's "+ Add")
  // bump `openSignal` to expand this panel on the Create tab and scroll it into view.
  useEffect(() => {
    if (openSignal <= 0) return;
    setOpen(true);
    setTab("create");
    requestAnimationFrame(() => sectionRef.current?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" }));
  }, [openSignal, reduce]);

  const refresh = useCallback(async () => {
    const [a, c] = await Promise.all([listAgents().catch(() => ({ agents: [] })), listConnections().catch(() => ({ connections: [] }))]);
    setAgents(a.agents ?? []);
    setConns(c.connections ?? []);
  }, []);

  useEffect(() => {
    if (!open) return;
    void getSkills().then((d) => { setSkills(d.skills ?? []); setPlatforms(d.platforms ?? []); }).catch(() => {});
    void getFactoryHealth().then((h) => setComposio(!!h.composio)).catch(() => {});
    void refresh();
  }, [open, refresh]);

  const flash = (m: string) => { setToast(m); window.setTimeout(() => setToast(""), 5000); };

  const onCreated = useCallback((spec: AgentSpec) => {
    flash(`“${spec.id}” created — now live on the board (look for the BOSS badge)`);
    setCreateKey((k) => k + 1); // reset the flow for the next agent
    void refresh();
  }, [refresh]);

  const TABS: Array<{ id: Tab; label: string; n?: number }> = [
    { id: "create", label: "Create" },
    { id: "skills", label: "Skills", n: skills.length },
    { id: "accounts", label: "Accounts", n: conns.length },
    { id: "post", label: "Post" },
  ];

  return (
    <section
      ref={sectionRef}
      aria-label="Agent Factory"
      className="rounded-panel border bg-panel/70 backdrop-blur-sm"
      style={{ borderColor: open ? `color-mix(in oklch, ${violet} 34%, var(--c-border))` : "var(--c-border)" }}
    >
      {/* header */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2"
      >
        <span className="inline-flex items-center gap-2.5">
          <span style={{ color: violet }}><Factory size={16} aria-hidden /></span>
          <span className="text-[14px] font-semibold text-text">Agent Factory</span>
          <span className="font-mono text-[10px] uppercase tracking-wide text-muted">BOSS spawns agents</span>
          {agents.length > 0 && (
            <span className="rounded-full font-mono text-[9px]" style={{ padding: "1px 7px", color: violet, backgroundColor: `color-mix(in oklch, ${violet} 12%, transparent)` }} title="Created agents live on the board">
              {agents.length} on board
            </span>
          )}
        </span>
        <ChevronDown size={16} className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: reduce ? "auto" : 0, opacity: reduce ? 1 : 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: reduce ? "auto" : 0, opacity: reduce ? 1 : 0 }}
            transition={{ duration: reduce ? 0 : 0.24, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="border-t border-border/50 px-4 py-4">
              {/* tabs */}
              <div className="mb-4 flex flex-wrap gap-1.5">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTab(t.id)}
                    aria-pressed={tab === t.id}
                    className="rounded-full px-3 py-1.5 text-[11px] font-semibold outline-none focus-visible:ring-2"
                    style={{
                      color: tab === t.id ? violet : tok("muted"),
                      backgroundColor: tab === t.id ? `color-mix(in oklch, ${violet} 14%, transparent)` : "transparent",
                      border: `1px solid color-mix(in oklch, ${tab === t.id ? violet : tok("border")} 50%, transparent)`,
                    }}
                  >
                    {t.label}{typeof t.n === "number" ? ` · ${t.n}` : ""}
                  </button>
                ))}
              </div>

              {toast && (
                <p className="mb-3 inline-flex items-center gap-1.5 font-mono text-[10px]" style={{ color: tok("done-green") }} role="status" aria-live="polite">
                  <Check size={12} aria-hidden /> {toast}
                </p>
              )}

              {tab === "create" && (
                <div>
                  <p className="mb-3 inline-flex items-center gap-1.5 text-[11px] leading-relaxed text-muted">
                    <Sparkles size={12} aria-hidden style={{ color: violet }} />
                    Describe a need — Claude authors the agent. Once you confirm, it goes
                    <span className="font-semibold text-text"> live on the board</span> with a
                    <span className="font-mono" style={{ color: violet }}> BOSS</span> badge. Manage it (edit skills / remove) from its board drawer.
                  </p>
                  {/* F5 — the two ways to put an agent on the board sit side by side, so the
                      Factory is the single creation home. "Add agents" pulls ready-made agents
                      from the .claude/agents pool; CREATE authors a brand-new one below. */}
                  <div
                    className="mb-3 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
                    style={{ borderColor: `color-mix(in oklch, ${violet} 24%, var(--c-border))` }}
                  >
                    <span className="text-[11px] text-muted">Already have someone in mind?</span>
                    <button
                      type="button"
                      onClick={() => setPoolOpen(true)}
                      aria-haspopup="dialog"
                      className="inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-[12px] font-semibold outline-none transition-colors duration-150 hover:brightness-110 focus-visible:ring-2 disabled:cursor-default disabled:opacity-40 motion-reduce:transition-none"
                      style={{ color: violet, backgroundColor: `color-mix(in oklch, ${violet} 14%, transparent)`, border: `1px solid color-mix(in oklch, ${violet} 34%, transparent)` }}
                    >
                      <UserPlus size={13} aria-hidden /> Add agents
                    </button>
                    <span className="text-[10px] text-muted">from the pool — each gets its own chat thread</span>
                  </div>
                  <CreateAgentFlow key={createKey} skills={skills} onCreated={onCreated} onClose={() => setCreateKey((k) => k + 1)} />
                </div>
              )}
              {tab === "skills" && <SkillCatalog skills={skills} mode="browse" />}
              {tab === "accounts" && (
                <AccountsTab platforms={platforms} conns={conns} composio={composio} onChange={() => void refresh()} onFlash={flash} />
              )}
              {tab === "post" && <PostTab agents={agents} conns={conns} onFlash={flash} />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <PoolPicker open={poolOpen} onClose={() => setPoolOpen(false)} onImported={() => { flash("agents imported — live on the board"); void refresh(); }} />
    </section>
  );
}

// ── Accounts tab — credential broker (connect / list / revoke) ────────────────
function AccountsTab({
  platforms, conns, composio, onChange, onFlash,
}: {
  platforms: Platform[]; conns: Connection[]; composio: boolean; onChange: () => void; onFlash: (m: string) => void;
}) {
  const reduce = useReducedMotion();
  const violet = tok("factory-violet");
  const [platform, setPlatform] = useState("");
  const [handle, setHandle] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { if (!platform && platforms[0]) setPlatform(platforms[0].id); }, [platforms, platform]);

  const connect = useCallback(async () => {
    setErr(""); setBusy(true);
    const r = await connectAccount(platform, handle.trim(), secret);
    setBusy(false);
    setSecret(""); // never keep the secret in component state
    if (r.error || !r.connection) { setErr(r.error || "connect failed"); return; }
    setHandle("");
    onFlash(`connected ${r.connection.platform} · ${r.connection.handle}`);
    onChange();
  }, [platform, handle, secret, onChange, onFlash]);

  const revoke = useCallback(async (connId: string) => {
    const r = await deleteConnection(connId);
    if (r.ok) { onFlash("account revoked"); onChange(); } else onFlash(r.error || "revoke failed");
  }, [onChange, onFlash]);

  return (
    <div className="space-y-4">
      <div
        className="rounded-md border px-3 py-2.5 text-[11px] leading-relaxed"
        style={{ borderColor: `color-mix(in oklch, ${tok("done-green")} 30%, transparent)`, backgroundColor: `color-mix(in oklch, ${tok("done-green")} 7%, transparent)`, color: tok("muted") }}
      >
        <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: tok("done-green") }}>
          <ShieldCheck size={12} aria-hidden /> Credentials stay with you
        </span>
        <p className="mt-1">
          The token below is encrypted at rest and referenced only by an opaque id. It is never shown to Claude, logged, or streamed.
          {composio ? " Composio is connected — posts go live." : " No Composio key set — posts run in safe simulated mode."}
        </p>
      </div>

      {/* connect form */}
      <div className="rounded-lg border border-border/60 p-3">
        <div className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: violet }}>
          <Link2 size={12} aria-hidden /> Connect an account
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-muted">Platform</span>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="w-full rounded-md border border-border/60 bg-bg/60 px-2.5 py-1.5 text-[12px] text-text/90 outline-none focus-visible:ring-2">
              {platforms.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-muted">Handle</span>
            <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@yourhandle" className="w-full rounded-md border border-border/60 bg-bg/60 px-2.5 py-1.5 text-[12px] text-text/90 outline-none focus-visible:ring-2" />
          </label>
        </div>
        <label className="mt-2 block">
          <span className="mb-1 inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-muted"><KeyRound size={10} aria-hidden /> Token / OAuth credential</span>
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="paste token — goes straight to the encrypted broker" autoComplete="off" className="w-full rounded-md border border-border/60 bg-bg/60 px-2.5 py-1.5 font-mono text-[11px] text-text/90 outline-none focus-visible:ring-2" />
        </label>
        <div className="mt-2.5 flex items-center justify-end">
          <button type="button" onClick={() => void connect()} disabled={busy || !handle.trim() || secret.length < 4} className="inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-[12px] font-semibold outline-none focus-visible:ring-2 disabled:opacity-40" style={{ color: violet, backgroundColor: `color-mix(in oklch, ${violet} 14%, transparent)`, border: `1px solid color-mix(in oklch, ${violet} 34%, transparent)` }}>
            {busy ? <Loader2 size={13} className={reduce ? "" : "animate-spin"} aria-hidden /> : <Plug size={13} aria-hidden />} Connect
          </button>
        </div>
        {err && <p className="mt-2 inline-flex items-center gap-1.5 font-mono text-[10px]" style={{ color: tok("stale-red") }}><AlertTriangle size={12} aria-hidden /> {err}</p>}
      </div>

      {/* connected accounts */}
      {conns.length === 0 ? (
        <p className="text-[11px] text-muted">No accounts connected.</p>
      ) : (
        <ul className="space-y-1.5">
          {conns.map((c) => (
            <li key={c.connId} className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
              <span className="inline-flex items-center gap-2 text-[12px] text-text/90">
                <span style={{ color: violet }}><Plug size={12} aria-hidden /></span>
                <span className="font-semibold">{c.platform}</span> · {c.handle}
                <span className="font-mono text-[9px] text-muted">{c.connId}</span>
              </span>
              <button type="button" onClick={() => void revoke(c.connId)} aria-label={`Revoke ${c.handle}`} className="rounded p-1 text-muted outline-none hover:text-stale-red focus-visible:ring-2">
                <Trash2 size={12} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Post tab — compose → dry-run → BOSS-confirm → execute ─────────────────────
function PostTab({ agents, conns, onFlash }: { agents: AgentSpec[]; conns: Connection[]; onFlash: (m: string) => void }) {
  const violet = tok("factory-violet");
  const posters = useMemo(() => agents.filter((a) => a.integrations.length > 0), [agents]);
  const [agentId, setAgentId] = useState("");
  const [connId, setConnId] = useState("");
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState<PostPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { if (!agentId && posters[0]) setAgentId(posters[0].id); }, [posters, agentId]);
  // accounts whose platform the selected agent is authorized for
  const agent = posters.find((a) => a.id === agentId);
  const eligible = useMemo(() => conns.filter((c) => agent?.integrations.includes(c.platform)), [conns, agent]);
  useEffect(() => { if (eligible[0] && !eligible.find((c) => c.connId === connId)) setConnId(eligible[0].connId); }, [eligible, connId]);

  const doPreview = useCallback(async () => {
    setErr(""); setBusy(true);
    const r = await previewPost(agentId, connId, content);
    setBusy(false);
    if (r.error) { setErr(r.error); return; }
    setPreview(r);
  }, [agentId, connId, content]);

  const confirm = useCallback(async () => {
    if (!preview) return;
    setBusy(true);
    const r = await executePost(agentId, connId, content, preview.confirmToken);
    setBusy(false);
    setPreview(null);
    if (r.error) { onFlash(r.error); return; }
    onFlash(`${r.simulated ? "simulated" : "posted"} → ${r.handle} (${r.postId}) · ${r.rate?.remaining} left today`);
    setContent("");
  }, [preview, agentId, connId, content, onFlash]);

  if (posters.length === 0)
    return <p className="text-[12px] text-muted">No posting-capable agents yet. Create one with a social-post skill, then connect an account.</p>;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-muted">Agent</span>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="w-full rounded-md border border-border/60 bg-bg/60 px-2.5 py-1.5 text-[12px] text-text/90 outline-none focus-visible:ring-2">
            {posters.map((a) => <option key={a.id} value={a.id}>{a.title} ({a.id})</option>)}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-muted">Account</span>
          <select value={connId} onChange={(e) => setConnId(e.target.value)} disabled={eligible.length === 0} className="w-full rounded-md border border-border/60 bg-bg/60 px-2.5 py-1.5 text-[12px] text-text/90 outline-none focus-visible:ring-2 disabled:opacity-50">
            {eligible.length === 0 ? <option>— connect a {agent?.integrations.join("/")} account —</option> : eligible.map((c) => <option key={c.connId} value={c.connId}>{c.platform} · {c.handle}</option>)}
          </select>
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-muted">Content</span>
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={4} placeholder="Draft the post… (or ask the agent in its drawer to draft one, then paste here)" className="w-full resize-y rounded-md border border-border/60 bg-bg/60 px-3 py-2 text-[13px] leading-relaxed text-text/90 outline-none placeholder:text-muted/50 focus-visible:ring-2" />
      </label>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] text-muted">{content.length} chars</span>
        <button type="button" onClick={() => void doPreview()} disabled={busy || !content.trim() || eligible.length === 0} className="inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-[12px] font-semibold outline-none focus-visible:ring-2 disabled:opacity-40" style={{ color: violet, backgroundColor: `color-mix(in oklch, ${violet} 14%, transparent)`, border: `1px solid color-mix(in oklch, ${violet} 34%, transparent)` }}>
          <Send size={13} aria-hidden /> Preview post
        </button>
      </div>
      {err && <p className="inline-flex items-center gap-1.5 font-mono text-[10px]" style={{ color: tok("stale-red") }}><AlertTriangle size={12} aria-hidden /> {err}</p>}

      <PostApprovalGate preview={preview} busy={busy} onConfirm={() => void confirm()} onCancel={() => setPreview(null)} />
    </div>
  );
}
