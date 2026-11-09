import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, refreshSession, session } from '../api/client';
import type { Membership, Role, User } from '../api/types';

interface AuthState {
  user: User | null;
  loading: boolean;
  org: Membership | null;
  role: Role | undefined;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  switchOrg(id: string): void;
}

const Ctx = createContext<AuthState | null>(null);
export const useAuth = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [orgId, setOrgId] = useState<string | null>(session.orgId());
  const [loading, setLoading] = useState(session.hasRefreshToken());

  const reset = useCallback(() => { session.clear(); setUser(null); qc.clear(); }, [qc]);

  useEffect(() => {
    session.onAuthLost(reset);
    if (!session.hasRefreshToken()) return;
    (async () => {
      try {
        if (await refreshSession()) setUser(await api.get<User>('/auth/me'));
        else reset();
      } catch { reset(); } finally { setLoading(false); }
    })();
  }, [reset]);

  const org = useMemo(() => user?.memberships.find((m) => m.organisationId === orgId) ?? user?.memberships[0] ?? null, [user, orgId]);
  useEffect(() => { session.setOrg(org?.organisationId ?? null); }, [org]);

  const value: AuthState = {
    user, loading, org, role: org?.role,
    async login(email, password) {
      const s = await api.post<{ accessToken: string; refreshToken: string; user: User }>('/auth/login', { email, password }, { auth: false });
      session.set(s);
      session.setOrg(null);
      setOrgId(null);
      setUser(s.user);
    },
    async logout() {
      const refreshToken = session.refreshToken();
      if (refreshToken) await api.post('/auth/logout', { refreshToken }, { auth: false }).catch(() => undefined);
      reset();
    },
    switchOrg(id) { session.setOrg(id); setOrgId(id); qc.clear(); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
