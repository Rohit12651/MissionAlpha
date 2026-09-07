// Settings panel (ADR-040 / gap #26). A focus-trapped modal over the cockpit:
// Appearance · Defaults · Policy · Accessibility. All values persist via the
// settings store. Policy toggles are CLIENT DEFAULTS only — they pre-fill the
// existing gated flows and never weaken server-side enforcement (see ADR-040 §3).

import { useEffect, useRef, useState, useCallback } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X, Palette, Sliders, ShieldCheck, Eye, FolderOpen, FolderGit2, Loader2 } from "lucide-react";
import { useSettings } from "../../lib/settingsContext";
import { ACCENTS, type AccentKey } from "../../lib/settings";
import { MODEL_TIERS, type ModelTier } from "../../lib/modelTiers";
import { tok } from "../../lib/agentMeta";
import { getWorkspace, setWorkspace, displayPath, ghLabel, ghTone, type WorkspaceInfo } from "../../lib/workspaceClient";
import { PolicyEditor } from "./PolicyEditor";
import { AdapterSettings } from "./AdapterSettings";
import { UserManagement } from "../auth/UserManagement";
import { RosterStrip } from "../board/RosterStrip";

function Section({ icon, title, desc, children }: { icon: React.ReactNode; title: string; desc: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border/50 py-4 first:border-t-0">
      <div className="mb-3 flex items-center gap-2">
        <span style={{ color: tok("accent-cyan") }}>{icon}</span>
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      </div>
      <p className="mb-3 text-[12px] text-muted">{desc}</p>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Toggle({ id, label, hint, checked, onChange }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="text-[13px] text-text">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] text-muted">{hint}</span>}
      </span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full outline-none transition-colors focus-visible:ring-2"
        style={{ backgroundColor: checked ? tok("accent-cyan") : tok("panel-2"), border: `1px solid ${tok("border")}` }}
      >
        <span
          aria-hidden
          className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform"
          style={{ transform: checked ? "translateX(18px)" : "translateX(2px)" }}
        />
      </button>
    </label>
  );
}

