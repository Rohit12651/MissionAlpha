import type { ReactNode } from "react";
import { tok } from "../lib/agentMeta";
import type { PreflightResult } from "../lib/runtimeBase";

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

function SetupScreen({ messages }: { messages: string[] }) {
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
          MissionAlpha needs Claude Code on your machine before the swarm can
          start. Sort the items below, then relaunch.
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
        <p className="mt-5 text-[11px] text-muted">
          Once <code className="font-mono">claude --version</code> works in your
          terminal, restart MissionAlpha.
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
  children: ReactNode;
}

export function PreflightGate({ preflight, children }: PreflightGateProps) {
  // Dev / browser (no bridge) → run the cockpit untouched.
  if (!preflight) return <>{children}</>;

  // Hard block: can't reach Claude → friendly setup screen, not a broken UI.
  if (preflight.blocking) return <SetupScreen messages={preflight.messages} />;

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
