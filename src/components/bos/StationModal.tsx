// B1 — the station's skill sheet.
//
// a11y mirrors the shipped ReviewPane overlay exactly: role="dialog" + aria-modal,
// ESC closes, Tab is trapped inside the panel, and focus is restored to whatever
// opened it. The repo has no useFocusTrap hook (searched src/hooks — the directory
// does not exist), so the trap is the same minimal one ReviewPane already ships.
//
// Every row is REAL: the skills listed are the exact catalog ids on this station's
// registry spec. Their SCHEDULED runs do not exist yet, and each row says so instead
// of showing a fake last-run time.

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { AgentState } from "../../data/types";
import { BADGE_LABEL, BADGE_TONE, stationBadge, type StationDef } from "../../lib/stationMeta";

export interface StationModalProps {
  station: StationDef;
  /** The live agent behind the station, if the state feed carries it. */
  agent: AgentState | null;
  onClose: () => void;
  /** The deck's one creation path — the existing Agent Factory. */
  onOpenFactory: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function StationModal({ station, agent, onClose, onOpenFactory }: StationModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const badge = stationBadge(agent);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const node = panelRef.current;
    node?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
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
  }, [onClose, station.id]);

  const titleId = `bos-station-${station.id}-title`;

  return (
    <div
      className="bos-deck-overlay"
      // backdrop click closes, exactly like the mockup's closeModalBg
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        className="bos-deck-modal"
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="bos-deck-modal-head">
          <div className="min-w-0">
            <p className="bos-deck-eyebrow helm-mono">
              {station.role} · {BADGE_LABEL[badge]}
            </p>
            <h2 id={titleId} className="bos-deck-modal-title">
              {station.name}
            </h2>
          </div>
          <span className="helm-chip" data-tone={BADGE_TONE[badge]}>
            {BADGE_LABEL[badge]}
          </span>
          <button type="button" className="bos-deck-x" onClick={onClose} aria-label={`Close ${station.name}`}>
            <X size={15} aria-hidden />
          </button>
        </div>

        <p className="bos-deck-modal-desc">{station.blurb}</p>

        <ul className="bos-deck-skills">
          {station.skills.map((s) => (
            <li key={s.id} className="bos-deck-skill">
              <span className="bos-deck-skill-name">{s.label}</span>
              <span className="bos-deck-skill-id helm-mono">{s.id}</span>
              <span className="bos-deck-tag helm-mono">SKILL</span>
              <span className="bos-deck-tag bos-deck-tag--faint helm-mono" title="Scheduled runs and cadences land in B4">
                runs land in B4
              </span>
            </li>
          ))}
        </ul>

        <div className="bos-deck-modal-foot">
          <button type="button" className="bos-deck-cta" onClick={onOpenFactory}>
            + New station
          </button>
        </div>
      </div>
    </div>
  );
}
