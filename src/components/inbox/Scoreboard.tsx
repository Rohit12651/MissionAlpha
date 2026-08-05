import { useEffect, useState } from "react";
import { getScoreboard, type Scoreboard as ScoreboardData } from "../../lib/inboxClient";

/*
  P10 — the dogfood scoreboard.

  A calm, glanceable readout of the one number that says the Inbox is earning its keep:
  "N deliveries you approved this week ÷ the human-minutes they took." Computed live from
  decision timestamps (decidedAt − createdAt) — NEVER a dollar figure.

  It stays quiet: renders nothing until it has data, and nothing on error (a background
  metric should never shout or push a fake zero). Refetches when `refreshNonce` changes
  (the Inbox passes its pending count, so an approval refreshes the score).
*/
export function Scoreboard({ window = "7d", refreshNonce }: { window?: string; refreshNonce?: number }) {
  const [data, setData] = useState<ScoreboardData | null>(null);

  useEffect(() => {
    let live = true;
    getScoreboard(window)
      .then((d) => { if (live) setData(d); })
      .catch(() => { if (live) setData(null); }); // stay silent on error
    return () => { live = false; };
  }, [window, refreshNonce]);

  if (!data) return null;

  const { approved, avgMinutes, humanMinutes, perHour } = data;
  const title =
    approved === 0
      ? "No deliveries approved in the last week yet"
      : [
          `You approved ${approved} deliver${approved === 1 ? "y" : "ies"} in the last week`,
          avgMinutes != null ? `~${avgMinutes} min per decision` : null,
          `${humanMinutes} human-min total`,
          perHour != null ? `${perHour} approvals per human-hour` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <span
      className="helm-chip helm-mono text-[11px]"
      data-tone={approved > 0 ? "green" : "muted"}
      title={title}
      aria-label={title}
    >
      {approved} shipped/wk{avgMinutes != null ? ` · ~${avgMinutes}m ea` : ""}
    </span>
  );
}
