import { useCallback, useEffect, useState } from "react";
import { Boxes, Loader2, Plus, X, Github, TerminalSquare } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import { PermissionGate } from "../PermissionGate";
import {
  getAdapters,
  putAdapters,
  addDeny,
  removeDeny,
  ADAPTER_STATE_LABEL,
  adapterStateTone,
  type AdaptersStatus,
} from "../../lib/inboxClient";

/*
  P7 / ADR-054 — the universal-ingestion adapters.

  GitHub adapter: poll bot-authored PRs (Cursor / Codex / Devin) into the Inbox; approve
  posts back to GitHub. Claude Code adapter: watch a local session workspace, read-only.
  Enabling the GitHub poller is consequential (it acts on real PRs on approve), so the
  save is F3-gated through the PermissionGate. The server is the authority — it strictly
  validates every save and, if the stored file is corrupt, falls back to all-disabled.
*/

const toneColor = (tone: string) => (tone === "green" ? tok("accent-cyan") : tone === "red" ? tok("stale-red") : tone === "amber" ? tok("blocked-amber") : tok("muted"));

function StatusDot({ state }: { state: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px]" style={{ color: tok("muted") }}>
      <span aria-hidden className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: toneColor(adapterStateTone(state)) }} />
      {ADAPTER_STATE_LABEL[state] ?? state}
    </span>
  );
}

function MiniToggle({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center justify-between gap-3">
      <span className="text-[13px] text-text">{label}</span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full outline-none transition-colors focus-visible:ring-2"
        style={{ backgroundColor: checked ? tok("accent-cyan") : tok("panel-2"), border: `1px solid ${tok("border")}` }}
      >
        <span aria-hidden className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform" style={{ transform: checked ? "translateX(18px)" : "translateX(2px)" }} />
      </button>
    </label>
  );
}

