// The parity gate (BOSS decision, 2026-10-02): the tab audit FAILS on any NO-MATCH frame
// that is not on this reviewed allowlist, and on any allowlisted frame that now MATCHes
// (remove it, so the list only shrinks). Adding a key here is a decision for the BOSS,
// not a way to turn a red audit green.
export const PARITY_ALLOWLIST = new Map([
  ["inbox-desktop-end", "Inbox end frames: escalated after 3 cycles; with the separate review agent (handoff in the repair-plan log)"],
  ["inbox-laptop-end", "Inbox end frames: escalated after 3 cycles; with the separate review agent (handoff in the repair-plan log)"],
  ["inbox-tablet-end", "Inbox end frames: escalated after 3 cycles; with the separate review agent (handoff in the repair-plan log)"],
  ["inbox-mobile-end", "Inbox end frames: escalated after 3 cycles; with the separate review agent (handoff in the repair-plan log)"],
  ["missions-desktop-top", "Missions: escalated after 3 cycles; with the separate review agent (handoff in the repair-plan log)"],
  ["missions-desktop-end", "Missions: escalated after 3 cycles; with the separate review agent (handoff in the repair-plan log)"],
  ["missions-laptop-top", "Missions: escalated after 3 cycles; with the separate review agent (handoff in the repair-plan log)"],
  ["missions-tablet-top", "Missions: escalated after 3 cycles; with the separate review agent (handoff in the repair-plan log)"],
  ["missions-tablet-end", "Missions: escalated after 3 cycles; with the separate review agent (handoff in the repair-plan log)"],
  ["missions-mobile-end", "Missions: escalated after 3 cycles; with the separate review agent (handoff in the repair-plan log)"],
  ["setup-3-mobile-top", "Setup Account step at 375px: radio-label + BACK glyph rendering; escalated after 3 cycles (handoff in the repair-plan log)"],
  ["setup-4-mobile-top", "Setup Project step at 375px: BACK glyph rendering; escalated after 3 cycles (handoff in the repair-plan log)"],
]);

export const frameKey = (r) => `${r.tab}-${r.breakpoint}-${r.frame}`;

/** @returns {{unexpected: string[], stale: string[]}} frame keys that break the gate */
export function gateVerdicts(rows, allowlist = PARITY_ALLOWLIST) {
  const unexpected = [], stale = [];
  for (const r of rows) {
    const k = frameKey(r);
    if (r.verdict !== "MATCH" && !allowlist.has(k)) unexpected.push(k);
    if (r.verdict === "MATCH" && allowlist.has(k)) stale.push(k);
  }
  return { unexpected, stale };
}

/** Throws with every offending frame named, or returns quietly. */
export function assertParityGate(rows, allowlist = PARITY_ALLOWLIST) {
  const { unexpected, stale } = gateVerdicts(rows, allowlist);
  const msg = [
    unexpected.length && `NO-MATCH outside the reviewed allowlist: ${unexpected.join(", ")}`,
    stale.length && `allowlisted frame now MATCHes — remove it from PARITY_ALLOWLIST: ${stale.join(", ")}`,
  ].filter(Boolean).join("; ");
  if (msg) throw new Error(`parity gate: ${msg}`);
}
