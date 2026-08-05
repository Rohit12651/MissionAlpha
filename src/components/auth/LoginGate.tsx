// P9 — LoginGate. The full-surface sign-in shown ONLY when auth is active
// (≥2 accounts) and no valid session exists. Solo (0 or 1 account) never mounts this
// — the app renders as it always has. App-level, so it uses the base --c-* tokens
// (which resolve in every theme), not the helm-scoped inbox tokens.
import { useState, type FormEvent } from "react";
import { Lock } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import { useAuth } from "../../lib/useAuth";

export function LoginGate() {
  const { login } = useAuth();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await login(name.trim(), password);
    // On success the provider swaps this gate out; only failure lands back here.
    if (!r.ok) { setError(r.error || "Incorrect name or password."); setBusy(false); }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: tok("bg") }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-heading"
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-2xl border p-8 shadow-xl"
        style={{ background: tok("panel"), borderColor: tok("border"), color: tok("text") }}
      >
        <div className="mb-6 flex items-center gap-3">
          <span
            className="grid h-10 w-10 place-items-center rounded-xl"
            style={{ background: tok("panel-2"), color: tok("accent-cyan") }}
            aria-hidden="true"
          >
            <Lock size={18} />
          </span>
          <div>
            <h1 id="login-heading" className="text-base font-semibold tracking-tight">Sign in</h1>
            <p className="text-[12px]" style={{ color: tok("muted") }}>Mission Alpha · second seat</p>
          </div>
        </div>

        <label className="mb-1 block text-[12px] font-medium" htmlFor="login-name" style={{ color: tok("muted") }}>Name</label>
        <input
          id="login-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="username"
          autoFocus
          className="mb-4 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2"
          style={{ background: tok("bg"), borderColor: tok("border"), color: tok("text") }}
          aria-required="true"
        />

        <label className="mb-1 block text-[12px] font-medium" htmlFor="login-password" style={{ color: tok("muted") }}>Password</label>
        <input
          id="login-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="mb-4 w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2"
          style={{ background: tok("bg"), borderColor: tok("border"), color: tok("text") }}
          aria-required="true"
        />

        {error && (
          <p className="mb-4 text-[12px]" style={{ color: tok("stale-red") }} role="alert">{error}</p>
        )}

        <button
          type="submit"
          disabled={busy || !name.trim() || !password}
          className="w-full rounded-lg px-4 py-2 text-sm font-semibold transition-opacity disabled:opacity-50"
          style={{ background: tok("accent-cyan"), color: tok("bg") }}
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
