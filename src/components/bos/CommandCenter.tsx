// B5 — the Command Center (nav id `center`, the cross-venture home, master spec §2).
//
// LAZY BY CONSTRUCTION: App imports this with React.lazy, so none of it — the page, the
// tiles, the two panels, the KPI client — is in the main index chunk (which sits under a
// hard gzip ceiling). Downloaded the first time the BOSS opens the Command Center.
//
// EVERY NUMBER IS REAL OR AN ADMITTED GAP (hallmark gate 56):
//   • The four tiles ride GET /runtime/bos/kpis (window=1d), computed live from the
//     deliveries + vault_records tables. A fetch failure shows "—" plus one retry — never
//     a fabricated zero, which would read as "the business did nothing today".
//   • Decisions / approvals are CROSS-VENTURE (deliveries have no venture column, v1) and
//     labelled so; Records written is venture-scoped. Open follow-ups has no source until
//     B6 → "—", never a fake 0.
//   • The ventures panel and the needs-you panel are the REAL roster and the REAL pending
//     queue, not fixtures. Choosing a venture re-scopes the whole app (ventureScope).
//
// LIVE: re-reads on the badge (a decision), on `vault.written` (a record), on
// `workflow.run` (a cadence fired) and on an SSE resync — the same nonces every other BOS
// page already re-reads on. A refetch is the honest way to recompute a cross-store KPI.

import { useCallback, useEffect, useState } from "react";
import { getKpis, type Kpis } from "../../lib/kpiClient";
import { listInbox, type Delivery } from "../../lib/inboxClient";
import { useVenture } from "../../lib/ventureScope";
import { BosTopbar } from "./BosTopbar";
import { StatTiles } from "./StatTiles";
import { VenturesPanel } from "./VenturesPanel";
import { NeedsYouPanel } from "./NeedsYouPanel";

/** How many pending deliveries the "needs you" panel shows before the Inbox takes over. */
const NEEDS_LIMIT = 5;

export interface CommandCenterProps {
  /** Pending-deliveries badge — doubles as the refetch nonce (a decision moves it). */
  pending: number;
  /** Bumped on every `vault.written` frame — records + ventures re-read live. */
  vaultNonce: number;
  /** Bumped on every `workflow.run` frame — a fired cadence can move the day's numbers. */
  workflowNonce: number;
  /** Bumped on SSE resync — re-baseline after a reconnect. */
  resyncNonce: number;
  /** Deep-link into the Inbox with a delivery selected (B3 initialSelectedId plumb). */
  onOpenDelivery: (id: string) => void;
}

/** A titled panel placeholder for the ventures column while loading / on error. */
function PanelMsg({ title, msg }: { title: string; msg: string }) {
  return (
    <section className="bos-center-panel" aria-label={title}>
      <header className="bos-center-panel-head">
        <h2 className="bos-center-panel-title">{title}</h2>
      </header>
      <p className="bos-center-empty helm-mono">{msg}</p>
    </section>
  );
}

export function CommandCenter({ pending, vaultNonce, workflowNonce, resyncNonce, onOpenDelivery }: CommandCenterProps) {
  // The app-wide scope — read here, and WRITTEN by the ventures panel (scopes everything).
  const { venture, setVenture } = useVenture();
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);

  // ── KPIs (window=1d), venture-scoped. Error → "—" + retry, never a fake 0. ──
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [kpiError, setKpiError] = useState(false);
  useEffect(() => {
    let live = true;
    setKpiError(false);
    getKpis(venture, "1d")
      .then((d) => {
        if (!live) return;
        if (d.error) { setKpis(null); setKpiError(true); }
        else setKpis(d);
      })
      .catch(() => { if (live) { setKpis(null); setKpiError(true); } });
    return () => { live = false; };
  }, [venture, pending, vaultNonce, workflowNonce, resyncNonce, retryNonce]);

  // ── the REAL pending queue (top N) — its own error + retry. ────────────────
  const [needs, setNeeds] = useState<Delivery[]>([]);
  const [needsError, setNeedsError] = useState(false);
  useEffect(() => {
    let live = true;
    setNeedsError(false);
    listInbox({ status: "pending", limit: NEEDS_LIMIT })
      .then((r) => { if (live) setNeeds(r.deliveries ?? []); })
      .catch(() => { if (live) { setNeeds([]); setNeedsError(true); } });
    return () => { live = false; };
  }, [pending, resyncNonce, retryNonce]);

  const scopeName = venture ? (kpis?.ventures.find((v) => v.id === venture)?.name || venture) : null;
  const scopeLabel = scopeName ?? "All ventures";

  return (
    <div className="bos-center">
      <BosTopbar
        eyebrow={`COMMAND CENTER · ${scopeLabel.toUpperCase()}`}
        title="Command center"
        clock
        chips={
          <span className="helm-chip" data-tone={venture ? "green" : "muted"}>
            {scopeLabel}
          </span>
        }
      />

      <StatTiles kpis={kpis} error={kpiError} ventureLabel={scopeLabel} />
      {kpiError && (
        <p className="bos-center-note helm-mono">
          numbers unavailable — runtime not reachable
          <button type="button" className="bos-center-retry helm-mono" onClick={retry}>
            Retry
          </button>
        </p>
      )}

      <div className="bos-center-cols">
        {kpiError ? (
          <PanelMsg title="Ventures" msg="ventures unavailable — runtime not reachable" />
        ) : kpis === null ? (
          <PanelMsg title="Ventures" msg="reading the numbers…" />
        ) : (
          <VenturesPanel ventures={kpis.ventures} current={venture} onChoose={setVenture} />
        )}
        <NeedsYouPanel deliveries={needs} error={needsError} onOpen={onOpenDelivery} onRetry={retry} />
      </div>
    </div>
  );
}
