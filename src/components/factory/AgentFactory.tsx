import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Factory, ChevronDown, Plus, Bot, Crown, Send, Trash2, Plug, KeyRound,
  Loader2, Check, AlertTriangle, ShieldCheck, Link2,
} from "lucide-react";
import { tok } from "../../lib/agentMeta";
import {
  getSkills, getFactoryHealth, listAgents, deleteAgent, listConnections, connectAccount,
  deleteConnection, previewPost, executePost,
  type Skill, type Platform, type AgentSpec, type Connection, type PostPreview,
} from "../../lib/factoryClient";
import { CreateAgentFlow } from "./CreateAgentFlow";
import { SkillCatalog } from "./SkillCatalog";
import { PostApprovalGate } from "./PostApprovalGate";

// Surface 2 (+host) — Agent Factory panel. Collapsible like SessionsBrowser. Tabs:
//   Agents (gallery + New-Agent create flow) · Skills (catalog) · Accounts (broker)
//   · Post (compose → dry-run → BOSS-confirm → execute).
// All color via OKLCH tokens; factory-violet identity; reduced-motion safe.

type Tab = "agents" | "skills" | "accounts" | "post";

export function AgentFactory({ builtinIds = [] }: { builtinIds?: string[] }) {
  const reduce = useReducedMotion();
  const violet = tok("factory-violet");

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("agents");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [agents, setAgents] = useState<AgentSpec[]>([]);
  const [conns, setConns] = useState<Connection[]>([]);
  const [composio, setComposio] = useState(false);
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState("");

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
    setCreating(false);
    flash(`agent “${spec.id}” created + live`);
    void refresh();
  }, [refresh]);

  const removeAgent = useCallback(async (id: string) => {
    const r = await deleteAgent(id);
    if (r.ok) { flash(`removed ${id}`); void refresh(); } else flash(r.error || "delete failed");
  }, [refresh]);

  const TABS: Array<{ id: Tab; label: string; n?: number }> = [
    { id: "agents", label: "Agents", n: agents.length },
    { id: "skills", label: "Skills", n: skills.length },
    { id: "accounts", label: "Accounts", n: conns.length },
    { id: "post", label: "Post" },
  ];

  return (
    <section
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
            <span className="rounded-full font-mono text-[9px]" style={{ padding: "1px 7px", color: violet, backgroundColor: `color-mix(in oklch, ${violet} 12%, transparent)` }}>
              {agents.length} created
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

              {tab === "agents" && (
                <AgentsTab
                  skills={skills} agents={agents} builtinIds={builtinIds} creating={creating}
                  onStartCreate={() => setCreating(true)} onCancelCreate={() => setCreating(false)}
                  onCreated={onCreated} onDelete={removeAgent}
                />
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
    </section>
  );
}

// ── Agents tab — create flow + gallery ────────────────────────────────────────
function AgentsTab({
  skills, agents, builtinIds, creating, onStartCreate, onCancelCreate, onCreated, onDelete,
}: {
  skills: Skill[]; agents: AgentSpec[]; builtinIds: string[]; creating: boolean;
  onStartCreate: () => void; onCancelCreate: () => void; onCreated: (s: AgentSpec) => void; onDelete: (id: string) => void;
}) {
  const reduce = useReducedMotion();
  const violet = tok("factory-violet");
  const gold = tok("ceo-gold");
  const skillLabel = (id: string) => skills.find((s) => s.id === id)?.label ?? id;

  return (
    <div>
      {!creating && (
        <button
          type="button"
          onClick={onStartCreate}
          className="mb-4 inline-flex items-center gap-1.5 rounded-md px-3.5 py-2 text-[12px] font-semibold outline-none focus-visible:ring-2"
          style={{ color: violet, backgroundColor: `color-mix(in oklch, ${violet} 14%, transparent)`, border: `1px solid color-mix(in oklch, ${violet} 34%, transparent)` }}
        >
          <Plus size={14} aria-hidden /> New Agent
        </button>
      )}
      {creating && (
        <div className="mb-4">
          <CreateAgentFlow skills={skills} onCreated={onCreated} onClose={onCancelCreate} />
        </div>
      )}

      {/* created-by-BOSS band */}
      <div className="mb-2 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: violet }}>
        <Crown size={11} aria-hidden /> Created by BOSS
      </div>
      {agents.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/60 px-4 py-8 text-center text-[12px] text-muted">
          No agents yet. Click <span className="font-semibold text-text">New Agent</span> and describe what you need.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((a, i) => (
            <motion.div
              key={a.id}
              initial={{ opacity: 0, y: reduce ? 0 : 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduce ? 0 : 0.2, ease: "easeOut", delay: reduce ? 0 : Math.min(i * 0.03, 0.3) }}
              className="rounded-lg border p-3"
              style={{ borderColor: `color-mix(in oklch, ${violet} 26%, var(--c-border))`, backgroundColor: "color-mix(in oklch, var(--c-bg) 30%, transparent)" }}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="inline-flex items-center gap-1.5" style={{ color: violet }}>
                  <Bot size={14} aria-hidden />
                  <span className="text-[13px] font-semibold text-text">{a.title}</span>
                </span>
                <button type="button" onClick={() => onDelete(a.id)} aria-label={`Delete ${a.id}`} className="rounded p-1 text-muted outline-none hover:text-stale-red focus-visible:ring-2">
                  <Trash2 size={12} aria-hidden />
                </button>
              </div>
              <div className="mt-0.5 text-[11px] text-muted">{a.role}</div>
              <div className="mt-0.5 font-mono text-[9px] text-muted">{a.id}</div>
              <div className="mt-2 flex flex-wrap gap-1">
                {a.skills.slice(0, 4).map((s) => (
                  <span key={s} className="rounded font-mono text-[9px]" style={{ padding: "1px 6px", color: violet, backgroundColor: `color-mix(in oklch, ${violet} 10%, transparent)`, border: `1px solid color-mix(in oklch, ${violet} 22%, transparent)` }}>
                    {skillLabel(s)}
                  </span>
                ))}
                {a.skills.length > 4 && <span className="font-mono text-[9px] text-muted">+{a.skills.length - 4}</span>}
              </div>
              {a.integrations.length > 0 && (
                <div className="mt-1.5 inline-flex items-center gap-1 font-mono text-[9px]" style={{ color: gold }}>
                  <Send size={9} aria-hidden /> can post: {a.integrations.join(", ")}
                </div>
              )}
            </motion.div>
          ))}
        </div>
      )}

      {/* built-in swarm band (compact reference) */}
      {builtinIds.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted">Built-in swarm · {builtinIds.length}</div>
          <div className="flex flex-wrap gap-1.5">
            {builtinIds.map((id) => (
              <span key={id} className="rounded font-mono text-[10px] text-text/80" style={{ padding: "2px 7px", backgroundColor: "color-mix(in oklch, var(--c-bg) 40%, transparent)", border: "1px solid var(--c-border)" }}>
                {id}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
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
