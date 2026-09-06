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
import { ActivityStream } from "./ActivityStream";
import { EngineReadinessBanner } from "./EngineReadinessBanner";
import { DoctorStrip } from "./DoctorStrip";
import { SelfGradeTile } from "./SelfGradeTile";
import { getSelfGrade, type SelfGrade, type SelfGradeFrame } from "../../lib/selfGrade";
import { getDoctorReport, type DoctorReport } from "../../lib/doctorStatus";
import { getEngineReadiness, type EngineReadiness } from "../../lib/engineReadiness";
import type { ActivityRow } from "../../lib/activityStream";

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
  /** Bumped by every `doctor.status` frame — the report is re-READ, never reconstructed. */
  doctorNonce: number;
  /** Bumped by every `selfgrade.changed` frame — the grade is re-READ from the route. */
  selfGradeNonce: number;
  /** The last frame itself. Kept because `delta` exists ONLY on the wire, not on the route. */
  selfGradeFrame: SelfGradeFrame | null;
  /** Deep-link into the Inbox with a delivery selected (B3 initialSelectedId plumb). */
  onOpenDelivery: (id: string) => void;
  /**
   * Phase 2 — take the operator to Accounts, where the capability probe lives. The
   * readiness banner names a missing MEASUREMENT as the blocker; this is the control that
   * takes it. Offering a remedy the operator cannot reach is the same defect as offering
   * one that cannot succeed.
   */
  onOpenAccounts: () => void;
  /**
   * Phase 5 — the activity feed. The buffer is owned by App, which holds the app's ONE
   * SSE subscription; this page only renders it. Keeping the state up there means the
   * feed keeps filling while the operator is on another page, so the rail shows history
   * instead of starting empty every time they come back.
   */
  activity: ActivityRow[];
  activityConnected: boolean;
  activityOpen: boolean;
  onToggleActivity: () => void;
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

export function CommandCenter({
  pending,
  vaultNonce,
  workflowNonce,
  resyncNonce,
  doctorNonce,
  selfGradeNonce,
  selfGradeFrame,
  onOpenDelivery,
  onOpenAccounts,
  activity,
  activityConnected,
  activityOpen,
  onToggleActivity,
}: CommandCenterProps) {
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

  // ── Phase 2 — engine readiness. Re-read on the same nonces the rest of this page uses,
  // because an operator who probes an account in another tab must not have to reload to
  // see the banner clear. A transport failure is its own state: "we could not ask" is
  // never rendered as "the engine cannot run".
  const [readiness, setReadiness] = useState<EngineReadiness | null>(null);
  const [readinessError, setReadinessError] = useState(false);
  useEffect(() => {
    let live = true;
    setReadinessError(false);
    getEngineReadiness()
      .then((r) => { if (live) setReadiness(r); })
      .catch(() => { if (live) { setReadiness(null); setReadinessError(true); } });
    return () => { live = false; };
  }, [pending, resyncNonce, workflowNonce, retryNonce]);

  // ── Phase 1 / R4 — the doctor report. Re-read on the doctor frame AND on this page's own
  // nonces, so a fault fixed in another tab clears here without a reload.
  //
  // A transport failure sets NO state. Unlike readiness — which renders "we could not ask"
  // as its own honest line — a doctor strip that cannot read is simply silent: painting a
  // red strip from a failed fetch would report the network as an install fault.
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  useEffect(() => {
    let live = true;
    getDoctorReport()
      .then((r) => { if (live) setDoctorReport(r); })
      .catch(() => { if (live) setDoctorReport(null); });
    return () => { live = false; };
  }, [doctorNonce, pending, resyncNonce, retryNonce]);

  // ── Phase 3 / R9 — the configuration self-grade. Same read-on-frame shape as the
  // doctor: the frame says the number moved, the gated route says what it now is.
  const [selfGrade, setSelfGrade] = useState<SelfGrade | null>(null);
  useEffect(() => {
    let live = true;
    getSelfGrade()
      .then((g) => { if (live) setSelfGrade(g); })
      .catch(() => { if (live) setSelfGrade(null); });
    return () => { live = false; };
  }, [selfGradeNonce, pending, resyncNonce, retryNonce]);

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

      {/* Phase 2 — ABOVE the tiles: whether the swarm can act at all outranks what it did
          today. An operator who reads the numbers first and the blocker second has already
          queued work that cannot run. */}
      <EngineReadinessBanner
        readiness={readiness}
        error={readinessError}
        onOpenAccounts={onOpenAccounts}
        onRetry={retry}
      />

      {/* Directly UNDER the readiness banner, and excluding the check that banner already
          owns. Two stacked lines both saying "no active account" is how an operator learns
          to skip the whole region — see doctorStatus.ts READINESS_OWNED. */}
      <DoctorStrip report={doctorReport} onRecheck={retry} />

      {/* Posture sits with health, above the activity numbers: "can this install be
          trusted to act" outranks "what did it do today", the same ordering argument the
          readiness banner already makes against the KPI tiles. */}
      <SelfGradeTile grade={selfGrade} lastFrame={selfGradeFrame} />

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

      {/* Phase 5 — the activity rail. A collapsible row under the columns rather than a
          fixed side rail: .bos-center is a single scrolling column, and a third grid
          track would collapse to unusable width at 768px, where this page already
          stacks. Collapsed state persists in settings (App owns the key). */}
      <div className="bos-center-activity">
        <ActivityStream
          rows={activity}
          connected={activityConnected}
          open={activityOpen}
          onToggle={onToggleActivity}
        />
      </div>
    </div>
  );
}
