// Phase 1 / R4 (UI) — the doctor's verdict, where the operator starts work.
//
// THE DEFECT THIS CLOSES. `npm run doctor` has known since session 1 that `gh` is not on
// this machine's PATH — which means every approve has been silently falling back to a local
// branch instead of opening a PR — and that encryption at rest is off. The runtime emitted
// `doctor.status` on every verdict change. Nothing rendered it. A health check nobody reads
// is the same silence the doctor was built to end.
//
// DESIGN — deliberately the QUIETEST thing that cannot be missed:
//   · Renders NOTHING when healthy. An operator does not need a strip to say all is well,
//     and a permanent green bar is how a red one stops being noticed.
//   · ONE check at a time — the worst. A list of five faults is a backlog; one fault with
//     its fix is an action. The count of the rest is stated, never enumerated.
//   · The account check is EXCLUDED (see doctorStatus.ts): the readiness banner directly
//     above already renders it in its own words, and saying it twice teaches the operator
//     to skip the region.
//   · No motion. An alert that animates draws the eye to the animation. There is nothing
//     here for `prefers-reduced-motion` to reduce, which is the strongest form of respecting
//     it.
//
// Tokens only — `--c-*` and the `--type-*` ladder. No new design language: this reads as a
// sibling of EngineReadinessBanner because it sits directly under it.

import { AlertTriangle, AlertOctagon } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import { worstCheck, visibleFailures, doctorTone, type DoctorReport } from "../../lib/doctorStatus";

export interface DoctorStripProps {
  /** `null` while the first read is in flight — absence is a state, not a failure. */
  report: DoctorReport | null;
  /** Re-read the gated route. Fired by the `doctor.status` frame and by the button. */
  onRecheck?: () => void;
}

const toneColor = (t: "ok" | "warn" | "error"): string =>
  t === "error" ? tok("stale-red") : tok("blocked-amber");

export function DoctorStrip({ report, onRecheck }: DoctorStripProps) {
  const worst = worstCheck(report);
  // Healthy, still loading, or the only fault is one the banner above owns → say nothing.
  if (!worst) return null;

  const tone = doctorTone(report);
  const color = toneColor(tone);
  const others = visibleFailures(report).length - 1;
  const Icon = tone === "error" ? AlertOctagon : AlertTriangle;

  return (
    <div
      className="flex flex-col gap-1.5 rounded-xl px-4 py-2.5"
      style={{
        backgroundColor: `color-mix(in oklch, ${color} 8%, transparent)`,
        border: `1px solid color-mix(in oklch, ${color} 28%, transparent)`,
        fontSize: "var(--type-2)",
      }}
      // `alert` for a fail (the operator is about to act on a broken install); `status` for
      // a warn (real, but not a reason to interrupt a screen reader mid-sentence).
      role={tone === "error" ? "alert" : "status"}
    >
      <div className="flex items-start gap-2.5">
        <Icon size={14} aria-hidden style={{ color, marginTop: 2, flexShrink: 0 }} />
        <div className="min-w-0">
          <p className="font-bold" style={{ color, fontSize: "var(--type-2)" }}>
            {worst.label}
            {others > 0 && (
              <span className="ml-1.5 font-normal" style={{ color: tok("muted") }}>
                · {others} other {others === 1 ? "check" : "checks"} need attention
              </span>
            )}
          </p>
          <p className="mt-0.5 leading-relaxed" style={{ color: tok("muted") }}>
            {worst.detail}
          </p>
          {/* The fix is a COMMAND, so it is rendered as one — selectable, monospaced, not
              prose the operator has to translate. Absent is normal: some faults have no
              one-line remedy, and inventing one would be worse than showing none. */}
          {/* VISUAL-VERIFIED FIX: this block first used --c-text on --c-panel-2. Those two
              tokens flip with [data-theme], but the cockpit shell around this strip is
              helm-skinned and does NOT — so in light theme the block rendered as a glaring
              pale slab of dark-on-light inside a dark panel. Tinting from the strip's OWN
              tone colour keeps it subordinate in both themes, because it derives from the
              same colour the border and icon already use. */}
          {worst.fix && (
            <p
              className="helm-mono mt-1.5 select-all rounded-md px-2 py-1"
              style={{
                color,
                backgroundColor: `color-mix(in oklch, ${color} 12%, transparent)`,
                border: `1px solid color-mix(in oklch, ${color} 20%, transparent)`,
                fontSize: "var(--type-1)",
              }}
            >
              {worst.fix}
            </p>
          )}
        </div>
      </div>
      {onRecheck && (
        <div className="flex pl-[24px]">
          <button
            type="button"
            onClick={onRecheck}
            className="rounded-lg px-2.5 py-1 font-semibold outline-none transition-colors hover:bg-[color-mix(in_oklch,currentColor_12%,transparent)] focus-visible:ring-2 active:translate-y-px disabled:opacity-50"
            style={{
              color: tok("accent-cyan"),
              fontSize: "var(--type-1)",
              border: `1px solid color-mix(in oklch, ${tok("accent-cyan")} 30%, transparent)`,
            }}
          >
            Re-check
          </button>
        </div>
      )}
    </div>
  );
}
