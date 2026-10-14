/**
 * Fetch-failed state. Phase G (ADR G-2): the mockup's `.alert`. Shows the real failure
 * text (already scrubbed server-side on every /inbox egress path) plus a retry — never a
 * silent empty list, which would read as "no work" when the truth is "we could not ask".
 */
export function ErrorState({ message, onRetry, busy }: { message: string; onRetry?: () => void; busy?: boolean }) {
  return (
    <div className="alert" role="alert">
      <span className="dot bad" style={{ marginTop: 7 }} />
      <div>
        <b>Could not reach the Inbox</b>
        <p style={{ margin: "4px 0 8px" }}>{message}</p>
        {onRetry && (
          <button type="button" className="btn btn-ghost" disabled={busy} aria-busy={busy || undefined} onClick={onRetry}>
            {busy ? "Retrying…" : "Retry"}
          </button>
        )}
      </div>
    </div>
  );
}