function ChoiceRow<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { v: T; label: string; hint?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[13px] text-text">{label}</span>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
        {options.map((o) => {
          const active = o.v === value;
          return (
            <button
              key={o.v}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(o.v)}
              title={o.hint}
              className="rounded-md px-2.5 py-1 font-mono text-[11px] outline-none transition-colors focus-visible:ring-2"
              style={{
                color: active ? tok("accent-cyan") : tok("muted"),
                backgroundColor: active ? `color-mix(in oklch, ${tok("accent-cyan")} 14%, transparent)` : "transparent",
                border: `1px solid ${active ? `color-mix(in oklch, ${tok("accent-cyan")} 30%, transparent)` : tok("border")}`,
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// P5 — WORKSPACE. The runtime is the authority here: it validates the path (realpath,
// is-git, not $HOME//, not a nested worktree, must not swallow a runtime state dir)
// and persists it 0600 outside every repo. This panel only asks and reports.
//
// REPO_ROOT is immutable for a runtime process — that immutability is what makes the
// apply broker's containment check trustworthy — so a change takes effect on the next
// runtime start. Electron can do that restart itself; in the browser we say so plainly
// instead of pretending the change is already live.
function WorkspaceSection() {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [savedPath, setSavedPath] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const w = await getWorkspace();
      setInfo(w);
      setDraft((d) => d || w.configured || w.repoPath);
      setStatus("idle");
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : "Runtime unreachable");
      setStatus("error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (path: string) => {
    if (!path.trim()) return;
    setStatus("saving");
    setErrorMsg("");
    try {
      const r = await setWorkspace(path.trim());
      if (!r.ok) {
        // The server's reason is the useful one — never replace it with "failed".
        setErrorMsg(r.error ?? "Could not use that folder");
        setStatus("error");
        return;
      }
      setSavedPath(r.repoPath ?? path.trim());
      // In the packaged app the supervisor can restart itself, so the choice goes
      // live immediately. In the browser it cannot — the note below says so.
      if (window.missionAlpha?.setRepoRoot) {
        await window.missionAlpha.setRepoRoot(r.repoPath ?? path.trim());
      }
      await load();
      setStatus("idle");
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : "Unknown error");
      setStatus("error");
    }
  }, [load]);

  const pick = useCallback(async () => {
    try {
      const picked = await window.missionAlpha?.pickFolder?.();
      if (picked) setDraft(picked);
    } catch { /* the dialog was dismissed */ }
  }, []);

  const busy = status === "loading" || status === "saving";
  const pinned = !!info?.envPinned;
  const active = info?.repoPath ?? null;
  const pendingRestart = !!info && !!info.configured && info.configured !== info.repoPath;
  const dirty = !!draft.trim() && draft.trim() !== (info?.configured ?? info?.repoPath ?? "");

  return (
    <Section
      icon={<FolderGit2 size={15} aria-hidden />}
      title="Workspace"
      desc="The git repo your agents work in. Each task runs in its own git worktree; approving a delivery commits to that branch, never straight into your working tree."
    >
      <div className="flex flex-col gap-2">
        <div
          className="rounded-md px-3 py-2 font-mono text-[11px] break-all"
          style={{ backgroundColor: tok("panel-2"), color: active ? tok("text") : tok("muted"), border: `1px solid ${tok("border")}` }}
          aria-label="Active workspace"
        >
          {displayPath(active)}
          {info && !info.isGit && (
            <span className="ml-2" style={{ color: tok("muted") }}>· not a git repo — agents fall back to a copy sandbox</span>
          )}
        </div>

        {info && (
          <p className="flex items-center gap-1.5 text-[11px]" style={{ color: tok("muted") }}>
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: ghTone(info.gh) === "green" ? tok("accent-cyan") : tok("blocked-amber") }}
            />
            {ghLabel(info.gh)}
          </p>
        )}

        {pendingRestart && (
          <p className="text-[11px]" style={{ color: tok("blocked-amber") }} role="status">
            Saved <span className="font-mono">{displayPath(info?.configured ?? null)}</span> — restart the runtime to switch to it.
          </p>
        )}

        <label className="flex flex-col gap-1.5">
          <span className="text-[11px]" style={{ color: tok("muted") }}>Repo path</span>
          <input
            className="rounded-md px-3 py-2 font-mono text-[11px] outline-none focus-visible:ring-2"
            style={{ backgroundColor: tok("panel-2"), color: tok("text"), border: `1px solid ${tok("border")}` }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && dirty && !busy && !pinned) void save(draft); }}
            placeholder="/absolute/path/to/your/repo"
            spellCheck={false}
            disabled={busy || pinned}
            aria-label="Workspace repo path"
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void save(draft)}
            disabled={busy || pinned || !dirty}
            className="flex items-center gap-2 rounded-md px-3 py-1.5 text-[12px] outline-none transition-colors focus-visible:ring-2 disabled:opacity-40"
            style={{ backgroundColor: `color-mix(in oklch, ${tok("accent-cyan")} 14%, transparent)`, color: tok("accent-cyan"), border: `1px solid color-mix(in oklch, ${tok("accent-cyan")} 30%, transparent)` }}
          >
            {status === "saving" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <ShieldCheck size={13} aria-hidden />}
            {status === "saving" ? "Validating…" : "Validate & save"}
          </button>
          {window.missionAlpha?.pickFolder && (
            <button
              type="button"
              onClick={() => void pick()}
              disabled={busy || pinned}
              className="flex items-center gap-2 rounded-md px-3 py-1.5 text-[12px] outline-none transition-colors focus-visible:ring-2 disabled:opacity-40"
              style={{ color: tok("muted"), border: `1px solid ${tok("border")}` }}
            >
              <FolderOpen size={13} aria-hidden /> Browse…
            </button>
          )}
        </div>

        {status === "error" && errorMsg && (
          <p className="text-[11px]" style={{ color: tok("stale-red") }} role="alert">{errorMsg}</p>
        )}
        {savedPath && status === "idle" && !pendingRestart && (
          <p className="text-[11px]" style={{ color: tok("muted") }} role="status">Workspace is {displayPath(savedPath)}.</p>
        )}
        {pinned && (
          <p className="text-[11px]" style={{ color: tok("muted") }}>
            Pinned by <span className="font-mono">RUNTIME_REPO_ROOT</span> — unset it to choose a repo here.
          </p>
        )}
      </div>
    </Section>
  );
}

