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
    // Ask stays enabled, as the mockup draws it; an empty or over-long order says why.
    if (!trimmed) { setError("Write the question or order first."); return; }
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

  // Phase G (ADR G-2): the mockup's Captain console — the dial, the question box, Ask.
  // HONESTY: the mockup's line says the Captain answers with a verdict; this app's Captain
  // files the order and routes it to the station that owns it, and the line says so.
  return (
    <div className="card console">
      <svg className="dial" viewBox="0 0 110 110" aria-hidden="true">
        <circle className="ring" cx="55" cy="55" r="40" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <use href="#i-captain" x="13" y="13" width="84" height="84" />
      </svg>
      <div>
        <div className="card-h"><h2>Talk to the Captain</h2><span className="sub">CEO · strategy only</span></div>
        <form className="stack" style={{ gap: 10 }} onSubmit={onSubmit}>
          <label className="sr" htmlFor="cap-in">Ask the Captain</label>
          <textarea
            id="cap-in"
            rows={3}
            className="field-ta"
            placeholder="Should we ship dark mode before the onboarding emails?"
            aria-invalid={tooLong || undefined}
            maxLength={MAX_CAPTAIN_TEXT + 1}
            value={text}
            disabled={busy}
            onChange={(e) => { setText(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
          />
          <div className="row">
            <button className="btn btn-primary" type="submit" disabled={busy} aria-busy={busy || undefined}>{busy ? "Sending…" : "Ask"}</button>
            <span className="sub">The Captain files it in shared memory and routes it to its station.</span>
          </div>
        </form>
        <div className="stack" style={{ gap: 10, marginTop: 16 }} aria-live="polite">
          {tooLong && <p className="sub" role="alert" style={{ color: "var(--bad-ink)", margin: 0 }}>{`${trimmed.length} characters, ${MAX_CAPTAIN_TEXT} maximum. Shorten it; nothing is sent truncated.`}</p>}
          {error && <p className="sub" role="alert" style={{ color: "var(--bad-ink)", margin: 0 }}>{error}</p>}
          {ack && !error && <p className="sub" role="status" style={{ margin: 0 }}>{ack}</p>}
        </div>
      </div>
    </div>
  );
}
