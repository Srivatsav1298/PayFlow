/**
 * Thin fetch wrapper: bearer auth, X-Organisation-Id, and transparent single-flight token refresh.
 *
 * Storage trade-off (documented in README): the access token lives in memory only; the refresh token is
 * kept in localStorage so a reload keeps you signed in. An httpOnly-cookie refresh flow would be stronger
 * against XSS but needs a same-site API deployment, so it is listed as a future improvement.
 */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const REFRESH_KEY = 'pf.refresh';
const ORG_KEY = 'pf.org';
const safe = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onAuthLost: () => void = () => {};

export const session = {
  hasRefreshToken: () => !!safe.get(REFRESH_KEY),
  refreshToken: () => safe.get(REFRESH_KEY),
  set(tokens: { accessToken: string; refreshToken: string }) { accessToken = tokens.accessToken; safe.set(REFRESH_KEY, tokens.refreshToken); },
  clear() { accessToken = null; safe.del(REFRESH_KEY); },
  orgId: () => safe.get(ORG_KEY),
  setOrg(id: string | null) { if (id) safe.set(ORG_KEY, id); else safe.del(ORG_KEY); },
  onAuthLost(fn: () => void) { onAuthLost = fn; },
};

const base = '/api';

export async function refreshSession(): Promise<boolean> {
  const refreshToken = safe.get(REFRESH_KEY);
  if (!refreshToken) return false;
  // Single-flight: concurrent 401s share one refresh, otherwise rotation would revoke the token family.
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${base}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }) });
      if (!res.ok) return false;
      const data = await res.json();
      session.set(data);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

type Query = Record<string, string | number | boolean | undefined | null>;
interface Opts { method?: string; body?: unknown; query?: Query; auth?: boolean }

function url(path: string, query?: Query) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return `${base}${path}${s ? `?${s}` : ''}`;
}

async function send(path: string, o: Opts): Promise<{ res: Response; tokenUsed: string | null }> {
  const headers: Record<string, string> = {};
  const tokenUsed = o.auth !== false ? accessToken : null;
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  if (tokenUsed) headers.Authorization = `Bearer ${tokenUsed}`;
  const org = session.orgId();
  if (org && o.auth !== false) headers['X-Organisation-Id'] = org;
  const res = await fetch(url(path, o.query), { method: o.method ?? 'GET', headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { res, tokenUsed };
}

async function request(path: string, o: Opts = {}): Promise<Response> {
  let { res, tokenUsed } = await send(path, o);
  if (res.status === 401 && o.auth !== false) {
    // If another request already replaced the token while this one was in flight, just retry with it;
    // otherwise refresh (single-flight) first.
    const alreadyRefreshed = accessToken !== null && accessToken !== tokenUsed;
    if (alreadyRefreshed || (await refreshSession())) res = (await send(path, o)).res;
  }
  if (res.status === 401 && o.auth !== false) { session.clear(); onAuthLost(); }
  if (!res.ok) {
    let message = res.statusText;
    try {
      const b = await res.json();
      message = Array.isArray(b.message) ? b.message.join('; ') : (b.message ?? message);
    } catch { /* non-JSON error body */ }
    throw new ApiError(res.status, message);
  }
  return res;
}

const json = async <T>(path: string, o?: Opts) => (await request(path, o)).json() as Promise<T>;

export const api = {
  get: <T>(path: string, query?: Query) => json<T>(path, { query }),
  post: <T>(path: string, body?: unknown, o: Opts = {}) => json<T>(path, { ...o, method: 'POST', body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => json<T>(path, { method: 'PATCH', body: body ?? {} }),
  del: <T>(path: string) => json<T>(path, { method: 'DELETE' }),
  /** Authenticated file download (a plain <a href> cannot send the bearer token). */
  async download(path: string, query: Query, fallbackName: string) {
    const res = await request(path, { query });
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
};
