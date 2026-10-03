// Which LLM answers CHAT — chosen by the operator, asked once, then remembered.
//
// WHY THIS EXISTS. Chat used to pick its own backend from a heuristic
// (`capability !== "swarm"` → adapter, else the Claude CLI). Probing an account for tool
// support flipped it to "swarm", which silently EJECTED it from chat — so adding an
// OpenRouter key and measuring it moved chat somewhere else, and no surface ever said so.
//
// The rule now: an explicit choice wins, including for swarm-capable accounts. With no
// choice recorded the runtime ASKS (the chat stream returns the options) rather than
// answering from a model nobody picked. This is the control that answers it.
//
// Engine dispatch is a SEPARATE choice — it uses the ACTIVE account. One key can be right
// for one job and wrong for the other, which is exactly why they are not one setting.

import { useCallback, useEffect, useState } from "react";
import { runtimeToken, runtimeUrl } from "../../lib/runtimeBase";

interface Choice {
  id: string;
  label: string;
  providerType: string;
  model: string | null;
  via: "adapter" | "cli" | null;
  usable: boolean;
  why: string | null;
}

interface State {
  chatAccountId: string | null;
  mode: "adapter" | "cli" | "ask";
  reason: string;
  choices: Choice[];
}

const PATH = "/runtime/chat-account";

export function ChatModelPicker({ nonce = 0 }: { nonce?: number }) {
  const [s, setS] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [chooseError, setChooseError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const token = await runtimeToken();
      const r = await fetch(runtimeUrl(PATH), { cache: "no-store", headers: { "x-runtime-token": token } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setS((await r.json()) as State);
    } catch {
      // A transport failure is not "no choice made" — never render a picker that would
      // misrepresent the stored state.
      setS(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load, nonce]);

  const choose = useCallback(async (accountId: string | null) => {
    setBusy(true);
    setChooseError(null);
    try {
      const token = await runtimeToken();
      const r = await fetch(runtimeUrl(PATH), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-runtime-token": token },
        body: JSON.stringify({ accountId }),
      });
      // A refused choice must not look applied: say so, then re-read the stored state.
      if (!r.ok) setChooseError(`The runtime refused the choice (HTTP ${r.status}).`);
      await load();
    } catch {
      setChooseError("The runtime did not answer; nothing was changed.");
    } finally {
      setBusy(false);
    }
  }, [load]);

  // Phase G (ADR G-2): the mockup's Chat model card — a `.seg` of the real choices (an
  // account each) and the runtime's own sentence under it. A transport failure is not "no
  // choice made", so it says the runtime did not answer instead of drawing a picker.
  return (
    <div className="card">
      <div className="card-h"><h2>Chat model</h2><span className="sub">what the tech lead answers with</span></div>
      {!loaded ? (
        <div className="empty-note" role="status">Reading the chat choice…</div>
      ) : !s ? (
        <div className="empty-note">{"The runtime did not answer. "}<button type="button" className="linkish" onClick={() => void load()}>Retry</button></div>
      ) : (
        <>
          <div className="seg" aria-label="Chat model">
            {s.choices.map((c) => (
              // An UNUSABLE account is still shown, disabled, with the reason in the tooltip —
              // hiding it would leave the operator hunting for an account they know they added.
              <button key={c.id} type="button" aria-pressed={c.id === s.chatAccountId} disabled={busy || !c.usable}
                onClick={() => void choose(c.id)} title={c.usable ? `Route chat to ${c.label}${c.model ? ` · ${c.model}` : ""} (${c.via})` : (c.why ?? "unavailable")}>
                {c.label}
              </button>
            ))}
            {s.chatAccountId && (
              <button type="button" data-app-only="chat-clear" disabled={busy} onClick={() => void choose(null)} title="Clear the choice — the app will ask again on the next chat turn">Clear</button>
            )}
          </div>
          <p className="sub" style={{ margin: "12px 0 0" }}>{s.mode === "ask" ? `Not chosen yet. ${s.reason}` : s.reason}</p>
          {chooseError && <p className="sub" role="alert" style={{ margin: "8px 0 0", color: "var(--bad-ink)" }}>{chooseError}</p>}
        </>
      )}
    </div>
  );
}
