// B7 — the Business-OS roadmap, as a STATIC documentation constant.
//
// This is NOT a live board and does not pretend to be one. It is a hand-mirrored snapshot of
// the program plan's PROGRAM STATUS section
// (docs/superpowers/plans/2026-07-30-business-os-program-plan.md, "PROGRAM STATUS"), rendered
// read-only by RoadmapPage, which labels it plainly as "a documentation surface — mirrors the
// program plan." A phase's status here is updated by hand when the plan's status changes; it is
// never computed from runtime state, so it can never fabricate progress.
//
// STATUS SEMANTICS: "done" = shipped + verified; "removed" = shipped, then deleted by a later
// phase; "active" = the phase currently in flight; "planned" = not started.
//
// B6 is "removed": the plan records it COMPLETE, and S0 (the story pipeline) later deleted its
// pipeline and content surfaces, stores, routes and clients (src/components/bos/bosNav.ts).
// B7 is "done": the plan records it COMPLETE. Both pinned by src/lib/__tests__/bosRoadmap.test.ts.
//
// HONEST NOTE on B5: the plan's PROGRAM STATUS checkbox for B5 is still literally `[ ]`
// (un-annotated), but B5's own feature ledger in that same plan is fully checked AND B6 —
// which is marked COMPLETE — builds directly on B5 (the openFollowUps KPI). So B5 is recorded
// here as "done" to reflect what actually shipped, and this discrepancy is disclosed rather
// than hidden. If the plan later re-files B5, update this constant to match.

export type RoadmapStatus = "done" | "removed" | "active" | "planned";

export interface RoadmapPhase {
  /** The phase id (B0..B7) — the closed, ordered set. */
  id: string;
  /** The phase title, mirroring the plan's section headings. */
  title: string;
  /** A one-line summary of the phase's surface. */
  blurb: string;
  status: RoadmapStatus;
}

/** The B0–B7 phase list, in order. Mirrors the program plan's PROGRAM STATUS. Pinned by a test. */
export const BOS_ROADMAP: readonly RoadmapPhase[] = [
  { id: "B0", title: "Shell + mounts", blurb: "Sidebar shell, null-guarded router, shipped surfaces mounted behind the BOS flag.", status: "done" },
  { id: "B1", title: "Command deck", blurb: "Captain card, station band with live badges, station modal, +New station.", status: "done" },
  { id: "B2", title: "Knowledge vault", blurb: "Markdown records + SQLite index, 6-node taxonomy, scrubbed, live vault.written.", status: "done" },
  { id: "B3", title: "CEO brief", blurb: "Captain console → keyword routing → vault record + queued task, live agent log.", status: "done" },
  { id: "B4", title: "Workflows + Schedule", blurb: "Seeded cadences on the timer, Run-now / Pause, failure → Inbox autonomy.", status: "done" },
  { id: "B5", title: "Command center", blurb: "Cross-venture KPI tiles, ventures + needs-you panels, app-wide venture scope.", status: "done" },
  { id: "B6", title: "Lead pipeline + Content", blurb: "CRM-lite kanban, lead drawer, content engine. Removed when the story pipeline (S0) replaced it.", status: "removed" },
  { id: "B7", title: "Outputs + Roadmap + ship gauntlet", blurb: "Artifact registry + this roadmap; then the scored design / a11y / perf gauntlet.", status: "done" },
] as const;

/** The word the page shows for a phase's status (the mockup's vocabulary). */
export function statusWord(status: RoadmapStatus): string {
  switch (status) {
    case "done": return "shipped";
    case "removed": return "removed";
    case "active": return "in progress";
    default: return "planned";
  }
}
