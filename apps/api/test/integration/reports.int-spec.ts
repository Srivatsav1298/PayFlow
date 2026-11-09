import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../../src/common/prisma.service';
import { MockPaymentProvider } from '../../src/providers/mock.provider';
import { Actor, addMember, auth, createConnection, createInvoice, createTestApp, makePayment, register, resetDb } from '../helpers';

describe('Reports & dashboard analytics (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mock: MockPaymentProvider;
  let admin: Actor;
  let conn: { id: string; secret: string };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => ({ app, prisma, mock } = await createTestApp()));
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await resetDb(prisma);
    admin = await register(app, 'admin@acme.test');
    conn = await createConnection(app, admin);
  });

  /** Known dataset: 3 succeeded (2 reconciled), 1 failed, 1 pending, 1 refunded; one USD payment. */
  async function seedKnownData() {
    await createInvoice(app, admin.token, { reference: 'INV-A', amount: '100.00' });
    await createInvoice(app, admin.token, { reference: 'INV-B', amount: '250.50' });
    await createInvoice(app, admin.token, { reference: 'INV-C', amount: '75.00', dueInDays: -40 });
    await makePayment(app, mock, prisma, conn, { id: 's1', reference: 'INV-A', amount: '100.00' });
    await makePayment(app, mock, prisma, conn, { id: 's2', reference: 'INV-B', amount: '250.50' });
    await makePayment(app, mock, prisma, conn, { id: 's3', reference: 'NOPE', amount: '40.00', customerId: 'zz' });
    await makePayment(app, mock, prisma, conn, { id: 'f1', reference: 'INV-X', amount: '30.00', type: 'payment.failed' });
    await makePayment(app, mock, prisma, conn, { id: 'p1', reference: 'INV-Y', amount: '20.00', type: 'payment.pending' });
    await http().post('/api/reconciliation/run').set(auth(admin.token)).expect(200);
  }

  it('overview figures match the database exactly', async () => {
    await seedKnownData();
    const { body: o } = await http().get('/api/reports/overview').set(auth(admin.token)).expect(200);

    expect(o.totals.transactions).toBe(5);
    expect(o.totals.succeeded.count).toBe(3);
    expect(o.totals.succeeded.amount).toEqual([{ currency: 'EUR', amount: '390.50' }]);
    expect(o.totals.failed.count).toBe(1);
    expect(o.totals.failed.amount).toEqual([{ currency: 'EUR', amount: '30.00' }]);
    expect(o.totals.pending.count).toBe(1);
    expect(o.totals.volume).toEqual([{ currency: 'EUR', amount: '440.50' }]);

    expect(o.reconciliation.succeededPayments).toBe(3);
    expect(o.reconciliation.reconciledPayments).toBe(2);
    expect(o.reconciliation.unmatchedPayments).toBe(1);
    expect(o.reconciliation.successRate).toBe(66.7);

    expect(o.invoices.overdue).toBe(1);
    expect(o.invoices.outstanding).toEqual([{ currency: 'EUR', amount: '75.00' }]);
    expect(o.openExceptions.byType.find((e: { type: string }) => e.type === 'FAILED_PAYMENT').count).toBe(1);
    expect(o.openExceptions.byType.find((e: { type: string }) => e.type === 'UNMATCHED_TRANSACTION').count).toBe(1);

    const today = o.trends.daily.reduce((n: number, d: { total: number }) => n + d.total, 0);
    expect(today).toBe(5);
    expect(o.trends.monthly.length).toBeGreaterThan(0);
  });

  it('overview reflects changes immediately (live data, not cached)', async () => {
    await seedKnownData();
    const before = (await http().get('/api/reports/overview').set(auth(admin.token))).body;
    await makePayment(app, mock, prisma, conn, { id: 's4', reference: 'INV-Z', amount: '10.00', type: 'payment.failed' });
    const after = (await http().get('/api/reports/overview').set(auth(admin.token))).body;
    expect(after.totals.failed.count).toBe(before.totals.failed.count + 1);
  });

  it('overview is empty-safe for a new organisation (no division by zero)', async () => {
    const fresh = await register(app, 'new@org.test', 'Fresh Org');
    const { body: o } = await http().get('/api/reports/overview').set(auth(fresh.token)).expect(200);
    expect(o.totals.transactions).toBe(0);
    expect(o.reconciliation.successRate).toBeNull();
  });

  it('date range filters the overview', async () => {
    await seedKnownData();
    const future = new Date(Date.now() + 86_400_000 * 5).toISOString();
    const { body } = await http().get(`/api/reports/overview?from=${encodeURIComponent(future)}`).set(auth(admin.token)).expect(200);
    expect(body.totals.transactions).toBe(0);
  });

  it('exports every report as CSV with correct headers and content', async () => {
    await seedKnownData();
    for (const name of ['reconciliation', 'transaction-volume', 'failed-payments', 'outstanding-invoices', 'provider-performance']) {
      const res = await http().get(`/api/reports/${name}?format=csv`).set(auth(admin.token)).expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain(`payflow-${name}-`);
      expect(res.text.split('\r\n')[0].length).toBeGreaterThan(5);
    }
    const failed = (await http().get('/api/reports/failed-payments?format=csv').set(auth(admin.token))).text.split('\r\n');
    expect(failed).toHaveLength(3); // header + 1 row + trailing blank
    expect(failed[1]).toContain('f1');
    expect(failed[1]).toContain('30.00');
    expect(await prisma.auditLog.count({ where: { action: 'report.export' } })).toBe(6);
  });

  it('JSON reports carry summary + rows; outstanding invoices include aging', async () => {
    await seedKnownData();
    const { body } = await http().get('/api/reports/outstanding-invoices').set(auth(admin.token)).expect(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ reference: 'INV-C', outstanding: '75.00', aging: '31-60' });
    expect(body.summary.outstandingByCurrency).toEqual([{ currency: 'EUR', amount: '75.00' }]);

    const perf = (await http().get('/api/reports/provider-performance').set(auth(admin.token)).expect(200)).body.data[0];
    expect(perf).toMatchObject({ provider: 'mock', payments: 5, succeeded: 3, failed: 1, pending: 1 });
    expect(perf.successRatePct).toBe(60);
    expect(perf.webhookEvents).toBe(5);

    const vol = (await http().get('/api/reports/transaction-volume?groupBy=month').set(auth(admin.token)).expect(200)).body.data;
    expect(vol.reduce((n: number, r: { total: number }) => n + r.total, 0)).toBe(5);
  });

  it('neutralises CSV formula injection from attacker-controlled payment references', async () => {
    await makePayment(app, mock, prisma, conn, { id: 'evil', reference: '=HYPERLINK("http://evil.test","click")', type: 'payment.failed' });
    const csv = (await http().get('/api/reports/failed-payments?format=csv').set(auth(admin.token)).expect(200)).text;
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.test"",""click"")"`);
    expect(csv).not.toMatch(/(^|,)"?=HYPERLINK/m);
  });

  it('enforces roles: analysts see the overview but cannot pull or export reports', async () => {
    const analyst = await addMember(app, admin, 'analyst@acme.test', 'ANALYST');
    const manager = await addMember(app, admin, 'manager@acme.test', 'MANAGER');
    await http().get('/api/reports/overview').set(auth(analyst)).expect(200);
    for (const name of ['reconciliation', 'transaction-volume', 'failed-payments', 'outstanding-invoices', 'provider-performance']) {
      await http().get(`/api/reports/${name}`).set(auth(analyst)).expect(403);
      await http().get(`/api/reports/${name}?format=csv`).set(auth(analyst)).expect(403);
      await http().get(`/api/reports/${name}?format=csv`).set(auth(manager)).expect(200);
    }
  });

  it("never includes another organisation's data", async () => {
    await seedKnownData();
    const other = await register(app, 'other@org.test', 'Other Org');
    const o = (await http().get('/api/reports/overview').set(auth(other.token)).expect(200)).body;
    expect(o.totals.transactions).toBe(0);
    const csv = (await http().get('/api/reports/failed-payments?format=csv').set(auth(other.token)).expect(200)).text;
    expect(csv).not.toContain('f1');
  });

  it('rejects invalid report parameters', async () => {
    await http().get('/api/reports/failed-payments?format=xml').set(auth(admin.token)).expect(400);
    await http().get('/api/reports/transaction-volume?groupBy=year').set(auth(admin.token)).expect(400);
    await http().get('/api/reports/overview?from=not-a-date').set(auth(admin.token)).expect(400);
  });
});
