/**
 * buyer/src/ui/state/AuthContext.tsx — React context for the operator login gate.
 *
 * On mount, probes /v1/auth/whoami to learn whether the existing buyer_session
 * cookie is valid. Exposes:
 *
 *   - status:   "checking" | "authenticated" | "unauthenticated"
 *   - refresh:  re-probes /v1/auth/whoami (call after a successful login POST)
 *   - signOut:  POSTs /v1/auth/logout, clears the cookie, drops to login screen
 *
 * <RequireAuth>{children}</RequireAuth> is a convenience wrapper used by App.tsx:
 *   - "checking":        renders a minimal blank loader (avoids the login flash)
 *   - "unauthenticated": renders <Login/>
 *   - "authenticated":   renders children
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import Login from "../pages/Login.js";

export type AuthStatus = "checking" | "authenticated" | "unauthenticated";

export interface AuthContextValue {
  status: AuthStatus;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const v = useContext(AuthContext);
  if (!v) {
    throw new Error("useAuth: no AuthContext in tree — wrap app in <AuthProvider>");
  }
  return v;
}

async function probeWhoami(): Promise<boolean> {
  try {
    const res = await fetch("/v1/auth/whoami", {
      method: "GET",
      credentials: "same-origin",
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface AuthProviderProps {
  children: ReactNode;
  /**
   * Optional initial status. When set, the provider skips the /v1/auth/whoami
   * probe and seeds the status directly. Useful for tests and for any future
   * server-side render path where the auth state is already known at mount.
   */
  initialStatus?: AuthStatus;
}

export function AuthProvider({ children, initialStatus }: AuthProviderProps) {
  const [status, setStatus] = useState<AuthStatus>(initialStatus ?? "checking");

  const refresh = useCallback(async () => {
    const ok = await probeWhoami();
    setStatus(ok ? "authenticated" : "unauthenticated");
  }, []);

  const signOut = useCallback(async () => {
    try {
      await fetch("/v1/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
    } catch {
      // best-effort: if the network is down we still want to render the
      // login screen locally so the operator doesn't keep operating on a
      // dead session.
    }
    setStatus("unauthenticated");
  }, []);

  useEffect(() => {
    if (initialStatus !== undefined) return; // caller-provided status; don't probe
    void refresh();
  }, [refresh, initialStatus]);

  // Listen for 401s from any /v1/* call and drop to the login screen.
  // We patch window.fetch once on mount and restore on unmount so other
  // code in the app keeps using the normal global. Scoped to /v1/* paths
  // so third-party fetches (e.g. asset URLs) don't accidentally trip the
  // gate. The /v1/auth/login probe itself can return 401 legitimately
  // (wrong password) — Login.tsx handles that locally, and we only flip
  // state when an authenticated session expires mid-use (a NON-/auth call
  // returns 401 while status === "authenticated").
  useEffect(() => {
    const original = window.fetch.bind(window);
    const patched: typeof window.fetch = async (input, init) => {
      const res = await original(input, init);
      const url = typeof input === "string"
        ? input
        : input instanceof URL ? input.toString()
        : (input as Request).url;
      if (res.status === 401 && url.includes("/v1/") && !url.includes("/v1/auth/")) {
        setStatus("unauthenticated");
      }
      return res;
    };
    window.fetch = patched;
    return () => {
      window.fetch = original;
    };
  }, []);

  return (
    <AuthContext.Provider value={{ status, refresh, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export interface RequireAuthProps {
  children: ReactNode;
}

export function RequireAuth({ children }: RequireAuthProps) {
  const { status } = useAuth();
  if (status === "checking") {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-400 text-sm">
        Loading…
      </div>
    );
  }
  if (status === "unauthenticated") {
    return <Login />;
  }
  return <>{children}</>;
}
