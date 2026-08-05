// P9 — Settings › Users. List / add (with role) / delete local accounts. Delete is
// F3-gated (PermissionGate). The operator TYPES the new password — it is never
// prefilled, never displayed back, and leaves the browser only over the token-gated
// POST. When ≥2 accounts exist the runtime turns on login for everyone; deleting back
// to one account returns the app to zero-login solo.
import { useCallback, useEffect, useState } from "react";
import { UserPlus, Trash2, Users } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import { useAuth } from "../../lib/useAuth";
import { PermissionGate } from "../PermissionGate";
import { CurrentUserChip } from "./CurrentUserChip";
import { createUser, deleteUser, listUsers, type ManagedUser, type Role } from "../../lib/authClient";

const ROLES: readonly Role[] = ["approver", "viewer"];
const ROLE_HINT: Record<Role, string> = {
  approver: "can approve, reject, request changes, and assign",
  viewer: "read-only — sees the Inbox, cannot decide",
};

export function UserManagement() {
  const { refresh, authActive, user } = useAuth();
  // Solo (no active auth) keeps full powers; once active, only an approver manages.
  const canManage = !authActive || user?.role === "approver";
  const [rows, setRows] = useState<ManagedUser[]>([]);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("approver");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<ManagedUser | null>(null);

  // Load accounts. A failed read must SURFACE (not silently leave an empty list that
  // reads as "solo mode" when the truth is "we could not ask").
  const reload = useCallback(async () => {
    try { setRows(await listUsers()); setError(null); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : "could not read accounts"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const onAdd = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await createUser(name.trim(), password, role);
    setBusy(false);
    if (!r.ok) { setError(r.error || "Could not add user."); return; }
    setName(""); setPassword(""); setRole("approver");
    await reload();
    await refresh(); // crossing 1→2 accounts turns login on for everyone
  }, [busy, name, password, role, reload, refresh]);

  const onConfirmDelete = useCallback(async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    const r = await deleteUser(target.id);
    if (!r.ok) { setError(r.error || "Could not remove user."); return; }
    await reload();
    await refresh(); // dropping back below 2 accounts returns the app to solo
  }, [pendingDelete, reload, refresh]);

  const canAdd = name.trim().length > 0 && password.length >= 8 && !busy;

  return (
    <section className="border-t border-border/50 py-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users size={15} style={{ color: tok("muted") }} aria-hidden="true" />
          <h3 className="text-sm font-semibold tracking-tight">Users &amp; roles</h3>
        </div>
        <CurrentUserChip />
      </div>
      <p className="mb-3 text-[12px]" style={{ color: tok("muted") }}>
        Add a second person to require sign-in. With one account (or none) the app stays zero-login — nothing changes for solo use.
      </p>

      {/* existing accounts */}
      <ul className="mb-4 flex list-none flex-col gap-1.5">
        {rows.length === 0 && (
          <li className="text-[12px]" style={{ color: tok("muted") }} role="status">
            {loading ? "Reading accounts…" : "No local accounts — solo mode."}
          </li>
        )}
        {rows.map((u) => (
          <li
            key={u.id}
            className="flex items-center justify-between rounded-lg border px-3 py-2"
            style={{ borderColor: tok("border"), background: tok("panel-2") }}
          >
            <span className="flex items-center gap-2 text-[13px]">
              <span className="font-medium">{u.name}</span>
              <span
                className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide"
                style={{ background: tok("bg"), color: u.role === "approver" ? tok("accent-cyan") : tok("muted") }}
              >
                {u.role}
              </span>
            </span>
            {canManage && (
              <button
                type="button"
                onClick={() => setPendingDelete(u)}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] transition-opacity hover:opacity-80"
                style={{ color: tok("stale-red") }}
                aria-label={`Remove ${u.name}`}
              >
                <Trash2 size={13} aria-hidden="true" /> Remove
              </button>
            )}
          </li>
        ))}
      </ul>

      {/* add form — approver / solo only */}
      {!canManage ? (
        <p className="text-[12px]" style={{ color: tok("muted") }} role="status">
          Read only — an approver manages users.
        </p>
      ) : (
      <div className="flex flex-col gap-2 rounded-lg border p-3" style={{ borderColor: tok("border") }}>
        <div className="grid grid-cols-2 gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            autoComplete="off"
            aria-label="New user name"
            className="rounded-md border px-2.5 py-1.5 text-[13px] outline-none focus:ring-2"
            style={{ background: tok("bg"), borderColor: tok("border"), color: tok("text") }}
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder="Password (min 8)"
            autoComplete="new-password"
            aria-label="New user password"
            className="rounded-md border px-2.5 py-1.5 text-[13px] outline-none focus:ring-2"
            style={{ background: tok("bg"), borderColor: tok("border"), color: tok("text") }}
          />
        </div>
        <div className="flex items-center gap-2">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            aria-label="New user role"
            className="rounded-md border px-2.5 py-1.5 text-[13px] outline-none focus:ring-2"
            style={{ background: tok("bg"), borderColor: tok("border"), color: tok("text") }}
          >
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <span className="text-[11.5px]" style={{ color: tok("muted") }}>{ROLE_HINT[role]}</span>
          <button
            type="button"
            onClick={() => void onAdd()}
            disabled={!canAdd}
            className="ml-auto flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-semibold transition-opacity disabled:opacity-50"
            style={{ background: tok("accent-cyan"), color: tok("bg") }}
          >
            <UserPlus size={14} aria-hidden="true" /> {busy ? "Adding…" : "Add user"}
          </button>
        </div>
        {error && <p className="text-[12px]" style={{ color: tok("stale-red") }} role="alert">{error}</p>}
      </div>
      )}

      <PermissionGate
        open={pendingDelete !== null}
        title="Remove user"
        summary={
          pendingDelete
            ? `Remove ${pendingDelete.name} (${pendingDelete.role}) and revoke their sessions. If this drops the app below two accounts, sign-in turns off and it returns to solo mode.`
            : ""
        }
        affected={pendingDelete ? [pendingDelete.name] : []}
        confirmLabel={pendingDelete ? `Remove ${pendingDelete.name}` : "Remove"}
        accent="stale-red"
        onConfirm={() => void onConfirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}
