// B1 — the Command deck (nav id `deck`, master spec §3).
//
// LAZY BY CONSTRUCTION: App imports this with React.lazy, so none of it — the deck,
// the modal, its icons — is in the main index chunk. B0 left 1.7KB of gz headroom;
// the deck must not spend it.
//
// EVERY NUMBER IS REAL OR AN ADMITTED GAP:
//   • APPROVED TODAY / DECISIONS TODAY ride the shipped GET /runtime/scoreboard
//     (window=1d), the same endpoint the Inbox chip already uses.
//   • RECORDS READ is LIVE as of B2: GET /runtime/vault/stats total, scoped to the
//     sidebar's venture. A fetch failure renders "—" plus one faint note — never a
//     fabricated zero, which would read as "the vault is empty".
//   • "Open brief →" is LIVE as of B3: it opens the CEO brief page. B1 shipped it
//     disabled on purpose (a CTA that navigates nowhere is the mockup's exact defect);
//     it was enabled only once the page behind it existed.
//   • Station badges come from the live state feed via stationBadge(), never a fixture.

import { useEffect, useMemo, useState } from "react";
import type { AgentState } from "../../data/types";
import { getScoreboard, type Scoreboard } from "../../lib/inboxClient";
import { getVaultStats, type VaultStats } from "../../lib/vaultClient";
import {
  BADGE_LABEL,
  CAPTAIN_ID,
  deckOrder,
  onWatchCount,
  stationBadge,
  stationById,
  type StationDef,
} from "../../lib/stationMeta";
import { BosTopbar } from "./BosTopbar";
import { StationCard } from "./StationCard";
import { StationModal } from "./StationModal";
import { DeckLedger } from "./DeckLedger";

export interface CommandDeckProps {
  agents: readonly AgentState[];
  /** Pending deliveries — doubles as the scoreboard refetch nonce (a decision moves it). */
  pending: number;
  /** B2 — the sidebar's venture scope; null = all ventures. Scopes RECORDS READ. */
  venture: string | null;
  /** B2 — bumped on every `vault.written` frame, so RECORDS READ re-reads live. */
  vaultNonce: number;
  /** Existing Agent Factory opener — the deck's ONE creation path. */
  onOpenFactory: () => void;
  /** Existing inspect drawer — how a swarm (non-station) card opens. */
  onAgent: (id: string) => void;
  /** B3 — the CEO brief exists now, so the CTA that B1 shipped disabled is live. */
  onOpenBrief: () => void;
}

