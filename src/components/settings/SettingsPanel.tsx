// Settings panel (ADR-040 / gap #26). A focus-trapped modal over the cockpit:
// Appearance · Defaults · Policy · Accessibility. All values persist via the
// settings store. Policy toggles are CLIENT DEFAULTS only — they pre-fill the
// existing gated flows and never weaken server-side enforcement (see ADR-040 §3).

import { useEffect, useRef, useState, useCallback } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X, Palette, Sliders, ShieldCheck, Eye, FolderOpen, Loader2 } from "lucide-react";
import { useSettings } from "../../lib/settingsContext";
import { ACCENTS, type AccentKey } from "../../lib/settings";
import { MODEL_TIERS, type ModelTier } from "../../lib/modelTiers";
import { tok } from "../../lib/agentMeta";

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

function ProjectSection() {
  const [folder, setFolder] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  // Load current folder on mount (Electron only).
  useEffect(() => {
    window.missionAlpha?.getRepoRoot?.().then((p) => setFolder(p ?? null)).catch(() => {});
  }, []);

  const pick = useCallback(async () => {
    setStatus("loading");
    setErrorMsg("");
    try {
      const picked = await window.missionAlpha?.pickFolder?.();
      if (!picked) { setStatus("idle"); return; }
      const result = await window.missionAlpha?.setRepoRoot?.(picked);
      if (result?.ok) {
        setFolder(picked);
        setStatus("idle");
      } else {
        setErrorMsg(result?.error ?? "Failed to set folder");
        setStatus("error");
      }
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : "Unknown error");
      setStatus("error");
    }
  }, []);

  const displayPath = folder
    ? folder.replace(/^\/Users\/[^/]+/, "~")
    : "Not set — agents write to the bundle directory";

  return (
    <Section icon={<FolderOpen size={15} aria-hidden />} title="Project Folder" desc="Where agents read and write files. Changing this restarts the runtime.">
      <div className="flex flex-col gap-2">
        <div
          className="rounded-md px-3 py-2 font-mono text-[11px] break-all"
          style={{ backgroundColor: tok("panel-2"), color: folder ? tok("text") : tok("muted"), border: `1px solid ${tok("border")}` }}
          aria-label="Current project folder"
        >
          {displayPath}
        </div>
        <button
          type="button"
          onClick={pick}
          disabled={status === "loading" || !window.missionAlpha?.pickFolder}
          className="flex items-center gap-2 self-start rounded-md px-3 py-1.5 text-[12px] outline-none transition-colors focus-visible:ring-2 disabled:opacity-40"
          style={{ backgroundColor: `color-mix(in oklch, ${tok("accent-cyan")} 14%, transparent)`, color: tok("accent-cyan"), border: `1px solid color-mix(in oklch, ${tok("accent-cyan")} 30%, transparent)` }}
          aria-label="Choose project folder"
        >
          {status === "loading" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <FolderOpen size={13} aria-hidden />}
          {status === "loading" ? "Restarting runtime…" : folder ? "Change folder" : "Choose folder"}
        </button>
        {status === "error" && (
          <p className="text-[11px]" style={{ color: tok("stale-red") }} role="alert">{errorMsg}</p>
        )}
        {!window.missionAlpha?.pickFolder && (
          <p className="text-[11px]" style={{ color: tok("muted") }}>Only available in the packaged desktop app.</p>
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

            <ProjectSection />
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
