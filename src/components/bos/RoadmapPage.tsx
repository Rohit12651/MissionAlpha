// B7 — the Roadmap page (nav id `roadmap`). A read-only DOCUMENTATION surface that mirrors the
// program plan's PROGRAM STATUS (B0–B7). It is NOT a live board and says so plainly in the
// header note — the phase list is the static `BOS_ROADMAP` constant, hand-mirrored from the
// plan, never computed from runtime state, so it can never fabricate progress.
//
// LAZY BY CONSTRUCTION: App imports this with React.lazy — the constant + this markup stay out
// of the main index chunk. NO innerHTML; every string is a React text node. Zero network, zero
// state — it renders the same for everyone.

import { BOS_ROADMAP, statusMark } from "../../lib/bosRoadmap";
import { BosTopbar } from "./BosTopbar";

export function RoadmapPage() {
  const done = BOS_ROADMAP.filter((p) => p.status === "done").length;

  return (
    <div className="bos-deck bos-roadmap">
      <BosTopbar
        eyebrow="PROGRAM · HELM BUSINESS OS"
        title="Roadmap"
        chips={<span className="helm-chip" data-tone="green">{done} of {BOS_ROADMAP.length} shipped</span>}
      />

      <p className="bos-road-note helm-mono">
        A documentation surface — mirrors the program plan's phase status. Not a live board; updated by hand.
      </p>

      <ol className="bos-road-list" aria-label="Business OS program phases">
        {BOS_ROADMAP.map((p) => {
          const mark = statusMark(p.status);
          return (
            <li key={p.id} className="bos-road-row" data-status={p.status}>
              <span className="bos-road-mark" aria-hidden>{mark.glyph}</span>
              <span className="bos-road-body">
                <span className="bos-road-head">
                  <span className="bos-road-id helm-mono">{p.id}</span>
                  <span className="bos-road-title">{p.title}</span>
                  <span className="bos-road-status helm-mono" data-status={p.status}>{mark.label}</span>
                </span>
                <span className="bos-road-blurb">{p.blurb}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
