// P9 — the signed-in identity + a logout control. Renders nothing when auth is
// inactive (solo) so the chrome is unchanged for BOSS solo.
import { LogOut, UserRound } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import { useAuth } from "../../lib/useAuth";

export function CurrentUserChip() {
  const { authActive, user, logout } = useAuth();
  if (!authActive || !user) return null;
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span
        className="flex items-center gap-1.5 rounded-full border px-2.5 py-1"
        style={{ background: tok("panel-2"), borderColor: tok("border"), color: tok("text") }}
        title={`Signed in as ${user.name} (${user.role})`}
      >
        <UserRound size={13} style={{ color: tok("accent-cyan") }} aria-hidden="true" />
        <span className="font-medium">{user.name}</span>
        <span style={{ color: tok("muted") }}>· {user.role}</span>
      </span>
      <button
        type="button"
        onClick={() => void logout()}
        className="flex items-center gap-1 rounded-full border px-2.5 py-1 transition-opacity hover:opacity-80"
        style={{ borderColor: tok("border"), color: tok("muted") }}
        aria-label="Sign out"
      >
        <LogOut size={13} aria-hidden="true" />
        Sign out
      </button>
    </div>
  );
}