export function CommandDeck({ agents, pending, venture, vaultNonce, onOpenFactory, onAgent, onOpenBrief }: CommandDeckProps) {
  // Self-fetching, exactly like the shipped Scoreboard chip: an error renders "—" plus
  // one faint note. It NEVER blanks the deck and NEVER shows a fabricated zero.
  const [score, setScore] = useState<Scoreboard | null>(null);
  const [scoreError, setScoreError] = useState(false);
  useEffect(() => {
    let live = true;
    setScoreError(false);
    getScoreboard("1d")
      .then((d) => { if (live) setScore(d); })
      .catch(() => { if (live) { setScore(null); setScoreError(true); } });
    return () => { live = false; };
  }, [pending]);

  // B2 — RECORDS READ. Self-fetching on the same terms as the scoreboard above: an
  // error renders "—" plus one faint note, never a zero the BOSS would read as truth.
  const [vault, setVault] = useState<VaultStats | null>(null);
  const [vaultError, setVaultError] = useState(false);
  useEffect(() => {
    let live = true;
    setVaultError(false);
    getVaultStats(venture)
      .then((s) => { if (live) setVault(s); })
      .catch(() => { if (live) { setVault(null); setVaultError(true); } });
    return () => { live = false; };
  }, [venture, vaultNonce]);

  const [open, setOpen] = useState<{ agent: AgentState; station: StationDef } | null>(null);

  const captain = useMemo(() => agents.find((a) => a.id === CAPTAIN_ID) ?? null, [agents]);
  const cards = useMemo(() => deckOrder(agents), [agents]);
  const onWatch = useMemo(() => onWatchCount(agents), [agents]);
  const captainBadge = stationBadge(captain);

  const num = (n: number | undefined) => (score && n != null ? String(n) : "—");
  const stats: [string, string, string][] = [
    ["Approved today", num(score?.approved), "Deliveries you approved in the last 24h"],
    ["Decisions today", num(score?.decided), "Approvals, rejections and change requests in the last 24h"],
    ["Records read", vault ? String(vault.total) : "—", venture ? `Knowledge vault records in ${venture}` : "Knowledge vault records across every venture"],
  ];

  // Phase G (ADR G-2): the mockup's Agents page — the Captain band, the stations, the ledger.
  return (
    <section className="page" aria-labelledby="h-deck">
      <BosTopbar
        eyebrow={`Command deck · ${venture ?? "All ventures"}`}
        title="Agents"
        tagline="who does what, and what they may touch"
        headingId="h-deck"
        clock
        chips={<span className="chip"><span className="dot ok live" />{`${onWatch} on watch · ${cards.length} stations`}</span>}
      />

      <div className="captain">
        <svg className="cap-emblem" aria-hidden="true"><use href="#i-captain" /></svg>
        <div>
          <p className="sub" style={{ margin: "0 0 6px" }}>The Captain · CEO</p>
          <h2 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 400, fontSize: "2.4rem", letterSpacing: ".04em", color: "var(--brand)", lineHeight: 1 }}>Strategy before anything moves</h2>
          <p style={{ margin: "8px 0 0", color: "var(--ink-2)", maxWidth: "56ch" }}>Judges every brief first: proceed, defer or kill, with the reason and a cheaper option. Sits above every station.</p>
          {/* APP-ONLY: the Captain's own watch, and the honest unreachable notes. */}
          <p className="sub" data-app-only="captain-watch" style={{ margin: "8px 0 0" }}>
            {BADGE_LABEL[captainBadge]}
            {scoreError ? " · scoreboard unavailable, runtime not reachable" : ""}
            {vaultError ? " · vault unavailable, record count not read" : ""}
          </p>
        </div>
        <div className="cap-stats">
          {stats.map(([label, value, title]) => (
            <div key={label} title={title}><span className="label">{label}</span><div className="big num">{value}</div></div>
          ))}
        </div>
        <div className="cap-cta">
          <button className="btn btn-primary" type="button" onClick={onOpenBrief}>Open brief <svg className="arrow" aria-hidden="true"><use href="#arrow" /></svg></button>
        </div>
      </div>

      <div className="divider">
        <span className="label">Stations, one memory</span>
        <button className="btn btn-ghost" type="button" style={{ minHeight: 36, padding: "8px 16px" }} onClick={onOpenFactory}>
          <svg width="14" height="14" aria-hidden="true"><use href="#i-plus" /></svg> New station
        </button>
      </div>
      {cards.length === 0 ? (
        <div className="empty-note"><span className="script">No stations yet.</span><br />Waiting on the runtime.</div>
      ) : (
        <div className="stations">
          {cards.map((a, i) => (
            <StationCard
              key={a.id}
              agent={a}
              station={stationById(a.id)}
              index={i}
              // A seeded station opens its skill sheet; a swarm agent opens the EXISTING
              // inspect drawer: no second inspector, no invented skills.
              onOpen={(agent, station) => (station ? setOpen({ agent, station }) : onAgent(agent.id))}
            />
          ))}
        </div>
      )}

      {/* Phase 6 — the per-agent ledger lives here, where an operator asks how the agents are
          doing. `pending` doubles as the refresh nonce: a decision moves it. */}
      <div className="divider"><span className="label">Agent ledger</span><span className="sub">click a row for the drawer</span></div>
      <DeckLedger agents={cards} refreshNonce={pending} onOpen={onAgent} />

      {open && (
        <StationModal
          station={open.station}
          agent={agents.find((a) => a.id === open.agent.id) ?? null}
          onClose={() => setOpen(null)}
          onOpenFactory={onOpenFactory}
        />
      )}
    </section>
  );
}
