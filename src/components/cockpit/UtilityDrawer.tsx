// Utility drawer (mission-control redesign) — a right slide-over holding the
// lower-frequency surfaces that don't belong in the always-on shell: Audit, Tools,
// Replay. Opened from the top-nav. Reuses the existing panels unchanged. Read/act
// paths are exactly as before — this only relocates them.

import { useEffect } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { X, ScrollText, Wrench, History } from "lucide-react";
import type { DashboardState, FeedEvent, AgentState } from "../../data/types";
import type { CommandRequest, CommandResult, AuditEntry, CommandStatusSnapshot, SessionSummary } from "../../data/types";
import { tok } from "../../lib/agentMeta";
import { ControlPlanePanel } from "../ControlPlanePanel";
import { AuditTrailPanel } from "../audit/AuditTrailPanel";
import { UsageOverview, type TranscriptTotals } from "../workspace/UsageMeter";
import type { UsageTick } from "../../lib/useRuntimeEvents";
import { BulkActionBar } from "../BulkActionBar";
import { ConnectorPanel } from "../factory/ConnectorPanel";
import { ExecConsole } from "../factory/ExecConsole";
import { AgentFactory } from "../factory/AgentFactory";
import { SessionsBrowser } from "../SessionsBrowser";
import { TimeScrubber } from "../TimeScrubber";

export type UtilityTab = "audit" | "tools" | "replay";
const TABS: { id: UtilityTab; label: string; icon: typeof ScrollText }[] = [
  { id: "audit", label: "Audit", icon: ScrollText },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "replay", label: "Replay", icon: History },
];

export interface UtilityDrawerProps {
  open: boolean;
  tab: UtilityTab;
  onTab: (t: UtilityTab) => void;
  onClose: () => void;
  state: DashboardState;
  viewAgents: AgentState[];
  replayMs: number | null;
  playing: boolean;
  onScrub: (ms: number) => void;
  onLive: () => void;
  onTogglePlay: () => void;
  sendCommand: (cmd: CommandRequest) => Promise<CommandResult>;
  getAudit: (limit?: number) => Promise<AuditEntry[]>;
  getCommandStatus: () => Promise<CommandStatusSnapshot>;
  listSessions: () => Promise<SessionSummary[]>;
  feedForReplay: FeedEvent[];
  /** F5 — bumped by the roster's "+ Add" so the Factory panel opens on Create. */
  factoryOpenSignal?: number;
  /** P8 — live usage from the bus (usage.tick), for the UsageOverview panel. */
  usageTicks?: UsageTick[];
  /** MUNDER-ADOPTION A3 — transcript ground-truth totals (usage.transcript frames). */
  transcriptTotals?: TranscriptTotals | null;
}

export function UtilityDrawer(props: UtilityDrawerProps) {
  const { open, tab, onTab, onClose, state, viewAgents, replayMs, playing, onScrub, onLive, onTogglePlay, sendCommand, getAudit, getCommandStatus, listSessions, feedForReplay } = props;
  const reduce = useReducedMotion();
  const replaying = replayMs !== null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[75] flex justify-end" role="dialog" aria-modal="true" aria-label="Utilities">
          <motion.div
            className="absolute inset-0"
            style={{ backgroundColor: `color-mix(in oklch, ${tok("bg")} 60%, transparent)` }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.18 }} onClick={onClose} aria-hidden
          />
          <motion.div
            className="relative flex h-full w-full max-w-[560px] flex-col border-l border-border bg-panel shadow-2xl"
            initial={{ x: reduce ? 0 : "100%" }} animate={{ x: 0 }} exit={{ x: reduce ? 0 : "100%" }}
            transition={{ duration: reduce ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
              <div role="tablist" aria-label="Utilities" className="flex gap-1">
                {TABS.map((t) => {
                  const Icon = t.icon;
                  const active = t.id === tab;
                  return (
                    <button key={t.id} role="tab" aria-selected={active} tabIndex={active ? 0 : -1} onClick={() => onTab(t.id)}
                      className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] outline-none focus-visible:ring-2"
                      style={{ color: active ? tok("accent-cyan") : tok("muted"), backgroundColor: active ? `color-mix(in oklch, ${tok("accent-cyan")} 12%, transparent)` : "transparent" }}>
                      <Icon size={14} aria-hidden /> {t.label}
                    </button>
                  );
                })}
              </div>
              <button type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded-md p-1.5 text-muted outline-none transition-colors hover:text-text focus-visible:ring-2">
                <X size={18} aria-hidden />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {tab === "audit" && (
                <div className="flex flex-col gap-4">
                  <UsageOverview ticks={props.usageTicks ?? []} transcripts={props.transcriptTotals} />
                  <ControlPlanePanel getAudit={getAudit} getCommandStatus={getCommandStatus} />
                  <AuditTrailPanel getAudit={getAudit} heartbeats={state.heartbeats} />
                </div>
              )}
              {tab === "tools" && (
                <div className="flex flex-col gap-4">
                  {!replaying && <BulkActionBar agents={viewAgents} onCommand={sendCommand} />}
                  <ConnectorPanel agentIds={["boss", ...state.agents.map((a) => a.id)]} />
                  <ExecConsole agentIds={["builder", ...state.agents.map((a) => a.id)]} />
                  <AgentFactory openSignal={props.factoryOpenSignal ?? 0} />
                  <SessionsBrowser listSessions={listSessions} />
                </div>
              )}
              {tab === "replay" && (
                <TimeScrubber
                  heartbeats={state.heartbeats}
                  feed={feedForReplay}
                  replayMs={replayMs}
                  playing={playing}
                  onScrub={onScrub}
                  onLive={onLive}
                  onTogglePlay={onTogglePlay}
                />
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
