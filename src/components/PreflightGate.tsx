import { useEffect, useState, type ReactNode } from "react";
import { tok } from "../lib/agentMeta";
import type { PreflightResult } from "../lib/runtimeBase";
import { getAccounts, authReady } from "../lib/accounts";

/*
  PreflightGate (F4) — stands between the window chrome and the cockpit.

  - In dev / browser the electron bridge is undefined, so `preflight` is
    undefined → render the cockpit normally (never crash, never block).
  - If `preflight.blocking` (missing `claude` or no Claude auth) → a friendly,
    onboarding-styled setup screen listing the exact `messages`, instead of a
    broken cockpit that can't reach the runtime.
  - If Docker is down but NOT blocking → render the cockpit with a slim,
    dismissible-feeling banner up top (chat still works; only /exec is gated).
  - Otherwise → render the cockpit (children).

  Controlled component: App owns the bridge subscription (so the StatusStrip
  sees the same result) and passes the latest push down here as a prop.
*/

function SetupScreen({ messages, onOpenAccounts }: { messages: string[]; onOpenAccounts?: () => void }) {
  const gold = tok("ceo-gold");
  const cyan = tok("accent-cyan");
  return (
    <main
      className="flex flex-1 items-center justify-center px-6"
      role="main"
      aria-labelledby="preflight-setup-heading"
    >
      <div
        className="w-full max-w-md rounded-xl border border-border p-7"
        style={{ backgroundColor: tok("panel") }}
      >
        <p
          className="text-[10px] font-semibold uppercase tracking-[0.1em]"
          style={{ color: gold }}
        >
          Welcome to MissionAlpha
        </p>
        <div
          className="my-3 flex h-10 w-10 items-center justify-center rounded-xl text-lg"
          style={{
            backgroundColor: `color-mix(in oklch, ${cyan} 12%, transparent)`,
            color: cyan,
          }}
          aria-hidden
        >
          ⚙
        </div>
        <h1 id="preflight-setup-heading" className="text-lg font-medium">
          A little setup first
        </h1>
        <p className="mt-1.5 text-[13px] text-muted">
          Add an account before the swarm can start — either your Claude Code
          subscription <em>or</em> an Anthropic API key. Sort the items below, or
          add one from the Accounts tab.
        </p>
        <ul className="mt-4 flex flex-col gap-2.5" aria-label="Setup steps">
          {messages.map((m, i) => (
            <li
              key={i}
              className="flex gap-2.5 rounded-lg border border-border p-3 text-[12.5px] leading-relaxed"
              style={{ backgroundColor: tok("panel-2") }}
            >
              <span
                className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: tok("blocked-amber") }}
                aria-hidden
              />
              <span>{m}</span>
            </li>
          ))}
        </ul>
        {onOpenAccounts && (
          <button
            type="button"
            onClick={onOpenAccounts}
            className="mt-4 w-full rounded-lg px-3 py-2 text-[13px] font-semibold outline-none transition-colors focus-visible:ring-2"
            style={{
              color: gold,
              backgroundColor: `color-mix(in oklch, ${gold} 12%, transparent)`,
              border: `1px solid color-mix(in oklch, ${gold} 30%, transparent)`,
            }}
          >
            Open Accounts &amp; add one
          </button>
        )}
        <p className="mt-5 text-[11px] text-muted">
          A Claude subscription works once <code className="font-mono">claude --version</code> does in
          your terminal; an API key can be added on the Accounts tab without restarting.
        </p>
      </div>
    </main>
  );
}

function DockerBanner() {
  const amber = tok("blocked-amber");
  return (
    <div
      role="status"
      aria-live="polite"
      className="relative z-10 flex items-center gap-2 border-b border-border px-4 py-1.5 text-[12px]"
      style={{
        color: amber,
        backgroundColor: `color-mix(in oklch, ${amber} 9%, transparent)`,
      }}
    >
      <span
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: amber }}
        aria-hidden
      />
      <span>
        Docker isn’t running — chat works, but sandboxed code execution
        (<code className="font-mono">/exec</code>) stays disabled until you start
        Docker.
      </span>
    </div>
  );
}

export interface PreflightGateProps {
  /** Latest preflight push from the electron bridge; undefined in dev/vite. */
  preflight?: PreflightResult;
  /** Open the Accounts tab (deeplink from the setup screen). */
  onOpenAccounts?: () => void;
  children: ReactNode;
}

export function PreflightGate({ preflight, onOpenAccounts, children }: PreflightGateProps) {
  // The electron preflight only knows about the `claude` CLI + an env
  // ANTHROPIC_API_KEY. An account added on the Accounts tab lives in the encrypted
  // credential store, invisible to that probe — so when preflight would block, ask
  // the runtime whether a usable account exists (a Claude subscription, OR any stored
  // secret) and, if so, let the cockpit render. Runs ONLY on the blocking path; never
  // fires in dev (preflight undefined → early return below).
  const [credReady, setCredReady] = useState(false);
  const blocking = !!preflight?.blocking;
  useEffect(() => {
    if (!blocking) { setCredReady(false); return; }
    let live = true;
    getAccounts()
      .then((r) => { if (live && authReady(r.accounts)) setCredReady(true); })
      .catch(() => { /* runtime unreachable → stay blocked, show setup */ });
    return () => { live = false; };
  }, [blocking]);

  // Dev / browser (no bridge) → run the cockpit untouched.
  if (!preflight) return <>{children}</>;

  // Hard block: no usable Claude auth AND no stored account → friendly setup screen.
  if (preflight.blocking && !credReady) return <SetupScreen messages={preflight.messages} onOpenAccounts={onOpenAccounts} />;

  // Soft warn: Docker down → banner above the cockpit, chat still usable.
  if (!preflight.docker) {
    return (
      <>
        <DockerBanner />
        {children}
      </>
    );
  }

  return <>{children}</>;
}