export function AdapterSettings() {
  const [status, setStatus] = useState<AdaptersStatus | null>(null);
  const [ghEnabled, setGhEnabled] = useState(false);
  const [botAuthors, setBotAuthors] = useState<string[]>([]);
  const [newBot, setNewBot] = useState("");
  const [repo, setRepo] = useState("");
  const [pollSec, setPollSec] = useState(60);
  const [mergeOnApprove, setMergeOnApprove] = useState(false);
  const [ccEnabled, setCcEnabled] = useState(false);
  const [slug, setSlug] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateOpen, setGateOpen] = useState(false);

  const load = useCallback(() => {
    getAdapters()
      .then((s) => {
        setStatus(s);
        if (s.github) { setGhEnabled(s.github.enabled); setBotAuthors(s.github.botAuthors ?? []); setRepo(s.github.repo ?? ""); setPollSec(Math.round((s.github.pollIntervalMs ?? 60000) / 1000)); setMergeOnApprove(!!s.github.mergeOnApprove); }
        if (s.claudeCode) { setCcEnabled(s.claudeCode.enabled); setSlug(s.claudeCode.workspaceSlug ?? ""); }
        setDirty(false);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "could not read adapters"));
  }, []);
  useEffect(() => { load(); }, [load]);

  const mark = () => setDirty(true);
  const addBot = () => { const next = addDeny(botAuthors, newBot); if (next.length !== botAuthors.length) { setBotAuthors(next); mark(); } setNewBot(""); };
  const dropBot = (b: string) => { setBotAuthors(removeDeny(botAuthors, b)); mark(); };

  const doSave = async () => {
    setGateOpen(false);
    setBusy(true);
    setError(null);
    try {
      const r = await putAdapters({
        github: { enabled: ghEnabled, botAuthors, repo: repo.trim() || null, pollIntervalMs: Math.max(10, Math.floor(pollSec)) * 1000, mergeOnApprove },
        claudeCode: { enabled: ccEnabled, workspaceSlug: slug.trim() },
      });
      if (r.error) { setError(r.error); return; }
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = { backgroundColor: tok("panel-2"), color: tok("text"), border: `1px solid ${tok("border")}` };

  return (
    <section className="border-t border-border/50 py-4">
      <div className="mb-3 flex items-center gap-2">
        <span style={{ color: tok("accent-cyan") }}><Boxes size={15} aria-hidden /></span>
        <h3 className="text-sm font-semibold tracking-tight">Ingestion adapters</h3>
      </div>
      <p className="mb-3 text-[12px] text-muted">
        One inbox for every vendor. Poll bot-authored GitHub PRs (Cursor, Codex, Devin) and watch local
        Claude Code sessions — they appear as deliveries beside the swarm's own work.
      </p>

      {status === null && (
        <p className="text-[12px]" role={error ? "alert" : "status"} style={{ color: error ? tok("stale-red") : tok("muted") }}>
          {error ?? "Reading adapters…"}
          {error && (
            <button type="button" onClick={load} className="ml-2 underline outline-none focus-visible:ring-2" style={{ color: tok("accent-cyan") }}>Retry</button>
          )}
        </p>
      )}

      {status && !status.valid && (
        <p className="mb-3 rounded-md px-3 py-2 text-[11px]" role="alert" style={{ color: tok("stale-red"), border: `1px solid ${tok("stale-red")}` }}>
          The stored adapters config was unreadable — all adapters are disabled. Saving here repairs it.
        </p>
      )}

      {status !== null && (
      <div className="flex flex-col gap-4">
        {/* GitHub */}
        <div className="flex flex-col gap-2 rounded-md p-3" style={{ border: `1px solid ${tok("border")}` }}>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-[13px] text-text"><Github size={14} aria-hidden /> GitHub PRs</span>
            {status?.github && <StatusDot state={status.github.state} />}
          </div>
          <MiniToggle id="ad-gh" label="Ingest bot-authored pull requests" checked={ghEnabled} onChange={(v) => { setGhEnabled(v); mark(); }} />
          {ghEnabled && (
            <>
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px]" style={{ color: tok("muted") }}>Bot authors (login or app/&lt;name&gt;)</span>
                <div className="flex flex-wrap gap-1.5" role="list" aria-label="Bot authors">
                  {botAuthors.length === 0 && <span className="text-[11px]" style={{ color: tok("muted") }}>None yet — add a bot login to poll.</span>}
                  {botAuthors.map((b) => (
                    <span key={b} role="listitem" className="flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[11px]" style={{ backgroundColor: tok("panel-2"), border: `1px solid ${tok("border")}` }}>
                      {b}
                      <button type="button" aria-label={`Remove ${b}`} onClick={() => dropBot(b)} className="outline-none focus-visible:ring-2" style={{ color: tok("muted") }}><X size={11} aria-hidden /></button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-1.5">
                  <input className="flex-1 rounded-md px-2.5 py-1.5 font-mono text-[11px] outline-none focus-visible:ring-2" style={inputStyle} placeholder="cursor" aria-label="New bot author" value={newBot} onChange={(e) => setNewBot(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addBot(); } }} />
                  <button type="button" onClick={addBot} disabled={!newBot.trim()} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] outline-none focus-visible:ring-2 disabled:opacity-40" style={{ color: tok("accent-cyan"), border: `1px solid color-mix(in oklch, ${tok("accent-cyan")} 30%, transparent)` }}><Plus size={12} aria-hidden /> Add</button>
                </div>
              </div>
              <label className="flex items-center justify-between gap-3">
                <span className="text-[11px]" style={{ color: tok("muted") }}>Repo (optional, owner/name)</span>
                <input className="w-44 rounded-md px-2.5 py-1.5 font-mono text-[11px] outline-none focus-visible:ring-2" style={inputStyle} placeholder="acme/app" aria-label="Repo" value={repo} onChange={(e) => { setRepo(e.target.value); mark(); }} />
              </label>
              <label className="flex items-center justify-between gap-3">
                <span className="text-[11px]" style={{ color: tok("muted") }}>Poll interval (seconds)</span>
                <input type="number" min={10} className="w-24 rounded-md px-2.5 py-1.5 font-mono text-[11px] outline-none focus-visible:ring-2" style={inputStyle} aria-label="Poll interval seconds" value={pollSec} onChange={(e) => { setPollSec(Number(e.target.value) || 60); mark(); }} />
              </label>
              <MiniToggle id="ad-merge" label="Merge on approve (default off — approve only posts a review)" checked={mergeOnApprove} onChange={(v) => { setMergeOnApprove(v); mark(); }} />
              {status?.github?.lastError && <p className="text-[11px]" style={{ color: tok("blocked-amber") }}>{status.github.lastError}</p>}
            </>
          )}
        </div>

        {/* Claude Code */}
        <div className="flex flex-col gap-2 rounded-md p-3" style={{ border: `1px solid ${tok("border")}` }}>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-[13px] text-text"><TerminalSquare size={14} aria-hidden /> Claude Code sessions <span className="text-[10px]" style={{ color: tok("muted") }}>read-only</span></span>
            {status?.claudeCode && <StatusDot state={status.claudeCode.state} />}
          </div>
          <MiniToggle id="ad-cc" label="Watch local Claude Code sessions" checked={ccEnabled} onChange={(v) => { setCcEnabled(v); mark(); }} />
          {ccEnabled && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px]" style={{ color: tok("muted") }}>Workspace slug (folder under ~/.claude/projects/)</span>
              <input className="rounded-md px-2.5 py-1.5 font-mono text-[11px] outline-none focus-visible:ring-2" style={inputStyle} placeholder="-Users-you-repo" aria-label="Workspace slug" value={slug} onChange={(e) => { setSlug(e.target.value); mark(); }} />
            </label>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setGateOpen(true)}
            disabled={busy || !dirty}
            className="flex items-center gap-2 rounded-md px-3 py-1.5 text-[12px] outline-none transition-colors focus-visible:ring-2 disabled:opacity-40"
            style={{ backgroundColor: `color-mix(in oklch, ${tok("accent-cyan")} 14%, transparent)`, color: tok("accent-cyan"), border: `1px solid color-mix(in oklch, ${tok("accent-cyan")} 30%, transparent)` }}
          >
            {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Boxes size={13} aria-hidden />}
            {busy ? "Saving…" : "Save adapters"}
          </button>
          {error && <p className="text-[11px]" style={{ color: tok("stale-red") }} role="alert">{error}</p>}
        </div>
      </div>
      )}

      <PermissionGate
        open={gateOpen}
        title="Save ingestion adapters"
        summary={
          ghEnabled
            ? "The GitHub adapter will POLL bot-authored PRs and, on approve, post a review to GitHub. It never auto-applies. Claude Code sessions are read-only."
            : "Update adapter config. No adapter acts on GitHub while the GitHub adapter is off."
        }
        affected={[]}
        confirmLabel="Save adapters"
        accent="blocked-amber"
        onConfirm={() => void doSave()}
        onCancel={() => setGateOpen(false)}
      />
    </section>
  );
}
