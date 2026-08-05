// B4 — the workflow drawer: one cadence's detail sheet + its two write actions.
//
// a11y mirrors the shipped StationModal/ReviewPane overlay: role="dialog" + aria-modal,
// ESC closes, Tab is trapped inside the panel, and focus is restored to whatever opened
// it. It slides from the right (transform + opacity only, ≤240ms, hover/no-op under
// reduced-motion via bos.css) — nothing animates layout.
//
// EVERY ROW IS REAL: the schedule, the station and the run history come from the cadence
// record + the live `workflow.run` frames the page already holds. Nothing is fabricated.
//
// WRITES: Run-now is F3-gated — dispatching a real task unattended is consequential, so
// the operator confirms through the reused PermissionGate before it fires. Pause/Resume
// toggles inline. Both show a busy state and surface a 403/404/500 inline — never silent.
// NO innerHTML anywhere: every string reaches the DOM as a React text node.

import { useEffect, useRef, useState } from "react";
import { X, Play, Pause } from "lucide-react";
import { PermissionGate } from "../PermissionGate";
import {
  cadenceLabel,
  cadenceStatus,
  lastRunLabel,
  nextRunLabel,
  runCadence,
  skillLabel,
  stationName,
  toggleCadence,
  type Cadence,
} from "../../lib/cadenceClient";

export interface RunEvent {
  at: number;
  status: string;
}

export interface WorkflowDrawerProps {
  cadence: Cadence;
  /** Ticking wall-clock ms for the live countdown/relative labels. */
  now: number;
  /** Recent runs for this cadence (newest first) — the page builds it from workflow.run. */
  history: RunEvent[];
  onClose: () => void;
  /** Called after a successful run/toggle so the page re-reads authoritative state. */
  onChanged: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const MAX_HISTORY = 10;

const runTime = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
};

export function WorkflowDrawer({ cadence, now, history, onClose, onChanged }: WorkflowDrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
  const [busy, setBusy] = useState<null | "run" | "toggle">(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const node = panelRef.current;
    node?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Let the confirm gate own ESC while it is open (it closes itself).
        if (gateOpen) return;
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !node) return;
      const f = node.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      restoreRef.current?.focus?.();
    };
  }, [onClose, cadence.id, gateOpen]);

  const status = cadenceStatus(cadence);
  const titleId = `bos-wf-${cadence.id}-title`;

  const doRun = async () => {
    setGateOpen(false);
    setBusy("run");
    setError(null);
    setNote(null);
    try {
      const r = await runCadence(cadence.id);
      if (r.error) { setError(r.error); return; }
      setNote(r.deduped ? "Already running this slot — no duplicate dispatched." : "Dispatched — watch the Inbox for the result.");
      onChanged();
    } catch {
      setError("could not reach the runtime — nothing was dispatched");
    } finally {
      setBusy(null);
    }
  };

  const doToggle = async () => {
    setBusy("toggle");
    setError(null);
    setNote(null);
    try {
      const r = await toggleCadence(cadence.id, !cadence.enabled);
      if (r.error) { setError(r.error); return; }
      onChanged();
    } catch {
      setError("could not reach the runtime — the schedule is unchanged");
    } finally {
      setBusy(null);
    }
  };

  const recent = history.slice(0, MAX_HISTORY);

  return (
    <div
      className="bos-wf-drawer-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        className="bos-wf-drawer"
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="bos-wf-drawer-head">
          <div className="min-w-0">
            <p className="bos-deck-eyebrow helm-mono">
              {stationName(cadence.agent)} · {cadenceLabel(cadence)}
            </p>
            <h2 id={titleId} className="bos-wf-drawer-title">{skillLabel(cadence.skill)}</h2>
          </div>
          <span className="helm-chip" data-tone={status.tone}>● {status.label}</span>
          <button type="button" className="bos-deck-x" onClick={onClose} aria-label={`Close ${skillLabel(cadence.skill)}`}>
            <X size={15} aria-hidden />
          </button>
        </div>

        <p className="bos-wf-drawer-desc">
          Standing {skillLabel(cadence.skill).toLowerCase()} cadence for the {stationName(cadence.agent)} station. It runs
          on schedule with no human input and writes its findings to shared memory; a failed run surfaces in the Inbox.
        </p>

        <dl className="bos-wf-facts">
          <div className="bos-wf-fact">
            <dt className="helm-mono">NEXT RUN</dt>
            <dd className="helm-mono">{nextRunLabel(cadence.next_run, now)}</dd>
          </div>
          <div className="bos-wf-fact">
            <dt className="helm-mono">LAST RUN</dt>
            <dd className="helm-mono">{lastRunLabel(cadence.last_run, now)}</dd>
          </div>
          <div className="bos-wf-fact">
            <dt className="helm-mono">SKILL</dt>
            <dd className="helm-mono">{cadence.skill}</dd>
          </div>
        </dl>

        <div className="bos-wf-history">
          <p className="bos-wf-history-head helm-mono">RECENT RUNS</p>
          {recent.length === 0 ? (
            <p className="bos-wf-note helm-mono">no runs yet — it has not fired since this session opened</p>
          ) : (
            <ul className="bos-wf-history-list">
              {recent.map((h, i) => (
                <li key={`${h.at}-${i}`} className="bos-wf-history-row">
                  <span className="helm-mono bos-wf-history-time">{runTime(h.at)}</span>
                  <span className="helm-mono bos-wf-history-status" data-status={h.status}>{h.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bos-wf-drawer-foot">
          <button
            type="button"
            className="bos-deck-cta bos-wf-run"
            onClick={() => setGateOpen(true)}
            disabled={busy !== null}
            data-busy={busy === "run" || undefined}
          >
            <Play size={13} aria-hidden />
            {busy === "run" ? "Running…" : "Run now"}
          </button>
          <button
            type="button"
            className="bos-wf-toggle"
            onClick={doToggle}
            disabled={busy !== null}
            data-busy={busy === "toggle" || undefined}
          >
            {cadence.enabled ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}
            {busy === "toggle" ? (cadence.enabled ? "Pausing…" : "Resuming…") : (cadence.enabled ? "Pause" : "Resume")}
          </button>
        </div>

        {error && <p className="bos-wf-error helm-mono" role="alert">{error}</p>}
        {note && !error && <p className="bos-wf-ack helm-mono" role="status">{note}</p>}
      </div>

      <PermissionGate
        open={gateOpen}
        title={`Run ${skillLabel(cadence.skill)} now`}
        summary={`This dispatches a real ${stationName(cadence.agent)} task immediately, ahead of its schedule. It runs unattended and its result lands in the Inbox.`}
        affected={[cadence.agent]}
        confirmLabel="Run now"
        accent="accent-cyan"
        onConfirm={() => void doRun()}
        onCancel={() => setGateOpen(false)}
      />
    </div>
  );
}
