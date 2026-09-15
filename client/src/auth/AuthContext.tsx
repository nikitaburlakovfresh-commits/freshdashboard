import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { getMe, login as loginApi, logout as logoutApi } from '../api/endpoints';
import { setCsrfToken } from '../api/client';
import type { MeResponse } from '../api/types';

interface AuthState {
  me: MeResponse | null;
  loading: boolean;
  error: string | null;
  login: (login: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const meResp = await getMe();
      setCsrfToken(meResp.csrf_token);
      setMe(meResp);
    } catch {
      setCsrfToken(null);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (loginValue: string, password: string) => {
    setError(null);
    try {
      const session = await loginApi(loginValue, password);
      setCsrfToken(session.csrf_token);
      await refresh();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось войти.');
      throw err;
    }
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await logoutApi();
    } finally {
      setCsrfToken(null);
      setMe(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ me, loading, error, login, logout, refresh }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
