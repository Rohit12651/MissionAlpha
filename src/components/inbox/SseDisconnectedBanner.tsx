import { useEffect, useState } from "react";

/**
 * Live-connection banner (program plan §5.4). APP-ONLY state — the mockup is always live —
 * restyled as the mockup's `.alert`. The SSE bus is the push path; the 2s state poll is the
 * decoupled fallback and is NEVER gated on this banner, so the copy says nothing is lost.
 * The countdown derives from the hook's absolute `retryAt`, so it never drifts.
 */
export function SseDisconnectedBanner({ retryAt, onRetryNow }: { retryAt: number | null; onRetryNow: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = retryAt == null ? null : Math.max(0, Math.ceil((retryAt - now) / 1000));
  return (
    <div className="alert" role="status" aria-live="polite" data-app-only="sse-offline" style={{ marginBottom: 16 }}>
      <span className="dot warn live" style={{ marginTop: 7 }} />
      <div>
        {"Live updates offline. The inbox keeps polling, so nothing is lost. "}
        <span className="sub">{secs != null && secs > 0 ? `reconnecting in ${secs}s · ` : "reconnecting · "}</span>
        <button type="button" className="linkish" onClick={onRetryNow}>Retry now</button>
      </div>
    </div>
  );
}
