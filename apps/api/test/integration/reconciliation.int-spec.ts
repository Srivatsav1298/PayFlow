import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../../src/common/prisma.service';
import { MockPaymentProvider } from '../../src/providers/mock.provider';
import { Actor, auth, createConnection, createInvoice, createTestApp, makePayment, register, resetDb } from '../helpers';

describe('Reconciliation (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mock: MockPaymentProvider;
  let admin: Actor;
  let conn: { id: string; secret: string };

  beforeAll(async () => ({ app, prisma, mock } = await createTestApp()));
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await resetDb(prisma);
    admin = await register(app, 'admin@acme.test');
    conn = await createConnection(app, admin);
  });

  const run = () => request(app.getHttpServer()).post('/api/reconciliation/run').set(auth(admin.token));
  const pay = (id: string, o: Parameters<typeof makePayment>[4] extends infer T ? Partial<T> : never = {}) =>
    makePayment(app, mock, prisma, conn, { id, ...o } as never);
  const invoiceRow = (id: string) => prisma.invoice.findUniqueOrThrow({ where: { id } });
  const exceptionsOf = (type: string) => prisma.paymentException.findMany({ where: { type: type as never } });

  it('auto-confirms an exact match, marks the invoice paid, and is idempotent on re-run', async () => {
    const inv = await createInvoice(app, admin.token, { reference: 'INV-1' });
    await pay('p1', { reference: 'INV-1' });

    const first = await run().expect(200);
    expect(first.body.status).toBe('COMPLETED');
    expect(first.body.exactMatches).toBe(1);
    const i = await invoiceRow(inv.id);
    expect(i.status).toBe('PAID');
    expect(i.amountPaid.toString()).toBe('100');
    expect(await prisma.invoicePayment.count()).toBe(1);

    const second = await run().expect(200);
    expect(second.body.exactMatches).toBe(0);
    expect(second.body.suggestedMatches).toBe(0);
    expect(await prisma.invoicePayment.count()).toBe(1);
    expect((await invoiceRow(inv.id)).amountPaid.toString()).toBe('100');
  });

  it('NEVER auto-confirms an uncertain match: underpayment becomes a suggestion plus a discrepancy exception', async () => {
    const inv = await createInvoice(app, admin.token, { reference: 'INV-2' });
    await pay('p2', { reference: 'INV-2', amount: '60.00' });
    const r = await run().expect(200);
    expect(r.body.exactMatches).toBe(0);
    expect(r.body.suggestedMatches).toBe(1);
    expect((await invoiceRow(inv.id)).status).toBe('OPEN');
    expect(await prisma.invoicePayment.count()).toBe(0);
    const m = await prisma.reconciliationMatch.findFirstOrThrow();
    expect(m.status).toBe('SUGGESTED');
    expect(m.matchedAmount.toString()).toBe('60');
    expect(await exceptionsOf('AMOUNT_DISCREPANCY')).toHaveLength(1);
  });

  it('confirming the suggestion applies a partial payment; the remainder then matches exactly', async () => {
    const inv = await createInvoice(app, admin.token, { reference: 'INV-3' });
    await pay('p3a', { reference: 'INV-3', amount: '60.00' });
    await run().expect(200);
    const m = await prisma.reconciliationMatch.findFirstOrThrow();
    await request(app.getHttpServer()).post(`/api/reconciliation/matches/${m.id}/confirm`).set(auth(admin.token)).send({}).expect(200);
    let i = await invoiceRow(inv.id);
    expect(i.status).toBe('PARTIALLY_PAID');
    expect(i.amountPaid.toString()).toBe('60');

    await pay('p3b', { reference: 'INV-3', amount: '40.00' });
    const r = await run().expect(200);
    expect(r.body.exactMatches).toBe(1); // compared against OUTSTANDING (40), not the invoice total
    i = await invoiceRow(inv.id);
    expect(i.status).toBe('PAID');
    expect(i.amountPaid.toString()).toBe('100');
  });

  it('flags a currency mismatch and refuses to apply it', async () => {
    const inv = await createInvoice(app, admin.token, { reference: 'INV-4', currency: 'EUR' });
    const t = await pay('p4', { reference: 'INV-4', currency: 'USD' });
    await run().expect(200);
    expect(await exceptionsOf('CURRENCY_MISMATCH')).toHaveLength(1);
    expect(await prisma.invoicePayment.count()).toBe(0);
    await request(app.getHttpServer()).post('/api/reconciliation/matches/manual').set(auth(admin.token))
      .send({ transactionId: t.id, invoiceId: inv.id }).expect(400);
  });

  it('detects a duplicate payment and does not let it double-pay the invoice', async () => {
    const inv = await createInvoice(app, admin.token, { reference: 'INV-5' });
    const t = new Date('2025-03-01T10:00:00Z');
    await pay('p5a', { reference: 'INV-5', created: t });
    await pay('p5b', { reference: 'INV-5', created: new Date(t.getTime() + 600_000) });
    await run().expect(200);
    const dups = await exceptionsOf('DUPLICATE_TRANSACTION');
    expect(dups).toHaveLength(1);
    expect((await invoiceRow(inv.id)).amountPaid.toString()).toBe('100');
    expect(await prisma.invoicePayment.count()).toBe(1);
    await run().expect(200);
    expect(await exceptionsOf('DUPLICATE_TRANSACTION')).toHaveLength(1); // re-run does not duplicate the exception
  });

  it('raises UNMATCHED_TRANSACTION, then auto-resolves it after a manual match', async () => {
    const t = await pay('p6', { reference: 'MYSTERY-9', amount: '55.00', customerId: 'someone' });
    await run().expect(200);
    const [ex] = await exceptionsOf('UNMATCHED_TRANSACTION');
    expect(ex.status).toBe('OPEN');

    const inv = await createInvoice(app, admin.token, { reference: 'INV-6', amount: '55.00', customerId: 'someone' });
    await request(app.getHttpServer()).post('/api/reconciliation/matches/manual').set(auth(admin.token))
      .send({ transactionId: t.id, invoiceId: inv.id, note: 'Customer paid with wrong reference' }).expect(201);
    expect((await invoiceRow(inv.id)).status).toBe('PAID');
    const after = await prisma.paymentException.findUniqueOrThrow({ where: { id: ex.id } });
    expect(after.status).toBe('RESOLVED');
    expect(await prisma.auditLog.count({ where: { action: 'reconciliation.manual_match' } })).toBe(1);
  });

  it('does not resurrect a rejected suggestion on later runs', async () => {
    await createInvoice(app, admin.token, { reference: 'INV-7' });
    await pay('p7', { reference: 'INV-7', amount: '70.00' });
    await run().expect(200);
    const m = await prisma.reconciliationMatch.findFirstOrThrow();
    await request(app.getHttpServer()).post(`/api/reconciliation/matches/${m.id}/reject`).set(auth(admin.token)).send({ note: 'wrong' }).expect(200);
    await run().expect(200);
    expect((await prisma.reconciliationMatch.findUniqueOrThrow({ where: { id: m.id } })).status).toBe('REJECTED');
    expect(await prisma.reconciliationMatch.count()).toBe(1);
  });

  it('reverses a confirmed match and restores the invoice balance', async () => {
    const inv = await createInvoice(app, admin.token, { reference: 'INV-8' });
    await pay('p8', { reference: 'INV-8' });
    await run().expect(200);
    const m = await prisma.reconciliationMatch.findFirstOrThrow({ where: { status: 'CONFIRMED' } });
    await request(app.getHttpServer()).post(`/api/reconciliation/matches/${m.id}/reverse`).set(auth(admin.token)).send({ note: 'mistake' }).expect(200);
    const i = await invoiceRow(inv.id);
    expect(i.status).toBe('OPEN');
    expect(i.amountPaid.toString()).toBe('0');
    expect(await prisma.invoicePayment.count()).toBe(0);
  });

  it('two reviewers confirming the same suggestion concurrently: exactly one wins', async () => {
    const inv = await createInvoice(app, admin.token, { reference: 'INV-9' });
    await pay('p9', { reference: 'INV-9', amount: '60.00' });
    await run().expect(200);
    const m = await prisma.reconciliationMatch.findFirstOrThrow();
    const results = await Promise.all([1, 2, 3].map(() =>
      request(app.getHttpServer()).post(`/api/reconciliation/matches/${m.id}/confirm`).set(auth(admin.token)).send({})));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect((await invoiceRow(inv.id)).amountPaid.toString()).toBe('60'); // applied once, not three times
  });

  it('rejects over-allocation beyond the invoice outstanding or the payment remainder', async () => {
    const inv = await createInvoice(app, admin.token, { reference: 'INV-10', amount: '100.00' });
    const t = await pay('p10', { reference: 'whatever', amount: '500.00' });
    await request(app.getHttpServer()).post('/api/reconciliation/matches/manual').set(auth(admin.token))
      .send({ transactionId: t.id, invoiceId: inv.id, amount: '150.00' }).expect(409);
    await request(app.getHttpServer()).post('/api/reconciliation/matches/manual').set(auth(admin.token))
      .send({ transactionId: t.id, invoiceId: inv.id, amount: '100.00' }).expect(201);
    expect((await invoiceRow(inv.id)).status).toBe('PAID');
  });

  it('concurrent runs never produce a server error or duplicate matches (single run per org)', async () => {
    await createInvoice(app, admin.token, { reference: 'INV-11' });
    await pay('p11', { reference: 'INV-11' });
    const rs = await Promise.all([1, 2, 3, 4].map(() => run()));
    expect(rs.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect(await prisma.invoicePayment.count()).toBe(1);
    expect(await prisma.reconciliationRun.count({ where: { status: 'FAILED' } })).toBe(0);
  });

  it('raises DELAYED_EVENT for long-pending payments and UNMATCHED_INVOICE for overdue unpaid invoices', async () => {
    await pay('p12', { reference: 'INV-12', type: 'payment.pending', created: new Date('2025-01-01T00:00:00Z') });
    await createInvoice(app, admin.token, { reference: 'INV-13', dueInDays: -5 });
    await run().expect(200);
    expect(await exceptionsOf('DELAYED_EVENT')).toHaveLength(1);
    expect(await exceptionsOf('UNMATCHED_INVOICE')).toHaveLength(1);
  });

  it('honours organisation reconciliation config (tolerance makes a near-miss an exact match)', async () => {
    await request(app.getHttpServer()).patch('/api/organisations/current').set(auth(admin.token))
      .send({ reconciliationConfig: { amountTolerance: 0.5 } }).expect(200);
    const inv = await createInvoice(app, admin.token, { reference: 'INV-14' });
    await pay('p14', { reference: 'INV-14', amount: '100.30' });
    const r = await run().expect(200);
    expect(r.body.exactMatches).toBe(1);
    const i = await invoiceRow(inv.id);
    expect(i.status).toBe('PAID');
    expect(i.amountPaid.toString()).toBe('100'); // only what fits is applied
    await run().expect(200);
    expect(await exceptionsOf('UNMATCHED_TRANSACTION')).toHaveLength(0); // the 0.30 surplus is rounding, not a problem
  });

  it('settles an invoice when an underpayment is within tolerance', async () => {
    await request(app.getHttpServer()).patch('/api/organisations/current').set(auth(admin.token))
      .send({ reconciliationConfig: { amountTolerance: 0.5 } }).expect(200);
    const inv = await createInvoice(app, admin.token, { reference: 'INV-15' });
    await pay('p15', { reference: 'INV-15', amount: '99.80' });
    await run().expect(200);
    expect((await invoiceRow(inv.id)).status).toBe('PAID');
  });
});
