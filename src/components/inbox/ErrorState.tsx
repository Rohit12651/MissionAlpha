import { AlertTriangle } from "lucide-react";

/**
 * Fetch-failed state. Shows the real failure text (already scrubbed server-side
 * on every /inbox egress path) plus a retry — never a silent empty list, which
 * would read as "no work" when the truth is "we could not ask".
 */
export function ErrorState({
  message,
  onRetry,
  busy,
}: {
  message: string;
  onRetry?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="helm-note flex flex-col items-center gap-3" data-tone="red" role="alert">
      <AlertTriangle size={20} aria-hidden />
      <span className="helm-display" style={{ fontSize: 14, color: "var(--helm-red)" }}>
        Could not reach the Inbox
      </span>
      <span style={{ color: "var(--helm-paper-dim)" }}>{message}</span>
      {onRetry && (
        <button
          type="button"
          className="helm-btn"
          data-variant="quiet"
          data-busy={busy ? "true" : undefined}
          disabled={busy}
          onClick={onRetry}
        >
          {busy ? "Retrying…" : "Retry"}
        </button>
      )}
    </div>
  );
}
