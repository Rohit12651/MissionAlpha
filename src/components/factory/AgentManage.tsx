import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { Check, Loader2, AlertTriangle, Save, Trash2, SlidersHorizontal } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import {
  listAgents,
  getSkills,
  updateAgent,
  deleteAgent,
  type AgentSpec,
  type Skill,
} from "../../lib/factoryClient";
import { SkillCatalog } from "./SkillCatalog";
import { PermissionGate } from "../PermissionGate";

// Item 4 — in-drawer management for CREATED (factory-registry) agents only. Built-in
// agents are NOT in the factory registry, so this self-hides (returns null) for them —
// no dead buttons. Created agents get an editable skill set (Save skills → PATCH) and
// a permission-gated Delete. Factory-violet identity; OKLCH tokens via tok(); no inline
// hex; reduced-motion safe; a11y (aria-live status, focus-visible rings).

type SavePhase = "idle" | "saving" | "done" | "error";

export function AgentManage({ agentId }: { agentId: string }) {
  const reduce = useReducedMotion();
  const violet = tok("factory-violet");
  const red = tok("stale-red");
  const green = tok("done-green");

  const [spec, setSpec] = useState<AgentSpec | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<SavePhase>("idle");
  const [toast, setToast] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Resolve whether this is a created (registry) agent. If not found → render nothing.
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setSpec(null);
    setPhase("idle");
    setToast("");
    void (async () => {
      try {
        const [a, s] = await Promise.all([listAgents(), getSkills()]);
        if (cancelled || !mounted.current) return;
        const found = a.agents.find((x) => x.id === agentId) ?? null;
        setSkills(s.skills ?? []);
        setSpec(found);
        setPicked(new Set(found?.skills ?? []));
      } catch {
        if (cancelled || !mounted.current) return;
        setSpec(null);
      } finally {
        if (!cancelled && mounted.current) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => {
      if (mounted.current) setToast("");
    }, 4000);
  }, []);

  const onToggle = useCallback((id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setPhase("idle");
  }, []);

  const onSave = useCallback(async () => {
    setPhase("saving");
    try {
      const res = await updateAgent(agentId, { skills: [...picked] });
      if (!mounted.current) return;
      if (res.error) {
        setPhase("error");
        flash("");
        setToast(res.error);
      } else {
        setPhase("done");
        if (res.spec) setSpec(res.spec);
        flash("Skills saved");
      }
    } catch (e) {
      if (!mounted.current) return;
      setPhase("error");
      setToast((e as Error).message);
    }
  }, [agentId, picked, flash]);

  const onConfirmDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await deleteAgent(agentId);
    } catch {
      // The registry poll reconciles drawer state; nothing to surface here.
    } finally {
      if (mounted.current) {
        setDeleting(false);
        setConfirmDelete(false);
      }
    }
  }, [agentId]);

  // Self-hide: built-ins (not in registry) and pre-resolution render nothing.
  if (!loaded || !spec) return null;

  return (
    <section
      className="border-t px-5 py-4"
      style={{ borderColor: `color-mix(in oklch, ${violet} 24%, var(--c-border))` }}
      aria-label="Manage agent"
    >
      <h3
        className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest"
        style={{ color: violet }}
      >
        <SlidersHorizontal size={13} aria-hidden />
        Manage agent
      </h3>

      {/* editable skill set */}
      <p className="mb-2 text-[11px] text-muted">
        Edit this agent&rsquo;s skill set. Changes apply after you save.
      </p>
      <SkillCatalog skills={skills} selected={picked} onToggle={onToggle} mode="pick" />

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={phase === "saving"}
          aria-label="Save skill changes"
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold outline-none focus-visible:ring-2 disabled:cursor-default disabled:opacity-50"
          style={{
            color: phase === "done" ? green : phase === "error" ? red : violet,
            backgroundColor: `color-mix(in oklch, ${phase === "done" ? green : phase === "error" ? red : violet} 14%, transparent)`,
            border: `1px solid color-mix(in oklch, ${phase === "done" ? green : phase === "error" ? red : violet} 34%, transparent)`,
            transition: reduce ? "none" : "color 140ms ease-out, background-color 140ms ease-out",
          }}
        >
          {phase === "saving" ? (
            <Loader2 size={13} className={reduce ? "" : "animate-spin"} aria-hidden />
          ) : phase === "done" ? (
            <Check size={13} aria-hidden />
          ) : phase === "error" ? (
            <AlertTriangle size={13} aria-hidden />
          ) : (
            <Save size={13} aria-hidden />
          )}
          {phase === "saving"
            ? "Saving…"
            : phase === "done"
              ? "Saved"
              : phase === "error"
                ? "Retry save"
                : "Save skills"}
        </button>

        <button
          type="button"
          onClick={() => setConfirmDelete(true)}
          aria-label={`Delete agent ${agentId}`}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold outline-none focus-visible:ring-2"
          style={{
            color: red,
            backgroundColor: `color-mix(in oklch, ${red} 12%, transparent)`,
            border: `1px solid color-mix(in oklch, ${red} 30%, transparent)`,
            transition: reduce ? "none" : "color 140ms ease-out, background-color 140ms ease-out",
          }}
        >
          <Trash2 size={13} aria-hidden /> Delete agent
        </button>
      </div>

      {toast && (
        <p
          className="mt-2 inline-flex items-center gap-1.5 font-mono text-[10px]"
          style={{ color: phase === "error" ? red : green }}
          role="status"
          aria-live="polite"
        >
          {phase === "error" ? <AlertTriangle size={11} aria-hidden /> : <Check size={11} aria-hidden />}
          {toast}
        </p>
      )}

      <PermissionGate
        open={confirmDelete}
        title="Delete this agent?"
        summary={`Permanently removes ${agentId} from the factory registry. This cannot be undone.`}
        affected={[agentId]}
        confirmLabel={deleting ? "Deleting…" : "Delete agent"}
        accent="stale-red"
        onConfirm={onConfirmDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </section>
  );
}
