import { useEffect, useState } from "react";
import { getScoreboard, type Scoreboard as ScoreboardData } from "../../lib/inboxClient";

/*
  P10 — the dogfood scoreboard. Phase G (ADR G-2, D-7): the mockup's solid header chip,
  "Approved today N · decided M", read from GET /runtime/scoreboard (window=1d) — computed
  live from decision timestamps, never a dollar figure. It stays quiet: renders nothing
  until it has data, and nothing on error (a background metric never pushes a fake zero).
  Refetches when `refreshNonce` changes, so a decision moves it.
*/
export function Scoreboard({ refreshNonce }: { refreshNonce?: number }) {
  const [data, setData] = useState<ScoreboardData | null>(null);
  useEffect(() => {
    let live = true;
    getScoreboard("1d")
      .then((d) => { if (live) setData(d); })
      .catch(() => { if (live) setData(null); });
    return () => { live = false; };
  }, [refreshNonce]);
  if (!data) return null;
  const { approved, decided, avgMinutes } = data;
  const title = `${approved} approved and ${decided} decided in the last 24 hours${avgMinutes != null ? ` · ~${avgMinutes} min per decision` : ""}`;
  return <span className="chip solid" title={title} aria-label={title}>{`Approved today ${approved} · decided ${decided}`}</span>;
}
