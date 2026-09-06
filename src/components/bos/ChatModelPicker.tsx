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
import { MessageSquare, Check, AlertTriangle } from "lucide-react";
import { tok } from "../../lib/agentMeta";
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

  const load = useCallback(async () => {
    try {
      const token = await runtimeToken();
      const r = await fetch(runtimeUrl(PATH), { cache: "no-store", headers: { "x-runtime-token": token } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setS((await r.json()) as State);
    } catch {
      // A transport failure is not "no choice made" — say nothing rather than render a
      // picker that would misrepresent the stored state.
      setS(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load, nonce]);

  const choose = useCallback(async (accountId: string | null) => {
    setBusy(true);
    try {
      const token = await runtimeToken();
      await fetch(runtimeUrl(PATH), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-runtime-token": token },
        body: JSON.stringify({ accountId }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }, [load]);

  if (!s) return null;

  const asking = s.mode === "ask";
  const color = asking ? tok("blocked-amber") : tok("done-green");

  return (
    <section
      className="flex flex-col gap-2 rounded-xl px-4 py-3"
      style={{
        backgroundColor: `color-mix(in oklch, ${color} 7%, transparent)`,
        border: `1px solid color-mix(in oklch, ${color} 24%, transparent)`,
      }}
      aria-label="Chat model"
    >
      <header className="flex items-center gap-2">
        {asking ? <AlertTriangle size={14} aria-hidden style={{ color }} /> : <MessageSquare size={14} aria-hidden style={{ color }} />}
        <span className="helm-eyebrow" style={{ color: tok("muted") }}>Chat model</span>
        <span className="ml-auto" style={{ color: tok("muted"), fontSize: "var(--type-1)" }}>
          {asking ? "not chosen" : `via ${s.mode}`}
        </span>
      </header>

      <p className="leading-relaxed" style={{ color: tok("muted"), fontSize: "var(--type-2)" }}>
        {s.reason}
      </p>

      <div className="flex flex-wrap gap-2">
        {s.choices.map((c) => {
          const picked = c.id === s.chatAccountId;
          return (
            <button
              key={c.id}
              type="button"
              disabled={busy || !c.usable}
              onClick={() => void choose(c.id)}
              // An UNUSABLE account is still shown, disabled, with the reason in the
              // tooltip — hiding it would leave the operator hunting for an account they
              // know they added.
              title={c.usable ? `Route chat to ${c.label} (${c.via})` : (c.why ?? "unavailable")}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-semibold outline-none transition-colors focus-visible:ring-2 disabled:opacity-45"
              style={{
                fontSize: "var(--type-1)",
                color: picked ? tok("done-green") : tok("text"),
                border: `1px solid color-mix(in oklch, ${picked ? tok("done-green") : tok("border")} 55%, transparent)`,
                backgroundColor: picked ? `color-mix(in oklch, ${tok("done-green")} 12%, transparent)` : "transparent",
              }}
            >
              {picked && <Check size={12} aria-hidden />}
              {c.label}
              <span style={{ color: tok("muted") }}>
                {c.model ? `· ${c.model}` : `· ${c.providerType}`}
              </span>
            </button>
          );
        })}
        {s.chatAccountId && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void choose(null)}
            title="Clear the choice — the app will ask again on the next chat turn"
            className="rounded-lg px-2.5 py-1.5 outline-none transition-colors focus-visible:ring-2 disabled:opacity-45"
            style={{ fontSize: "var(--type-1)", color: tok("muted"), border: `1px solid color-mix(in oklch, ${tok("border")} 55%, transparent)` }}
          >
            Clear
          </button>
        )}
      </div>
    </section>
  );
}