export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const reduce = useReducedMotion();
  const { settings, update } = useSettings();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab") {
        const f = panelRef.current?.querySelectorAll<HTMLElement>(
          'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
        );
        if (!f || f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Settings">
          <motion.div
            className="absolute inset-0"
            style={{ backgroundColor: `color-mix(in oklch, ${tok("bg")} 72%, transparent)` }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.18 }}
            onClick={onClose}
            aria-hidden
          />
          <motion.div
            ref={panelRef}
            className="relative max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-panel border border-border bg-panel p-5 shadow-2xl"
            initial={{ opacity: 0, scale: reduce ? 1 : 0.97, y: reduce ? 0 : 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: reduce ? 1 : 0.98, y: reduce ? 0 : 6 }}
            transition={{ duration: reduce ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-base font-semibold tracking-tight">Settings</h2>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label="Close settings"
                className="rounded-md p-1.5 text-muted outline-none transition-colors hover:text-text focus-visible:ring-2"
              >
                <X size={18} aria-hidden />
              </button>
            </div>

            <Section icon={<Palette size={15} aria-hidden />} title="Appearance" desc="Theme and the primary accent. Status colors (amber / red / green) never change.">
              <ChoiceRow
                label="Theme"
                value={settings.theme}
                options={[{ v: "dark", label: "Dark" }, { v: "light", label: "Light" }]}
                onChange={(v) => update({ theme: v })}
              />
              <div className="flex items-center justify-between gap-4">
                <span className="text-[13px] text-text">Accent</span>
                <div className="flex gap-2" role="group" aria-label="Accent color">
                  {(Object.keys(ACCENTS) as AccentKey[]).map((k) => {
                    const active = settings.accent === k;
                    const swatch = ACCENTS[k][settings.theme].base;
                    return (
                      <button
                        key={k}
                        type="button"
                        aria-pressed={active}
                        aria-label={ACCENTS[k].label}
                        title={ACCENTS[k].label}
                        onClick={() => update({ accent: k })}
                        className="h-6 w-6 rounded-full outline-none transition-transform focus-visible:ring-2"
                        style={{ backgroundColor: swatch, border: `2px solid ${active ? tok("text") : "transparent"}`, transform: active ? "scale(1.1)" : "scale(1)" }}
                      />
                    );
                  })}
                </div>
              </div>
            </Section>

            <Section icon={<Sliders size={15} aria-hidden />} title="Defaults" desc="What new chats and new agents start with.">
              <ChoiceRow
                label="Default model tier"
                value={settings.defaultTier}
                options={MODEL_TIERS.map((t) => ({ v: t.key as ModelTier, label: t.label, hint: t.hint }))}
                onChange={(v) => update({ defaultTier: v })}
              />
              <Toggle
                id="set-autogrant"
                label="Auto-grant connectors to new agents"
                hint="Pre-selects enabled connectors when creating an agent. Per-agent allowlist is still enforced server-side."
                checked={settings.connectorDefaults.autoGrantNewAgents}
                onChange={(v) => update({ connectorDefaults: { autoGrantNewAgents: v } })}
              />
            </Section>

            <Section icon={<ShieldCheck size={15} aria-hidden />} title="Tool-loop & sandbox policy" desc="UI defaults only — the server (classification, approval, sandbox) is always the authority and is never weakened by these.">
              <Toggle
                id="set-confirm"
                label="Confirm every sensitive command"
                hint="When off, SAFE commands still auto-run and SENSITIVE still prompts — this only sets the prompt default."
                checked={settings.toolLoop.confirmEverySensitive}
                onChange={(v) => update({ toolLoop: { confirmEverySensitive: v } })}
              />
              <Toggle
                id="set-net"
                label="Default network access ON for exec"
                hint="Pre-checks the network box in the exec console. Network is still a separately-approved capability."
                checked={settings.sandbox.networkDefaultGranted}
                onChange={(v) => update({ sandbox: { networkDefaultGranted: v } })}
              />
            </Section>

            <Section icon={<Eye size={15} aria-hidden />} title="Accessibility" desc="Override motion preference.">
              <ChoiceRow
                label="Reduce motion"
                value={settings.reduceMotionOverride}
                options={[{ v: "system", label: "System" }, { v: "on", label: "On" }, { v: "off", label: "Off" }]}
                onChange={(v) => update({ reduceMotionOverride: v })}
              />
            </Section>

            <WorkspaceSection />

            {/* 2026-09-07 — the roster's single home. It was mounted on BOTH the squad board
                and the Job board; it is the RULE, reference data that changes about once a
                day, while a scope BREACH now reaches the operator through the queue strip.
                The component is reused verbatim, never re-implemented: a second thing that
                renders a writeScope is a second thing that can misstate one. */}
            <Section
              icon={<ShieldCheck size={15} />}
              title="Roster"
              desc="Every seat on the team and the paths it may write. The broker enforces this server-side; a seat that writes outside it has its files refused, and the refusal now surfaces in the Inbox queue strip."
            >
              <RosterStrip lastEvent={null} />
            </Section>

            <PolicyEditor />

            <AdapterSettings />

            <UserManagement />
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
