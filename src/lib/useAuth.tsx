// P9 — auth context. Fetches /runtime/auth/me once on mount and exposes the current
// user + login/logout. When `authActive` is false (0 or 1 account) the whole thing is
// inert and the app renders exactly as pre-P9 (solo, zero-login).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getMe, login as apiLogin, logout as apiLogout, type AuthUser, type MeResult } from "./authClient";

interface AuthState {
  loading: boolean;
  authActive: boolean;
  userCount: number;
  user: AuthUser | null;
  /** Re-read /auth/me (after login/logout or a user-management change). */
  refresh: () => Promise<void>;
  login: (name: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResult>({ authActive: false, userCount: 0, user: null });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const next = await getMe();
    setMe(next);
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const login = useCallback(async (name: string, password: string) => {
    const r = await apiLogin(name, password);
    if (r.ok) await refresh();
    return { ok: r.ok, error: r.error };
  }, [refresh]);

  const logout = useCallback(async () => {
    await apiLogout();
    await refresh();
  }, [refresh]);

  const value = useMemo<AuthState>(
    () => ({ loading, authActive: me.authActive, userCount: me.userCount, user: me.user, refresh, login, logout }),
    [loading, me, refresh, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
