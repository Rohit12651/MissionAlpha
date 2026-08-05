// B3 — the Captain's console: one line of plain text → a real routed task.
//
// WHAT IT DOES NOT CLAIM: the routing behind Send is a DETERMINISTIC KEYWORD TABLE
// (agent-runtime/captain.mjs), not a model classification, and this component says so
// in its own helper copy. The confirmation line names the station AND the keyword that
// decided it, so the BOSS can see the actual reason rather than trusting a black box.
//
// MOTION: the dial's ring pulse animates OPACITY ONLY (compositor-friendly, no layout,
// no transform) and is frozen by BOTH the reduced-motion media query and the explicit
// [data-reduce-motion="on"] toggle (bos.css). The Send button's hover is
// hover-gated + 140ms. Nothing else moves.
//
// NO innerHTML anywhere: every string reaches the DOM as a React text node.

import { useState, type FormEvent } from "react";
import { MAX_CAPTAIN_TEXT, routeCaptain, type CaptainRouted } from "../../lib/briefClient";

export interface CaptainConsoleProps {
  /** Fired with the runtime's verdict + the order that produced it, so the log can
   *  show the line immediately with the REAL record/task ids. */
  onRouted: (routed: CaptainRouted, text: string) => void;
}

/** The 88px dial. Decorative — the H3 beside it carries the meaning. */
function Dial() {
  return (
    <svg className="bos-brief-dial" viewBox="0 0 88 88" fill="none" aria-hidden focusable="false">
      <circle cx="44" cy="44" r="41" stroke="var(--helm-line)" strokeWidth="1" />
      <circle
        className="bos-brief-dial-pulse"
        cx="44" cy="44" r="34"
        stroke="var(--helm-brass)" strokeWidth="1.4"
      />
      <circle cx="44" cy="44" r="25" stroke="var(--helm-brass)" strokeWidth="0.7" opacity="0.4" />
      {/* cardinal ticks */}
      <path d="M44 6v7M44 75v7M6 44h7M75 44h7" stroke="var(--helm-brass)" strokeWidth="1.2" opacity="0.7" />
      {/* needle */}
      <path d="M56 32 42.4 39 32 56l13.6-7L56 32Z" fill="var(--helm-brass-bright)" />
      <circle cx="44" cy="44" r="2.4" fill="var(--helm-brass-bright)" />
    </svg>
  );
}

export function CaptainConsole({ onRouted }: CaptainConsoleProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState<string | null>(null);

  const trimmed = text.trim();
  const tooLong = trimmed.length > MAX_CAPTAIN_TEXT;
  const canSend = !busy && trimmed.length > 0 && !tooLong;

  // Enter submits because this is a real <form> with a submit button — no key handler,
  // no second code path, and the browser's own validation/AT semantics stay intact.
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSend) return;
    setBusy(true);
    setError(null);
    setAck(null);
    try {
      const r = await routeCaptain(trimmed);
      // A 400/403 arrives as a readable body, NOT an exception — surfacing it is the
      // whole point: an order that was refused must never look like one that landed.
      if (r?.error || !r?.recordId) {
        setError(r?.error || "the runtime did not accept that order");
        return;
      }
      onRouted(r, trimmed);
      setText("");
      setAck(
        r.matched
          ? `Sent to ${r.agentId} — matched the keyword “${r.matched}”.`
          : `Kept by the Captain (${r.agentId}) — no routing keyword matched.`,
      );
    } catch {
      setError("could not reach the runtime — the order was not given");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bos-brief-console" aria-labelledby="bos-brief-console-title">
      <Dial />
      <div className="bos-brief-console-body">
        <h3 id="bos-brief-console-title" className="bos-brief-h3">Talk to the Captain</h3>
        <p className="bos-brief-help">
          Type what you want handled. The Captain files it in shared memory and hands it to the station
          that owns it — matched on a fixed keyword list, not a model, so the reason is always visible.
        </p>

        <form className="bos-brief-form" onSubmit={onSubmit}>
          <input
            type="text"
            className="helm-input bos-brief-input"
            placeholder="e.g. check what our competitors changed this week"
            aria-label="Give the Captain an order"
            aria-invalid={tooLong || undefined}
            maxLength={MAX_CAPTAIN_TEXT + 1}
            value={text}
            disabled={busy}
            onChange={(e) => { setText(e.target.value); setError(null); }}
          />
          <button type="submit" className="bos-deck-cta bos-brief-send" disabled={!canSend} data-busy={busy || undefined}>
            {busy ? "Sending…" : "Send"}
          </button>
        </form>

        {tooLong && (
          <p className="bos-brief-error helm-mono" role="alert">
            {trimmed.length} characters — {MAX_CAPTAIN_TEXT} maximum. Shorten it; nothing is sent truncated.
          </p>
        )}
        {error && <p className="bos-brief-error helm-mono" role="alert">{error}</p>}
        {ack && !error && <p className="bos-brief-ack helm-mono" role="status">{ack}</p>}
      </div>
    </section>
  );
}
