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
  BADGE_TONE,
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

/** The compass emblem. Decorative only; the heading beside it carries the meaning. */
function Compass() {
  return (
    <svg className="bos-deck-compass" viewBox="0 0 64 64" fill="none" aria-hidden focusable="false">
      <defs>
        <radialGradient id="bos-deck-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--helm-brass)" stopOpacity="0.34" />
          <stop offset="100%" stopColor="var(--helm-brass)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill="url(#bos-deck-glow)" />
      <circle cx="32" cy="32" r="23" stroke="var(--helm-brass)" strokeWidth="1.6" />
      <circle cx="32" cy="32" r="17" stroke="var(--helm-brass)" strokeWidth="0.8" opacity="0.5" />
      <path d="M41 23 28.8 29.2 23 41.4l12.2-6.2L41 23Z" fill="var(--helm-brass-bright)" />
      <circle cx="32" cy="32" r="1.8" fill="var(--helm-brass-bright)" />
    </svg>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="bos-deck-stat" title={title}>
      <span className="bos-deck-stat-value helm-mono">{value}</span>
      <span className="bos-deck-stat-label helm-mono">{label}</span>
    </div>
  );
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

  return (
    <div className="bos-deck">
      <BosTopbar
        eyebrow="AGENT NETWORK · WAAHYU"
        title="Command deck"
        clock
        chips={
          <span className="helm-chip" data-tone={onWatch > 0 ? "green" : "muted"}>
            {onWatch} of {agents.length} on watch
          </span>
        }
      />

      {/* ── Captain band ───────────────────────────────────────────────────── */}
      <section className="bos-deck-captain" aria-labelledby="bos-deck-captain-title">
        <Compass />
        <div className="bos-deck-captain-body">
          <div className="bos-deck-captain-head">
            <h2 id="bos-deck-captain-title" className="bos-deck-captain-title">
              Captain <span className="bos-deck-captain-sub">/ CEO</span>
            </h2>
            <span className="helm-chip" data-tone={BADGE_TONE[captainBadge]}>
              {BADGE_LABEL[captainBadge]}
            </span>
          </div>
          <p className="bos-deck-captain-desc">
            Reads what every station learned today, decides what actually needs attention, and hands out
            the follow-ups. Nothing here starts from a blank page.
          </p>
          {scoreError && (
            <p className="bos-deck-note helm-mono">scoreboard unavailable — runtime not reachable</p>
          )}
          {vaultError && (
            <p className="bos-deck-note helm-mono">vault unavailable — record count not read</p>
          )}
        </div>
        <div className="bos-deck-stats">
          <Stat label="APPROVED TODAY" value={num(score?.approved)} title="Deliveries you approved in the last 24h" />
          <Stat label="DECISIONS TODAY" value={num(score?.decided)} title="Approvals, rejections and change requests in the last 24h" />
          <Stat
            label="RECORDS READ"
            value={vault ? String(vault.total) : "—"}
            title={venture ? `Knowledge vault records in ${venture}` : "Knowledge vault records across every venture"}
          />
          <button type="button" className="bos-deck-cta" onClick={onOpenBrief} title="Open the CEO brief">
            Open brief →
          </button>
        </div>
      </section>

      {/* ── Stations band ──────────────────────────────────────────────────── */}
      <div className="bos-deck-divider">
        <span className="bos-deck-divider-label helm-mono">STATIONS, ONE MEMORY</span>
        <span className="bos-deck-hairline" aria-hidden />
      </div>

      {cards.length === 0 ? (
        <p className="bos-deck-empty helm-mono">no stations reporting yet — waiting on the runtime</p>
      ) : (
        <div className="bos-deck-grid">
          {cards.map((a, i) => (
            <StationCard
              key={a.id}
              agent={a}
              station={stationById(a.id)}
              index={i}
              // A seeded station opens its skill sheet; a swarm agent opens the
              // EXISTING inspect drawer — no second inspector, no invented skills.
              onOpen={(agent, station) => (station ? setOpen({ agent, station }) : onAgent(agent.id))}
            />
          ))}
        </div>
      )}

      <div className="bos-deck-foot">
        <button type="button" className="bos-deck-cta" onClick={onOpenFactory}>
          + New station
        </button>
      </div>

      {open && (
        <StationModal
          station={open.station}
          agent={agents.find((a) => a.id === open.agent.id) ?? null}
          onClose={() => setOpen(null)}
          onOpenFactory={onOpenFactory}
        />
      )}
    </div>
  );
}
