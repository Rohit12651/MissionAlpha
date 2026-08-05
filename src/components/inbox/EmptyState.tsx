import { Inbox } from "lucide-react";

/**
 * Zero-Delivery state. Two honest variants: nothing has arrived at all, or the
 * active filter matched nothing. Never invents a count or a next step it can't
 * deliver — the only claim it makes is the one the runtime actually guarantees
 * (work arrives here by itself; no refresh is needed).
 */
export function EmptyState({ filtered, onClear }: { filtered?: boolean; onClear?: () => void }) {
  return (
    <div className="helm-note flex flex-col items-center gap-3 py-10" role="status">
      <Inbox size={22} aria-hidden style={{ color: "var(--helm-paper-faint)" }} />
      {filtered ? (
        <>
          <span>No delivery matches this filter.</span>
          {onClear && (
            <button type="button" className="helm-btn" data-variant="quiet" onClick={onClear}>
              Show all
            </button>
          )}
        </>
      ) : (
        <>
          <span className="helm-display" style={{ fontSize: 15 }}>
            Inbox clear
          </span>
          <span style={{ color: "var(--helm-paper-faint)" }}>
            Finished agent work lands here on its own. Nothing to decide right now.
          </span>
        </>
      )}
    </div>
  );
}
