// SESSION 14 (option A) — the collaboration thread.
//
// Hallmark · component: thread-list · genre: editorial (inherited from the helm cockpit)
// theme: existing --helm-* tokens (no new palette, no new font)
// states: default · hover · focus-visible · active · disabled · loading · error · empty
//
// REPLACES the raw Timeline. The old section rendered machine rows ("plan-drafted |
// vault:plan-… | 22:37") — true, but it never said who did the work, who received it, or
// why. This renders the SAME rows as "pm-analyst → architect · requirement spec", with the
// artifact readable in place.
//
// Two rules this component will not break:
//  • It never invents an author. `buildThread` hands it `from: null` for any transition the
//    server did not attribute, and an unattributed row renders as a plain event. A
//    stage→seat lookup would let every row carry a confident name, and the name would be a
//    guess — the defect class this whole session was spent removing.
//  • Artifacts load ON DEMAND. A design doc runs to ~11k characters; fetching every artifact
//    to render a timeline would pull ~26k characters of markdown into an overlay the
//    operator opened to glance at.
//
// All agent-authored text renders as TEXT NODES — no innerHTML anywhere.

import { useCallback, useState } from "react";
import { AlertTriangle, ArrowRight, CornerDownLeft, Dot, MessageSquare, UserCheck } from "lucide-react";
import { buildThread, artifactIdOf, type ThreadEntry, type ThreadKind } from "../../lib/storyThread";
import { whenLabel, type StoryLogRow, type StoryBuild } from "../../lib/storiesClient";
import { getVaultRecord } from "../../lib/vaultClient";
import type { Delivery } from "../../lib/inboxClient";

export interface StoryThreadProps {
  log: readonly StoryLogRow[] | null | undefined;
  gates: readonly Delivery[] | null | undefined;
  build: StoryBuild | null | undefined;
}

/** Chip tone per entry kind. `handoff` is the BASELINE and stays quiet — see below. */
const TONE: Record<ThreadKind, string> = {
  handoff: "muted",
  rework: "amber",
  failure: "red",
  gate: "amber",
  event: "muted",
  // A message is quiet by default — a conversation is normal, not an incident. A REFUSED
  // one is amber: the routing rules biting is exactly what an operator needs to notice.
  mail: "muted",
  "mail-refused": "amber",
};

const ICON: Record<ThreadKind, typeof ArrowRight> = {
  handoff: ArrowRight,
  rework: CornerDownLeft,
  failure: AlertTriangle,
  gate: UserCheck,
  event: Dot,
  mail: MessageSquare,
  "mail-refused": MessageSquare,
};

/** Human wording for the events the pipeline actually emits. Unknown names pass through. */
const EVENT_LABEL: Record<string, string> = {
  // Phase 8 — a message reads as a message. The KIND of message (handoff/question/answer)
  // arrives in the entry's detail field and is rendered beside it.
  mail: "messaged",
  "mail-refused": "message refused by the routing rules",
  create: "story created",
  advance: "handed on",
  "requirements-drafted": "wrote the requirement spec",
  "requirements-questions": "raised clarify questions",
  "design-drafted": "wrote the design",
  "design-approved": "design approved",
  "plan-drafted": "decomposed into build goals",
  "plan-empty": "decompose produced no valid goals",
  reject: "sent back for rework",
  "requirements-failed": "could not write the spec",
  "design-failed": "could not write the design",
  "plan-failed": "could not decompose the work",
};

const labelFor = (e: ThreadEntry) => (e.kind === "gate" ? e.label : EVENT_LABEL[e.label] ?? e.label);

function ArtifactBody({ recordId }: { recordId: string }) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [body, setBody] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const rec = await getVaultRecord(recordId);
      // The route answers 200 with an `error` field for an unknown/forbidden id — a body
      // of "" would render as an empty artifact and hide that the read actually failed.
      if (!rec || rec.error || typeof rec.body !== "string") { setState("error"); return; }
      setBody(rec.body);
      setState("idle");
    } catch {
      // A failed artifact read degrades THIS row only — the thread stays readable.
      setState("error");
    }
  }, [recordId]);

  if (body !== null) {
    return (
      <pre className="bos-thread-artifact helm-mono" tabIndex={0} aria-label="Artifact contents">
        {body || "(empty artifact)"}
      </pre>
    );
  }
  return (
    <p className="bos-thread-artifact-actions">
      <button
        type="button"
        className="helm-btn"
        data-variant="quiet"
        data-state={state === "loading" ? "loading" : undefined}
        disabled={state === "loading"}
        onClick={load}
      >
        {state === "loading" ? "reading…" : "Read artifact"}
      </button>
      {state === "error" && (
        <span className="bos-thread-artifact-err helm-mono" role="alert">
          could not read it — <button type="button" className="bos-vault-retry" onClick={load}>retry</button>
        </span>
      )}
    </p>
  );
}

function ThreadRow({ entry }: { entry: ThreadEntry }) {
  const Icon = ICON[entry.kind];
  const recordId = artifactIdOf(entry.artifactRef);
  return (
    <li className="bos-thread-row" data-kind={entry.kind}>
      <span className="bos-thread-icon" aria-hidden>
        <Icon size={12} />
      </span>
      <div className="bos-thread-main">
        <p className="bos-thread-who">
          {entry.from ? (
            <>
              <span className="bos-thread-seat helm-mono">{entry.from}</span>
              {entry.to && (
                <>
                  <span className="bos-thread-arrow" aria-hidden>→</span>
                  <span className="bos-thread-seat helm-mono">{entry.to}</span>
                </>
              )}
            </>
          ) : (
            // No author recorded. Say so plainly rather than filling the gap with a guess.
            <span className="bos-thread-seat helm-mono" data-unattributed="true">system</span>
          )}
          <span className="helm-chip" data-tone={TONE[entry.kind]}>{labelFor(entry)}</span>
        </p>

        {entry.detail && <p className="bos-thread-detail">{entry.detail}</p>}

        {entry.evidence && (
          <ul className="bos-thread-evidence">
            {entry.evidence.map((ev, i) => (
              <li key={i} className="bos-thread-evidence-item">{ev}</li>
            ))}
          </ul>
        )}

        {recordId && <ArtifactBody recordId={recordId} />}
      </div>
      <span className="bos-thread-ts helm-mono">{whenLabel(entry.ts)}</span>
    </li>
  );
}

export function StoryThread({ log, gates, build }: StoryThreadProps) {
  const entries = buildThread({ log, gates, build });
  if (!entries.length) {
    return <p className="bos-story-note helm-mono">nothing has happened on this story yet.</p>;
  }
  return (
    <ol className="bos-thread" role="list" aria-label="Collaboration thread">
      {entries.map((e) => (
        <ThreadRow key={e.key} entry={e} />
      ))}
    </ol>
  );
}
