'use client';

import type { AuthUser } from '@smartdesk/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { apiUrl } from '../config';
import { createApiClient, NetworkError, type ApiClient } from './client';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';
/** Why the user is signed out, when it was not their own choice. */
export type AuthNotice = 'expired' | 'network' | null;

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  notice: AuthNotice;
  api: ApiClient;
  signIn: (email: string, password: string) => Promise<AuthUser>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [notice, setNotice] = useState<AuthNotice>(null);

  const api = useMemo(
    () =>
      createApiClient({
        url: (path) => apiUrl(path),
        onSessionEnded: () => {
          setUser(null);
          setStatus('anonymous');
          setNotice('expired');
        },
      }),
    [],
  );

  // Restore the session once on load (the access token is memory-only, so a reload needs it).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api
      .restoreSession()
      .then((session) => {
        setUser(session?.user ?? null);
        setStatus(session ? 'authenticated' : 'anonymous');
      })
      .catch((err: unknown) => {
        setStatus('anonymous');
        if (err instanceof NetworkError) setNotice('network');
      });
  }, [api]);

  // Coming back to the tab re-checks the session, so a revoked or disabled account is noticed.
  useEffect(() => {
    if (status !== 'authenticated') return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      api
        .me()
        .then(setUser)
        .catch(() => {
          // A rejected session is handled by onSessionEnded; transient errors are ignored.
        });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [api, status]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const session = await api.login(email, password);
      setUser(session.user);
      setNotice(null);
      setStatus('authenticated');
      return session.user;
    },
    [api],
  );

  const signOut = useCallback(async () => {
    await api.logout();
    setUser(null);
    setNotice(null);
    setStatus('anonymous');
  }, [api]);

  const value = useMemo(
    () => ({ status, user, notice, api, signIn, signOut }),
    [status, user, notice, api, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
