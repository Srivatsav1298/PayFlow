import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { session } from '../api/client';
import { AuthProvider } from '../auth/AuthContext';
import { Badge, Modal, Pager } from '../components/ui';
import { validateRows } from '../pages/Invoices';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const user = (role: string) => ({ id: 'u1', email: 'a@b.test', name: 'Test User', memberships: [{ organisationId: 'o1', organisationName: 'Acme', role }] });
const emptyList = { data: [], meta: { page: 1, pageSize: 25, total: 0, totalPages: 0 } };
const overview = {
  totals: { transactions: 5, volume: [{ currency: 'EUR', amount: '440.50' }], succeeded: { count: 3, amount: [{ currency: 'EUR', amount: '390.50' }] }, failed: { count: 1, amount: [{ currency: 'EUR', amount: '30.00' }] }, pending: { count: 1, amount: [{ currency: 'EUR', amount: '20.00' }] }, refunded: { count: 0, amount: [] } },
  reconciliation: { succeededPayments: 3, reconciledPayments: 2, unmatchedPayments: 1, successRate: 66.7 },
  invoices: { overdue: 1, outstanding: [{ currency: 'EUR', amount: '75.00' }] },
  openExceptions: { total: 2, byType: [{ type: 'FAILED_PAYMENT', count: 1 }, { type: 'UNMATCHED_TRANSACTION', count: 1 }] },
  trends: { daily: [], monthly: [] },
};

function mockApi(role: string, extra: Record<string, unknown> = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input).split('?')[0].replace('/api', '');
    if (path === '/auth/refresh') return json(200, { accessToken: 'AT', refreshToken: 'RT2' });
    if (path === '/auth/me') return json(200, user(role));
    if (path === '/auth/login' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return body.password === 'right' ? json(200, { accessToken: 'AT', refreshToken: 'RT', user: user(role) }) : json(401, { message: 'Invalid credentials' });
    }
    if (path === '/reports/overview') return json(200, overview);
    if (path === '/notifications') return json(200, { ...emptyList, unread: 0 });
    if (path === '/payment-providers') return json(200, []); // the real endpoint returns a plain array
    if (path in extra) return json(200, extra[path]);
    return json(200, emptyList);
  }));
}

function renderApp(route = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={[route]}><AuthProvider><App /></AuthProvider></MemoryRouter></QueryClientProvider>,
  );
}

