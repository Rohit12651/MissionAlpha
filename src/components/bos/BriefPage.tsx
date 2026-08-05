// B3 — the CEO brief (nav id `brief`, master spec §4). The Captain's console on top,
// the last-24h agent log under it.
//
// LAZY BY CONSTRUCTION: App imports this with React.lazy, so none of it — the page, the
// console, the dial, the log — is in the main index chunk. The main index sits under a
// hard 194,560 B gzip ceiling; the brief must not spend it.
//
// EVERY LINE IS REAL OR AN ADMITTED GAP:
//   • the log rows are the runtime's OWN events_log (GET /runtime/brief/log), not a
//     fixture — an empty log says so, and a failed read says so plus Retry;
//   • the "Last brief" chip is the newest row's real stamp, or an honest "—";
//   • the console's routing is a DETERMINISTIC KEYWORD TABLE server-side, and the
//     confirmation names the keyword that decided it. Nothing here calls it AI.
//
// LIVE: consumes the app-wide SSE subscription through `lastEvent` (App already holds
// it) and PREPENDS matching frames without a refetch. `liveNonce` (bumped on every SSE
// resync) triggers the authoritative re-read — the same push-first / poll-never-removed
// contract the Inbox uses.
//
// CONTAINER/PRESENTATIONAL: the page owns the fetch, the live merge and the retry so
// the topbar chip and the log read ONE array. (Plan §T3 sketched the fetch inside
// AgentLog; hoisting it avoids either a second fetch or a child→parent callback for the
// chip, and the observable behaviour is identical.)

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_BRIEF_HOURS,
  getBriefLog,
  lastBriefLabel,
  logRow,
  logRows,
  prependRow,
  routedRow,
  type CaptainRouted,
  type LogRow,
} from "../../lib/briefClient";
import { useTick } from "../../lib/ticker";
import type { RuntimeEvent } from "../../lib/useRuntimeEvents";
import { BosTopbar } from "./BosTopbar";
import { CaptainConsole } from "./CaptainConsole";
import { AgentLog } from "./AgentLog";

export interface BriefPageProps {
  /** The venture scope from the sidebar switcher; null = all ventures. */
  venture: string | null;
  /** Newest catalog frame from the app-wide SSE subscription. */
  lastEvent: RuntimeEvent | null;
  /** Bumped on every SSE resync — triggers the authoritative re-read. */
  liveNonce: number;
  /** Deep-link into the Inbox with that delivery selected. */
  onOpenDelivery: (deliveryId: string) => void;
}

/** The topbar chip. Its own component so only IT re-renders on the 1s tick. */
function LastBriefChip({ rows }: { rows: LogRow[] | null }) {
  const nowMs = useTick();
  const label = lastBriefLabel(rows, nowMs);
  return (
    <span className="helm-chip" data-tone={label === "—" ? undefined : "brass"}>
      Last brief {label}
    </span>
  );
}

export function BriefPage({ venture, lastEvent, liveNonce, onOpenDelivery }: BriefPageProps) {
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [error, setError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  // ── authoritative read (mount · SSE resync · Retry) ───────────────────────
  useEffect(() => {
    let live = true;
    setError(false);
    getBriefLog(DEFAULT_BRIEF_HOURS)
      .then((r) => { if (live) setRows(logRows(r.events)); })
      .catch(() => { if (live) { setRows(null); setError(true); } });
    return () => { live = false; };
  }, [liveNonce, retryNonce]);

  // ── live tail ─────────────────────────────────────────────────────────────
  // A frame outside the closed brief catalog maps to null and is ignored, so the log
  // can never grow a row for an event it does not know how to label. Rows are only
  // prepended once the first authoritative read has landed — otherwise a frame arriving
  // during the initial fetch would render a one-row log that looks like the whole day.
  const lastEventRef = useRef<RuntimeEvent | null>(null);
  useEffect(() => {
    if (!lastEvent || lastEvent === lastEventRef.current) return;
    lastEventRef.current = lastEvent;
    setRows((prev) => (prev === null ? prev : prependRow(prev, logRow(lastEvent))));
  }, [lastEvent]);

  // ── the console's optimistic line ─────────────────────────────────────────
  // Keyed on the record the runtime ACTUALLY minted, so the `vault.written` frame that
  // follows a moment later is recognised as the same event instead of duplicating it.
  const onRouted = useCallback((r: CaptainRouted, text: string) => {
    setRows((prev) => prependRow(prev ?? [], routedRow(r, text)));
  }, []);

  const scopeLabel = (venture ?? "all ventures").toUpperCase();

  return (
    <div className="bos-deck bos-brief">
      <BosTopbar
        eyebrow={`CAPTAIN'S CONSOLE · ${scopeLabel}`}
        title="Daily brief"
        chips={<LastBriefChip rows={rows} />}
      />
      <div className="bos-brief-grid">
        <CaptainConsole onRouted={onRouted} />
        <AgentLog
          rows={rows}
          error={error}
          onRetry={() => setRetryNonce((n) => n + 1)}
          onOpenDelivery={onOpenDelivery}
        />
      </div>
    </div>
  );
}
