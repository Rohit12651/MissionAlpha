// B7 — the Roadmap page (nav id `roadmap`). A read-only DOCUMENTATION surface that mirrors the
// program plan's PROGRAM STATUS (B0–B7), and says so in its one chip. Phase G (ADR G-2): the
// approved mockup's `data-page="roadmap"` — a `.list` of `li.rm` rows (code · title + summary ·
// status chip). The phases are the static `BOS_ROADMAP` constant, hand-mirrored from the plan
// and pinned by a test, never computed from runtime state, so it can never fabricate progress.
//
// LAZY BY CONSTRUCTION: App imports this with React.lazy. NO innerHTML; every string is a React
// text node. Zero network, zero state — it renders the same for everyone.

import { BOS_ROADMAP, statusWord } from "../../lib/bosRoadmap";
import { BosTopbar } from "./BosTopbar";

export function RoadmapPage() {
  return (
    <section className="page" aria-labelledby="h-roadmap">
      <BosTopbar
        eyebrow="Roadmap · All ventures"
        title="Roadmap"
        tagline="how we got here"
        headingId="h-roadmap"
        chips={<span className="chip">read-only · mirrors the program plan</span>}
      />
      <ol className="list" aria-label="Business OS program phases">
        {BOS_ROADMAP.map((p) => (
          <li key={p.id} className="rm">
            <b className="code">{p.id}</b>
            <span><b>{p.title}</b><span style={{ display: "block", color: "var(--ink-2)", marginTop: 4 }}>{p.blurb}</span></span>
            <span className={p.status === "done" ? "chip ok" : "chip"}>{statusWord(p.status)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
