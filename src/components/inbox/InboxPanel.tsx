import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  INBOX_FILTERS,
  bulkDecide,
  answerStoryQuestion,
  assignDelivery,
  decideDelivery,
  getDelivery,
  listInbox,
  matchesFilter,
  type DecideVerb,
  type DeliveryEdit,
  type DeliveryEditError,
  type Delivery,
  type DeliveryDetail,
  type InboxCounts,
  type InboxFilter,
} from "../../lib/inboxClient";
import { useAuth } from "../../lib/useAuth";
import { listUsers } from "../../lib/authClient";
import type { RuntimeEvent } from "../../lib/useRuntimeEvents";
import { DeliveryCard } from "./DeliveryCard";
import { ClusterCard } from "./ClusterCard";
import { DeliveryBulkBar } from "./DeliveryBulkBar";
import { EMPTY_SELECTION, toggle, selectRange, prune, isSelected, selectedCount, selectedIds, type SelectionState } from "../../lib/selectionModel";
import { groupDeliveries, decisionsSaved } from "../../lib/clusterModel";
import { ReviewPane } from "./ReviewPane";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { SseDisconnectedBanner } from "./SseDisconnectedBanner";
import { QueueStrip } from "./QueueStrip";
import { AutoApprovedStrip } from "./AutoApprovedStrip";
import { Scoreboard } from "./Scoreboard";

/*
  The Inbox surface (docs/mockups/helm-inbox-merged-mockup.html, live).

  DATA FLOW — push first, poll never removed:
   · mount            → GET /inbox
   · SSE resync       → GET /inbox   (authoritative; survives an events_log prune)
   · delivery.created → GET /inbox   (the frame carries the row, but re-reading is
                                      the single source of truth and costs one
                                      loopback request)
   · delivery.decided → patch the row in place, no refetch (we already hold it)
  The app's existing 2s /api/state.json poll is untouched and is NOT gated on the
  SSE connection, so the shell stays live while the banner is showing.

  The SSE subscription itself lives ONCE in App.tsx — this panel consumes it via
  props so switching to the Board never tears the stream down.
*/

const LIST_LIMIT = 100;

export interface InboxPanelProps {
  /** Newest catalog event from the app-wide SSE subscription. */
  lastEvent: RuntimeEvent | null;
  /** D7 — monotonic count of queue-moving SSE frames (see App.onRuntimeEvent). */
  queueNonce?: number;
  /** Bumped on every successful (re)connect — triggers an authoritative re-read. */
  resyncNonce: number;
  connected: boolean;
  retryAt: number | null;
  onReconnectNow: () => void;
  /** Reports the runtime's own per-status tally so the badge stays exact. */
  onCounts?: (counts: InboxCounts) => void;
  /**
   * B3 — open with this delivery already selected (the CEO brief's needs-review
   * deep-link). ADDITIVE and OPTIONAL: left undefined, the panel behaves exactly as it
   * did before B3 — nothing is pre-selected and no effect fires.
   */
  initialSelectedId?: string;
}

