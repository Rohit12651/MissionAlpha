import { useEffect, useState } from "react";

/**
 * Live-connection banner (program plan §5.4). The SSE bus is the push path; the
 * 2s /api/state.json poll is the decoupled fallback and is NEVER gated on this
 * banner — so the app stays usable while this is showing. Copy says exactly that,
 * because "disconnected" alone reads as "the app is broken", which is false.
 *
 * The countdown is derived from the hook's `retryAt` (absolute epoch ms), so it
 * never drifts against the reconnect timer that actually fires.
 */
export function SseDisconnectedBanner({
  retryAt,
  onRetryNow,
}: {
  retryAt: number | null;
  onRetryNow: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const secs = retryAt == null ? null : Math.max(0, Math.ceil((retryAt - now) / 1000));

  return (
    <div className="helm-banner" role="status" aria-live="polite">
      <span className="helm-pulse" aria-hidden />
      <span>
        Live updates offline — the board keeps polling, so nothing is lost.
        {secs != null && secs > 0 ? ` Reconnecting in ${secs}s.` : " Reconnecting…"}
      </span>
      <button
        type="button"
        className="helm-btn"
        data-variant="quiet"
        onClick={onRetryNow}
        style={{ marginLeft: "auto" }}
      >
        Retry now
      </button>
    </div>
  );
}
