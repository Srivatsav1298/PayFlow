import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, session } from './client';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('api client', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    localStorage.clear();
    session.clear();
    session.setOrg(null);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends the bearer token and organisation header', async () => {
    session.set({ accessToken: 'AT', refreshToken: 'RT' });
    session.setOrg('org-1');
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    await api.get('/invoices', { page: 2, search: '', status: undefined });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/invoices?page=2'); // empty/undefined params are dropped
    expect(init.headers.Authorization).toBe('Bearer AT');
    expect(init.headers['X-Organisation-Id']).toBe('org-1');
  });

  it('refreshes once on 401, retries the request, and stores the rotated refresh token', async () => {
    session.set({ accessToken: 'OLD', refreshToken: 'RT1' });
    fetchMock
      .mockResolvedValueOnce(json(401, { message: 'expired' }))
      .mockResolvedValueOnce(json(200, { accessToken: 'NEW', refreshToken: 'RT2' }))
      .mockResolvedValueOnce(json(200, { data: 1 }));
    await expect(api.get('/transactions')).resolves.toEqual({ data: 1 });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/refresh');
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer NEW');
    expect(localStorage.getItem('pf.refresh')).toBe('RT2');
  });

  it('shares ONE refresh between concurrent 401s (rotation would otherwise revoke the token family)', async () => {
    session.set({ accessToken: 'OLD', refreshToken: 'RT1' });
    let refreshes = 0;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === '/api/auth/refresh') { refreshes++; await new Promise((r) => setTimeout(r, 20)); return json(200, { accessToken: 'NEW', refreshToken: 'RT2' }); }
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === 'Bearer NEW' ? json(200, { ok: true }) : json(401, { message: 'expired' });
    });
    await Promise.all([api.get('/a'), api.get('/b'), api.get('/c')]);
    expect(refreshes).toBe(1);
  });

  it('signs the user out when the refresh fails', async () => {
    const lost = vi.fn();
    session.onAuthLost(lost);
    session.set({ accessToken: 'OLD', refreshToken: 'RT1' });
    fetchMock.mockResolvedValueOnce(json(401, {})).mockResolvedValueOnce(json(401, { message: 'Refresh token reuse detected' })).mockResolvedValue(json(401, {}));
    await expect(api.get('/x')).rejects.toBeInstanceOf(ApiError);
    expect(lost).toHaveBeenCalled();
    expect(localStorage.getItem('pf.refresh')).toBeNull();
  });

  it('surfaces validation messages from the API as a readable error', async () => {
    session.set({ accessToken: 'AT', refreshToken: 'RT' });
    fetchMock.mockResolvedValueOnce(json(400, { message: ['amount must be a positive decimal string', 'currency must be ISO'] }));
    await expect(api.post('/invoices', {})).rejects.toMatchObject({ status: 400, message: 'amount must be a positive decimal string; currency must be ISO' });
  });

  it('does not attach credentials to public calls (login)', async () => {
    session.set({ accessToken: 'AT', refreshToken: 'RT' });
    fetchMock.mockResolvedValueOnce(json(200, {}));
    await api.post('/auth/login', { email: 'a', password: 'b' }, { auth: false });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});
