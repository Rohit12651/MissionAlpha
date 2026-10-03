// B5 — the Command Center (nav id `center`, the cross-venture home, master spec §2).
//
// LAZY BY CONSTRUCTION: App imports this with React.lazy, so none of it — the page, the
// tiles, the two panels, the KPI client — is in the main index chunk (which sits under a
// hard gzip ceiling). Downloaded the first time the BOSS opens the Command Center.
//
// EVERY NUMBER IS REAL OR AN ADMITTED GAP (hallmark gate 56):
//   • Phase G (D-7): the four tiles are the mockup's questions bound to real routes —
//     /runtime/jobs, the pending badge, /runtime/bos/kpis jobsShipped, /runtime/spend. A
//     fetch failure shows "—", never a fabricated zero (see StatTiles.tsx).
//   • The ventures panel and the needs-you panel are the REAL roster and the REAL pending
//     queue, not fixtures. Choosing a venture re-scopes the whole app (ventureScope).
//
// LIVE: re-reads on the badge (a decision), on `vault.written` (a record), on
// `workflow.run` (a cadence fired) and on an SSE resync — the same nonces every other BOS
// page already re-reads on. A refetch is the honest way to recompute a cross-store KPI.

import { useCallback, useEffect, useState } from "react";
import { getKpis, type Kpis } from "../../lib/kpiClient";
import { fetchJobs } from "../../lib/jobsClient";
import { getSpend } from "../../lib/ledgerClient";
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
  /** False until the first authoritative pending read: the Need-you tile reads "—", not 0. */
  pendingKnown: boolean;
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

export function CommandCenter({
  pending,
  pendingKnown,
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

  // ── Phase G (D-7) — the mockup's "Active jobs" and "Spend today" tiles. Each has its
  // own error: one route failing must not blank the other three numbers.
  const [activeJobs, setActiveJobs] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    fetchJobs()
      .then((js) => { if (live) setActiveJobs(js.filter((j) => j.status !== "shipped" && j.status !== "blocked").length); })
      .catch(() => { if (live) setActiveJobs(null); });
    return () => { live = false; };
  }, [pending, workflowNonce, resyncNonce, retryNonce]);

  const [spendToday, setSpendToday] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    getSpend("24h")
      .then((sp) => { if (live) setSpendToday(sp.error ? null : sp.usd); })
      .catch(() => { if (live) setSpendToday(null); });
    return () => { live = false; };
  }, [pending, resyncNonce, retryNonce]);

  const scopeName = venture ? (kpis?.ventures.find((v) => v.id === venture)?.name || venture) : null;
  const scopeLabel = scopeName ?? "All ventures";

  return (
    // Phase G (ADR G-2): the mockup's Command-center page, top to bottom.
    <section className="page" aria-labelledby="h-center">
      <BosTopbar
        eyebrow={`Command center · ${scopeLabel}`}
        title="Command center"
        tagline="what the team did, as it happened"
        headingId="h-center"
        clock
        chips={
          <span className={activityConnected ? "chip ok" : "chip warn"}>
            <span className={activityConnected ? "dot ok live" : "dot warn"} />
            {activityConnected ? "Live" : "Offline"}
          </span>
        }
      />
      <div className="stack">
        {/* Whether the swarm can act at all outranks what it did today. */}
        <EngineReadinessBanner readiness={readiness} error={readinessError} onOpenAccounts={onOpenAccounts} onRetry={retry} />
        <DoctorStrip report={doctorReport} readiness={readiness} onRecheck={retry} />
        <SelfGradeTile grade={selfGrade} lastFrame={selfGradeFrame} />
        <StatTiles
          activeJobs={activeJobs}
          needYou={pendingKnown ? pending : null}
          shippedToday={kpiError || !kpis ? null : (kpis.jobsShipped ?? null)}
          spendToday={spendToday}
        />
        <div className="grid2">
          <VenturesPanel ventures={kpis?.ventures ?? null} error={kpiError} current={venture} onChoose={setVenture} onRetry={retry} />
          <NeedsYouPanel deliveries={needs} waiting={pending} error={needsError} onOpen={onOpenDelivery} onRetry={retry} />
        </div>
        <ActivityStream rows={activity} connected={activityConnected} open={activityOpen} onToggle={onToggleActivity} />
      </div>
    </section>
  );
}