export function InboxPanel({
  lastEvent,
  resyncNonce,
  queueNonce = 0,
  connected,
  retryAt,
  onReconnectNow,
  onCounts,
  initialSelectedId,
}: InboxPanelProps) {
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [counts, setCounts] = useState<InboxCounts | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [filter, setFilter] = useState<InboxFilter>("All");

  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null);
  const [detail, setDetail] = useState<DeliveryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailNonce, setDetailNonce] = useState(0);

  const [isLg, setIsLg] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width:1024px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width:1024px)");
    const on = () => setIsLg(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const onCountsRef = useRef(onCounts);
  useEffect(() => { onCountsRef.current = onCounts; }, [onCounts]);

  // B3 — a deep-link arriving while the panel is already mounted. Undefined (the
  // pre-B3 case, and every case where the BOSS opened the Inbox himself) is a no-op, so
  // this can never steal a selection the operator made.
  useEffect(() => {
    if (initialSelectedId) setSelectedId(initialSelectedId);
  }, [initialSelectedId]);

  // ── list ──────────────────────────────────────────────────────────────────
  const [listNonce, setListNonce] = useState(0);
  const refreshList = useCallback(() => setListNonce((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    setListLoading(true);
    listInbox({ limit: LIST_LIMIT })
      .then((r) => {
        if (!live) return;
        setDeliveries(r.deliveries ?? []);
        setCounts(r.counts ?? null);
        if (r.counts) onCountsRef.current?.(r.counts);
        setListError(null);
      })
      .catch((e: unknown) => {
        if (live) setListError(e instanceof Error ? e.message : "request failed");
      })
      .finally(() => {
        if (live) setListLoading(false);
      });
    return () => { live = false; };
  }, [listNonce, resyncNonce]);

  // Bumped on every policy.autoapplied so the (open) Auto strip re-reads its list.
  const [autoNonce, setAutoNonce] = useState(0);

  // ── SSE → state ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!lastEvent) return;
    if (lastEvent.name === "delivery.created") {
      refreshList();
      return;
    }
    // P6 — an SLA escalation changes a pending row's slaState (visual). It does NOT
    // decide the row, so a light authoritative re-read is the honest update.
    if (lastEvent.name === "delivery.expired" || lastEvent.name === "delivery.sla_halflife") {
      refreshList();
      return;
    }
    if (lastEvent.name === "delivery.decided" || lastEvent.name === "policy.autoapplied") {
      const { id, status } = lastEvent.data as { id?: string; status?: string };
      if (lastEvent.name === "policy.autoapplied") setAutoNonce((n) => n + 1);
      if (!id) return;
      const next = (lastEvent.name === "policy.autoapplied" ? "auto_approved" : status) as
        | Delivery["status"]
        | undefined;
      if (!next) return;
      setDeliveries((prev) => prev.map((d) => (d.id === id ? { ...d, status: next } : d)));
      setDetail((prev) => (prev && prev.id === id ? { ...prev, status: next } : prev));
      setCounts(null); // stale until the next authoritative read
    }
  }, [lastEvent, refreshList]);

  // ── detail ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let live = true;
    setDetailLoading(true);
    getDelivery(selectedId)
      .then((r) => {
        if (!live) return;
        if (r && (r as { error?: string }).error) {
          setDetail(null);
          setDetailError((r as { error?: string }).error ?? "not found");
        } else {
          setDetail(r);
          setDetailError(null);
        }
      })
      .catch((e: unknown) => {
        if (live) setDetailError(e instanceof Error ? e.message : "request failed");
      })
      .finally(() => {
        if (live) setDetailLoading(false);
      });
    return () => { live = false; };
  }, [selectedId, detailNonce]);

  // ── decide ────────────────────────────────────────────────────────────────
  const onDecide = useCallback(
    async (
      verb: DecideVerb,
      feedback?: string,
      // Phase 4 — the operator's revision of the proposal, approve-only. The runtime
      // validates and stages it; nothing about the apply path changes.
      edits?: DeliveryEdit[],
    ): Promise<{ ok: boolean; error?: string; editErrors?: DeliveryEditError[] }> => {
      if (!selectedId) return { ok: false, error: "nothing selected" };
      try {
        // No client `by`: the runtime derives the decider from the session when auth
        // is active (unspoofable), and defaults to 'BOSS' in solo mode.
        const r = await decideDelivery(selectedId, verb, { feedback, edits });
        // editErrors travels with the failure so ReviewPane can bind each refusal to the
        // file it names instead of showing one banner for a multi-file delivery.
        if (r.error) return { ok: false, error: r.error, editErrors: r.editErrors };
        // The runtime also emits delivery.decided; refreshing here means the pane
        // is correct even when the stream is down (the banner case).
        refreshList();
        setDetailNonce((n) => n + 1);
        return { ok: true };
      } catch (e: unknown) {
        return { ok: false, error: e instanceof Error ? e.message : "request failed" };
      }
    },
    [selectedId, refreshList],
  );

  // ── P9 role + assignment ────────────────────────────────────────────────────
  const { authActive, user } = useAuth();
  const role = authActive ? (user?.role ?? "viewer") : null; // null = solo (full powers)
  const [approvers, setApprovers] = useState<string[]>([]);
  useEffect(() => {
    if (!authActive) { setApprovers([]); return; }
    let live = true;
    void listUsers().then((us) => { if (live) setApprovers(us.filter((u) => u.role === "approver").map((u) => u.name)); });
    return () => { live = false; };
  }, [authActive]);

  // ── S2 answer a question gate ───────────────────────────────────────────────
  const onAnswer = useCallback(
    async (answer: string): Promise<{ ok: boolean; error?: string }> => {
      if (!detail || !detail.storyId) return { ok: false, error: "this delivery is not a story question" };
      try {
        const r = await answerStoryQuestion(detail.storyId, detail.id, answer);
        if (r.error) return { ok: false, error: r.error };
        // The runtime resolves the gate + advances the story; re-read so the pane is correct
        // even when the SSE stream is down.
        refreshList();
        setDetailNonce((n) => n + 1);
        return { ok: true };
      } catch (e: unknown) {
        return { ok: false, error: e instanceof Error ? e.message : "request failed" };
      }
    },
    [detail, refreshList],
  );

  const onAssign = useCallback(
    async (assignee: string | null): Promise<{ ok: boolean; error?: string }> => {
      if (!selectedId) return { ok: false, error: "nothing selected" };
      try {
        const r = await assignDelivery(selectedId, assignee);
        if (r.error) return { ok: false, error: r.error };
        refreshList();
        setDetailNonce((n) => n + 1);
        return { ok: true };
      } catch (e: unknown) {
        return { ok: false, error: e instanceof Error ? e.message : "request failed" };
      }
    },
    [selectedId, refreshList],
  );

  // ── derived ───────────────────────────────────────────────────────────────
  const visible = useMemo(() => deliveries.filter((d) => matchesFilter(d, filter)), [deliveries, filter]);

  // Phase 2 — failure clustering. 97 agent-stuck failures were arriving as ~20
  // near-identical cards: one root cause, twenty decisions. Grouping is a VIEW over the
  // same list — every underlying delivery stays individually reachable by expanding the
  // cluster, and only `kind:"failure"` rows matching the runtime's "<agent> is stuck —
  // <reason>" shape can ever collapse (clusterModel fails closed on anything else).
  const groups = useMemo(() => groupDeliveries(visible), [visible]);
  const saved = useMemo(() => decisionsSaved(groups), [groups]);
  const [bulkBusyKey, setBulkBusyKey] = useState<string | null>(null);

  // Phase 3 — multi-select on the individual (non-clustered) rows. Selection lives here,
  // keyed by id, NOT on the delivery objects: the list re-renders constantly off SSE and
  // a per-row flag would be wiped on every refresh.
  const [sel, setSel] = useState<SelectionState>(EMPTY_SELECTION);
  const [confirmHighRisk, setConfirmHighRisk] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  // Only PENDING singles are selectable — deciding an already-decided delivery is a
  // no-op the runtime rejects, so it must not be offerable.
  const selectableIds = useMemo(
    () => groups.filter((g) => g.kind === "single" && g.delivery.status === "pending").map((g) => (g as { delivery: Delivery }).delivery.id),
    [groups],
  );

  // Anything that left the view must leave the selection with it.
  useEffect(() => { setSel((cur) => prune(cur, selectableIds)); }, [selectableIds]);

  const selectedHighRisk = useMemo(
    () => deliveries.filter((d) => isSelected(sel, d.id) && d.risk?.band === "high").length,
    [deliveries, sel],
  );

  const onRowSelect = useCallback((id: string, shift: boolean) => {
    setSel((cur) => (shift ? selectRange(cur, id, selectableIds) : toggle(cur, id)));
  }, [selectableIds]);

  const runBulk = useCallback(async (decision: "approve" | "reject") => {
    const ids = selectedIds(sel);
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const r = await bulkDecide(ids, decision, {
        confirmHighRisk: decision === "approve" ? confirmHighRisk : undefined,
        feedback: decision === "reject" ? "Rejected in a bulk decision." : undefined,
      });
      if (r.error) {
        // Never fail silently: before this, a refused batch just flashed "Working…" and
        // returned to idle with no explanation, which reads as a dead button.
        setBulkError(
          r.highRiskIds?.length
            ? `${r.error} (${r.highRiskIds.length} high-risk in selection)`
            : r.error,
        );
      } else {
        setBulkError(null);
        setSel(EMPTY_SELECTION);
        setConfirmHighRisk(false);
      }
      refreshList();
    } finally {
      setBulkBusy(false);
    }
  }, [sel, confirmHighRisk, refreshList]);

  const dismissCluster = useCallback(async (key: string, ids: string[]) => {
    setBulkBusyKey(key);
    try {
      const r = await bulkDecide(ids, "reject", {
        feedback: "Dismissed as part of a repeated-failure cluster.",
      });
      if (!r.error) {
        // Optimistic: drop them locally, then resync from the runtime.
        setDeliveries((prev) => prev.filter((d) => !ids.includes(d.id)));
      }
      refreshList();
    } finally {
      setBulkBusyKey(null);
    }
  }, [refreshList]);
  const pending = counts?.pending ?? deliveries.filter((d) => d.status === "pending").length;
  const autoApproved = counts?.auto_approved ?? 0;

  const showOverlay = !isLg && selectedId != null;

  return (
    <div className="helm-root min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-7">
      {/* topbar */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="helm-eyebrow">Deliveries awaiting your decision</div>
          <h1 className="helm-display text-[25px] leading-tight">Inbox</h1>
        </div>
        <div className="helm-mono flex flex-wrap items-center gap-2 text-[11.5px]" style={{ color: "var(--helm-paper-dim)" }}>
          {/* P10 — dogfood scoreboard: quiet, glanceable, refreshes as pending changes */}
          <Scoreboard refreshNonce={pending} />
          <span className="helm-chip" data-tone={pending ? "amber" : "green"}>
            {pending} pending
          </span>
          <span className="helm-chip" data-tone={connected ? "green" : "amber"}>
            {connected ? "live" : "polling"}
          </span>
        </div>
      </div>

      {!connected && <div className="mb-4"><SseDisconnectedBanner retryAt={retryAt} onRetryNow={onReconnectNow} /></div>}

      {/* P4 — what the swarm is working on right now, push-driven off task.* */}
      <QueueStrip lastEvent={lastEvent} resyncNonce={resyncNonce} liveNonce={queueNonce} />

      <DeliveryBulkBar
        count={selectedCount(sel)}
        highRiskCount={selectedHighRisk}
        confirmHighRisk={confirmHighRisk}
        busy={bulkBusy}
        error={bulkError}
        onConfirmHighRiskChange={setConfirmHighRisk}
        onApprove={() => void runBulk("approve")}
        onReject={() => void runBulk("reject")}
        onClear={() => { setSel(EMPTY_SELECTION); setConfirmHighRisk(false); setBulkError(null); }}
      />

      {/* Phase 2 — make the collapsing legible. Without this the human sees a shorter
          list with no explanation of where the other rows went. Silent collapsing of
          decisions would be worse than not collapsing at all. */}
      {saved > 0 && (
        <div className="helm-note mb-2.5 text-[12px]" role="status">
          {saved} duplicate failure{saved === 1 ? "" : "s"} collapsed into{" "}
          {groups.filter((g) => g.kind === "cluster").length} cluster
          {groups.filter((g) => g.kind === "cluster").length === 1 ? "" : "s"}. Expand any
          cluster to decide its deliveries individually.
        </div>
      )}

      {/* filters */}
      <div className="mb-3.5 flex flex-wrap gap-1.5" role="group" aria-label="Inbox filters">
        {INBOX_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className="helm-fpill"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>

      <div className={isLg ? "grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_460px]" : "flex flex-col gap-4"}>
        {/* list */}
        <div className="min-w-0">
          {listError && !deliveries.length ? (
            <ErrorState message={listError} onRetry={refreshList} busy={listLoading} />
          ) : listLoading && !deliveries.length ? (
            <div className="helm-note" role="status" aria-live="polite">
              Reading the Inbox…
            </div>
          ) : visible.length === 0 ? (
            <EmptyState filtered={deliveries.length > 0} onClear={() => setFilter("All")} />
          ) : (
            groups.map((g) =>
              g.kind === "cluster" ? (
                <ClusterCard
                  key={g.key}
                  agentId={g.agentId}
                  reason={g.reason}
                  size={g.size}
                  members={g.members}
                  busy={bulkBusyKey === g.key}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onDismissAll={() => void dismissCluster(g.key, g.members.map((m) => m.id))}
                />
              ) : (
                <DeliveryCard
                  key={g.delivery.id}
                  delivery={g.delivery}
                  selected={g.delivery.id === selectedId}
                  onSelect={setSelectedId}
                  bulkSelected={isSelected(sel, g.delivery.id)}
                  onBulkToggle={g.delivery.status === "pending" ? onRowSelect : undefined}
                />
              ),
            )
          )}

          {/* P6 / ADR-053 — auto-applied deliveries live here (collapsed), with the full
              audit trail one click away. The count is the runtime's real tally. */}
          <AutoApprovedStrip count={autoApproved} refreshNonce={autoNonce} />
        </div>

        {/* review */}
        {isLg && (
          <div className="sticky top-4 min-w-0">
            <ReviewPane
              delivery={detail}
              loading={detailLoading}
              error={detailError}
              onRetry={() => setDetailNonce((n) => n + 1)}
              onDecide={onDecide}
              onAnswer={onAnswer}
              role={role}
              approvers={approvers}
              onAssign={onAssign}
            />
          </div>
        )}
      </div>

      {showOverlay && (
        <ReviewPane
          overlay
          onClose={() => setSelectedId(null)}
          delivery={detail}
          loading={detailLoading}
          error={detailError}
          onRetry={() => setDetailNonce((n) => n + 1)}
          onDecide={onDecide}
          onAnswer={onAnswer}
          role={role}
          approvers={approvers}
          onAssign={onAssign}
        />
      )}
    </div>
  );
}
