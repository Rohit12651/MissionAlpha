import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { Check, Loader2, AlertTriangle, Save, Trash2, SlidersHorizontal, PinOff } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import {
  listAgents,
  getSkills,
  updateAgent,
  deleteAgent,
  type AgentSpec,
  type Skill,
} from "../../lib/factoryClient";
import { runtimeUrl } from "../../lib/runtimeBase";
import { runtimeToken } from "../../lib/runtimeToken";
import { removableKind, removalReason, type RemovableAgent } from "../../lib/agentActions";
import { SkillCatalog } from "./SkillCatalog";
import { PermissionGate } from "../PermissionGate";

// Item 4 / P1-F4 — in-drawer management. Factory-minted agents get an editable skill set
// (Save skills → PATCH) plus an F3-gated Delete. Pool-imported agents get an F3-gated
// Un-pin. The CEO and the built-in swarm agents get NO destructive control at all
// (removableKind → "none") — the section states the reason instead of showing a dead
// button. Factory-violet identity; OKLCH tokens via tok(); no inline hex; reduced-motion
// safe; a11y (aria-live status, focus-visible rings).

type SavePhase = "idle" | "saving" | "done" | "error";

export function AgentManage({
  agentId,
  agent,
  onRemoved,
}: {
  agentId: string;
  /** Board state for this agent — supplies the factory/imported flags the guard needs. */
  agent?: RemovableAgent;
  /** Called after a successful removal so the drawer can close. */
  onRemoved?: () => void;
}) {
  const reduce = useReducedMotion();
  const violet = tok("factory-violet");
  const red = tok("stale-red");
  const green = tok("done-green");
  const guard: RemovableAgent = agent ?? { id: agentId };
  const kind = removableKind(guard);
  const blockedReason = removalReason(guard);

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
      if (kind === "factory") {
        await deleteAgent(agentId);
      } else if (kind === "imported") {
        // Un-pin: drops the board card, leaves the .claude/agents pool file untouched.
        const token = await runtimeToken();
        await fetch(runtimeUrl("/factory/pool/remove"), {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-runtime-token": token },
          body: JSON.stringify({ ids: [agentId] }),
        });
      }
      onRemoved?.();
    } catch {
      // The registry poll reconciles drawer state; nothing to surface here.
    } finally {
      if (mounted.current) {
        setDeleting(false);
        setConfirmDelete(false);
      }
    }
  }, [agentId, kind, onRemoved]);

  // Self-hide before resolution, and for board seeds that have neither a registry spec
  // nor a removal path (nothing to manage → no empty section).
  if (!loaded) return null;
  if (!spec && kind === "none") return null;

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

      {spec ? (
        <>
          <p className="mb-2 text-[11px] text-muted">
            Edit this agent&rsquo;s skill set. Changes apply after you save.
          </p>
          <SkillCatalog skills={skills} selected={picked} onToggle={onToggle} mode="pick" />
        </>
      ) : (
        <p className="mb-2 text-[11px] text-muted">
          Pinned from the agent pool. Un-pinning removes the card from the board; the pool
          definition on disk is untouched, so you can re-add it any time.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {spec && (
          <button
            type="button"
            onClick={onSave}
            disabled={phase === "saving"}
            aria-label="Save skill changes"
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold outline-none transition-colors duration-150 hover:brightness-110 focus-visible:ring-2 disabled:cursor-default disabled:opacity-50 motion-reduce:transition-none"
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
        )}

        {kind === "none" ? (
          <p className="text-[11px]" style={{ color: tok("muted") }}>{blockedReason}</p>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            disabled={deleting}
            aria-label={kind === "imported" ? `Remove ${agentId} from the board` : `Delete agent ${agentId}`}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold outline-none transition-colors duration-150 hover:brightness-110 focus-visible:ring-2 disabled:cursor-default disabled:opacity-50 motion-reduce:transition-none"
            style={{
              color: red,
              backgroundColor: `color-mix(in oklch, ${red} 12%, transparent)`,
              border: `1px solid color-mix(in oklch, ${red} 30%, transparent)`,
              transition: reduce ? "none" : "color 140ms ease-out, background-color 140ms ease-out",
            }}
          >
            {kind === "imported" ? <PinOff size={13} aria-hidden /> : <Trash2 size={13} aria-hidden />}
            {kind === "imported" ? "Remove from board" : "Delete agent"}
          </button>
        )}
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
        title={kind === "imported" ? "Remove this agent from the board?" : "Delete this agent?"}
        summary={
          kind === "imported"
            ? `Un-pins ${agentId} from the board. Its pool definition on disk is left untouched, so you can re-add it any time.`
            : `Permanently removes ${agentId} from the factory registry. This cannot be undone.`
        }
        affected={[agentId]}
        confirmLabel={deleting ? "Removing…" : kind === "imported" ? "Remove from board" : "Delete agent"}
        accent="stale-red"
        onConfirm={onConfirmDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </section>
  );
}