describe('web app', () => {
  beforeEach(() => { localStorage.clear(); session.clear(); });
  afterEach(() => vi.unstubAllGlobals());

  describe('authentication', () => {
    it('redirects anonymous visitors to the sign-in page', async () => {
      mockApi('ADMIN');
      renderApp('/transactions');
      expect(await screen.findByRole('heading', { name: /sign in to payflow/i })).toBeInTheDocument();
    });

    it('shows an accessible error for wrong credentials and stays on the form', async () => {
      mockApi('ADMIN');
      renderApp('/login');
      await userEvent.type(screen.getByLabelText('Email'), 'a@b.test');
      await userEvent.type(screen.getByLabelText('Password'), 'wrong');
      await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials');
      expect(localStorage.getItem('pf.refresh')).toBeNull();
    });

    it('signs in and lands on the overview with live figures', async () => {
      mockApi('MANAGER');
      renderApp('/login');
      await userEvent.type(screen.getByLabelText('Email'), 'a@b.test');
      await userEvent.type(screen.getByLabelText('Password'), 'right');
      await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
      expect(await screen.findByRole('heading', { name: /financial overview/i })).toBeInTheDocument();
      expect(screen.getByText('66.7%')).toBeInTheDocument();
      expect(screen.getByText('EUR 440.50')).toBeInTheDocument();
      expect(localStorage.getItem('pf.refresh')).toBe('RT');
    });

    it('restores the session from a stored refresh token on reload', async () => {
      localStorage.setItem('pf.refresh', 'RT1');
      mockApi('ANALYST');
      renderApp('/');
      expect(await screen.findByRole('heading', { name: /financial overview/i })).toBeInTheDocument();
    });
  });

  describe('role-aware navigation', () => {
    const nav = async (role: string) => {
      localStorage.setItem('pf.refresh', 'RT1');
      mockApi(role);
      renderApp('/');
      await screen.findByRole('heading', { name: /financial overview/i });
      return within(screen.getByRole('navigation', { hidden: true }));
    };
    it('analyst sees no Reports or Settings', async () => {
      const n = await nav('ANALYST');
      expect(n.getByText('Transactions')).toBeInTheDocument();
      expect(n.queryByText('Reports')).not.toBeInTheDocument();
      expect(n.queryByText('Settings')).not.toBeInTheDocument();
      expect(n.queryByText('Activity')).not.toBeInTheDocument();
    });
    it('manager sees Reports and Activity but not Settings', async () => {
      const n = await nav('MANAGER');
      expect(n.getByText('Reports')).toBeInTheDocument();
      expect(n.getByText('Activity')).toBeInTheDocument();
      expect(n.queryByText('Settings')).not.toBeInTheDocument();
    });
    it('admin sees Settings', async () => {
      const n = await nav('ADMIN');
      expect(n.getByText('Settings')).toBeInTheDocument();
    });
    it('blocks a direct URL to a page above your role', async () => {
      localStorage.setItem('pf.refresh', 'RT1');
      mockApi('ANALYST');
      renderApp('/reports');
      expect(await screen.findByRole('alert')).toHaveTextContent(/does not have access/i);
    });
  });

  describe('pages', () => {
    it('analysts cannot see invoice create/import buttons; managers can', async () => {
      localStorage.setItem('pf.refresh', 'RT1');
      mockApi('ANALYST');
      const first = renderApp('/invoices');
      await screen.findByRole('heading', { name: 'Invoices' });
      expect(screen.queryByRole('button', { name: /new invoice/i })).not.toBeInTheDocument();
      first.unmount();
      mockApi('MANAGER');
      renderApp('/invoices');
      expect(await screen.findByRole('button', { name: /new invoice/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /import csv/i })).toBeInTheDocument();
    });

    it('lists transactions with status badges and formatted money', async () => {
      localStorage.setItem('pf.refresh', 'RT1');
      mockApi('MANAGER', {
        '/transactions': { data: [{ id: 't1', providerRef: 'pay_1', reference: 'INV-1001', customerId: 'c', amount: '1250.5', currency: 'EUR', status: 'FAILED', occurredAt: '2025-01-02T10:00:00Z', lastEventSequence: '3', connection: { id: 'c1', label: 'x', provider: { key: 'mock', name: 'Mock Payments' } } }], meta: { page: 1, pageSize: 25, total: 1, totalPages: 1 } },
        '/payment-providers': [{ key: 'mock', name: 'Mock Payments' }],
      });
      renderApp('/transactions');
      const row = (await screen.findByText('INV-1001')).closest('tr')!;
      expect(within(row).getByText('Failed')).toBeInTheDocument();
      expect(within(row).getByText('EUR 1,250.50')).toBeInTheDocument();
    });

    it('shows an empty state with a hint when nothing matches', async () => {
      localStorage.setItem('pf.refresh', 'RT1');
      mockApi('MANAGER');
      renderApp('/transactions?status=FAILED');
      expect(await screen.findByText(/no transactions match these filters/i)).toBeInTheDocument();
    });

    it('surfaces API failures instead of a blank page', async () => {
      localStorage.setItem('pf.refresh', 'RT1');
      mockApi('MANAGER');
      vi.stubGlobal('fetch', vi.fn(async (input: string) => {
        const p = String(input).split('?')[0].replace('/api', '');
        if (p === '/auth/refresh') return json(200, { accessToken: 'AT', refreshToken: 'R2' });
        if (p === '/auth/me') return json(200, user('MANAGER'));
        if (p === '/notifications') return json(200, { ...emptyList, unread: 0 });
        return json(500, { message: 'Internal server error' });
      }));
      renderApp('/invoices');
      expect(await screen.findByRole('alert')).toHaveTextContent('Internal server error');
    });
  });

  describe('invoice CSV import validation', () => {
    const header = 'reference,customerId,customerName,amount,currency,issuedAt,dueAt';
    it('accepts a valid file', () => {
      const r = validateRows(`${header}\nINV-1,c1,Acme,100.50,EUR,2025-01-01,2025-02-01`);
      expect(r.errors).toEqual([]);
      expect(r.invoices[0]).toMatchObject({ reference: 'INV-1', amount: '100.50', currency: 'EUR' });
    });
    it('reports every bad row with its line number so the file is fixed in one pass', () => {
      const r = validateRows(`${header}\n,c,n,abc,eur,2025-01-01,2025-02-01\nINV-2,c,n,10,EUR,2025-03-01,2025-01-01\nINV-3,c,n,10,EUR,not-a-date,2025-01-01`);
      expect(r.errors).toEqual(expect.arrayContaining([
        expect.stringContaining('Row 2: reference is required'), expect.stringContaining('Row 2: amount "abc"'),
        expect.stringContaining('Row 2: currency "eur"'), expect.stringContaining('Row 3: due date is before issue date'),
        expect.stringContaining('Row 4: dates must be ISO'),
      ]));
    });
    it('does not crash on invalid dates and rejects missing columns / empty files', () => {
      expect(() => validateRows(`${header}\nINV-1,c,n,10,EUR,garbage,garbage`)).not.toThrow();
      expect(validateRows('reference,amount\nINV-1,10').errors[0]).toMatch(/Missing column/);
      expect(validateRows(header).errors).toContain('The file has no data rows');
    });
    it('rejects negative, zero and 5-decimal amounts', () => {
      for (const bad of ['-5', '0', '1.23456', '1e3']) {
        expect(validateRows(`${header}\nINV-1,c,n,${bad},EUR,2025-01-01,2025-02-01`).errors.length).toBeGreaterThan(0);
      }
    });
  });

  describe('shared components (accessibility)', () => {
    it('badges always include a text label, not just colour', () => {
      render(<Badge value="DEAD_LETTER" />);
      expect(screen.getByText('Dead letter')).toBeInTheDocument();
    });
    it('pager disables unavailable directions and announces the page', async () => {
      const onPage = vi.fn();
      render(<Pager meta={{ page: 1, totalPages: 3, total: 60 }} onPage={onPage} />);
      expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
      await userEvent.click(screen.getByRole('button', { name: 'Next' }));
      expect(onPage).toHaveBeenCalledWith(2);
      expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    });
    it('modal is labelled by its title and closes via the close button', async () => {
      const onClose = vi.fn();
      render(<Modal open title="Confirm match" onClose={onClose}><p>body</p></Modal>);
      expect(screen.getByRole('dialog', { name: 'Confirm match' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /close dialog/i }));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });
  });
});
