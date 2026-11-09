import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../../src/common/prisma.service';
import { MockPaymentProvider } from '../../src/providers/mock.provider';
import { Actor, createConnection, createTestApp, deliver, register, resetDb, waitFor } from '../helpers';

describe('Webhook processing (integration)', () => {
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

  const pay = (id = 'pay_1', extra: Record<string, unknown> = {}) => ({
    id, amount: '100.00', currency: 'EUR', reference: 'INV-1', customer_id: 'cust_1', ...extra,
  });
  const processed = (eventId: string) =>
    waitFor(async () => {
      const e = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
      return e && ['PROCESSED', 'IGNORED', 'DEAD_LETTER'].includes(e.status) ? e : null;
    });

  it('accepts a signed event, processes it asynchronously and records history', async () => {
    const res = await deliver(app, mock, conn, { id: 'evt_1', type: 'payment.succeeded', sequence: 1, payment: pay() }).expect(202);
    expect(res.body.status).toBe('accepted');
    const ev = await processed(res.body.eventId);
    expect(ev.status).toBe('PROCESSED');

    const txn = await prisma.transaction.findFirstOrThrow({ include: { history: true } });
    expect(txn.status).toBe('SUCCEEDED');
    expect(txn.amount.toString()).toBe('100');
    expect(txn.history).toHaveLength(1);
    expect(txn.history[0].toStatus).toBe('SUCCEEDED');
  });

  it('serves transactions over the API (BigInt sequence serialises; filters and detail work)', async () => {
    const r = await deliver(app, mock, conn, { id: 'evt_api', type: 'payment.succeeded', sequence: 7, payment: pay('pay_api', { reference: 'INV-API' }) }).expect(202);
    await processed(r.body.eventId);
    const h = { Authorization: `Bearer ${admin.token}` };
    const list = await request(app.getHttpServer()).get('/api/transactions?search=inv-api&status=SUCCEEDED&provider=mock&minAmount=50&maxAmount=150').set(h).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].lastEventSequence).toBe('7');
    expect(list.body.data[0].amount).toBe('100');
    const one = await request(app.getHttpServer()).get(`/api/transactions/${list.body.data[0].id}`).set(h).expect(200);
    expect(one.body.history).toHaveLength(1);
    await request(app.getHttpServer()).get('/api/transactions?status=FAILED').set(h).expect(200).expect((res) => expect(res.body.data).toHaveLength(0));
    await request(app.getHttpServer()).get('/api/webhooks/events/history').set(h).expect(200).expect((res) => expect(res.body.data[0].sequence).toBe('7'));
  });

  it('rejects an invalid signature (401) and stores nothing', async () => {
    const { rawBody } = mock.buildSignedEvent(conn.secret, { id: 'evt_x', type: 'payment.succeeded', sequence: 1, payment: pay() });
    await request(app.getHttpServer()).post(`/api/webhooks/mock?connection=${conn.id}`)
      .set('Content-Type', 'application/json').set('X-PayFlow-Signature', 't=1,v1=deadbeef').send(rawBody).expect(401);
    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(await prisma.transaction.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'webhook.signature_invalid' } })).toBe(1);
  });

  it('rejects a payload that was tampered with after signing', async () => {
    const { rawBody, signature } = mock.buildSignedEvent(conn.secret, { id: 'evt_t', type: 'payment.failed', sequence: 1, payment: pay() });
    await request(app.getHttpServer()).post(`/api/webhooks/mock?connection=${conn.id}`)
      .set('Content-Type', 'application/json').set('X-PayFlow-Signature', signature)
      .send(rawBody.replace('"100.00"', '"1.00"')).expect(401);
    expect(await prisma.webhookEvent.count()).toBe(0);
  });

  it('rejects a replayed old timestamp', async () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    await deliver(app, mock, conn, { id: 'evt_old', type: 'payment.succeeded', sequence: 1, payment: pay() }, old).expect(401);
  });

  it('treats an unknown connection like a bad signature (no endpoint enumeration)', async () => {
    const { rawBody, signature } = mock.buildSignedEvent(conn.secret, { id: 'e', type: 'payment.created', sequence: 1, payment: pay() });
    await request(app.getHttpServer()).post('/api/webhooks/mock?connection=00000000-0000-4000-8000-000000000000')
      .set('Content-Type', 'application/json').set('X-PayFlow-Signature', signature).send(rawBody).expect(401);
  });

  it('rejects a validly-signed but malformed payload with 400', async () => {
    const { rawBody, signature } = mock.buildSignedEvent(conn.secret, { id: 'evt_bad', type: 'payment.succeeded', sequence: 1, payment: pay('p', { amount: 'abc' }) });
    await request(app.getHttpServer()).post(`/api/webhooks/mock?connection=${conn.id}`)
      .set('Content-Type', 'application/json').set('X-PayFlow-Signature', signature).send(rawBody).expect(400);
  });

  it('is idempotent: redelivering the same event id never creates a second record', async () => {
    const e = { id: 'evt_dup', type: 'payment.succeeded', sequence: 1, payment: pay() };
    const first = await deliver(app, mock, conn, e).expect(202);
    await processed(first.body.eventId);
    const second = await deliver(app, mock, conn, e).expect(202);
    expect(second.body.status).toBe('duplicate');
    expect(second.body.eventId).toBe(first.body.eventId);

    expect(await prisma.webhookEvent.count()).toBe(1);
    expect(await prisma.transaction.count()).toBe(1);
    expect(await prisma.transactionStatusHistory.count()).toBe(1);
    expect((await prisma.webhookEvent.findFirstOrThrow()).duplicateCount).toBe(1);
  });

  it('survives 10 concurrent deliveries of the same event (one event, one transaction)', async () => {
    const e = { id: 'evt_race', type: 'payment.succeeded', sequence: 1, payment: pay('pay_race') };
    const results = await Promise.all(Array.from({ length: 10 }, () => deliver(app, mock, conn, e)));
    expect(results.every((r) => r.status === 202)).toBe(true);
    expect(results.filter((r) => r.body.status === 'accepted')).toHaveLength(1);
    await waitFor(async () => (await prisma.webhookEvent.findFirst({ where: { status: 'PROCESSED' } })) ?? null);
    expect(await prisma.webhookEvent.count()).toBe(1);
    expect(await prisma.transaction.count()).toBe(1);
  });

  it('keeps one transaction when different events for a NEW payment race each other', async () => {
    const events = [
      { id: 'e_a', type: 'payment.created', sequence: 1 },
      { id: 'e_b', type: 'payment.pending', sequence: 2 },
      { id: 'e_c', type: 'payment.succeeded', sequence: 3 },
    ];
    await Promise.all(events.map((ev) => deliver(app, mock, conn, { ...ev, payment: pay('pay_new') }).expect(202)));
    await waitFor(async () => (await prisma.webhookEvent.count({ where: { status: { in: ['PROCESSED', 'IGNORED'] } } })) === 3);
    expect(await prisma.transaction.count()).toBe(1);
    const txn = await prisma.transaction.findFirstOrThrow();
    expect(txn.status).toBe('SUCCEEDED'); // highest sequence wins regardless of arrival order
    expect(txn.lastEventSequence).toBe(3n);
  });

  it('ignores an out-of-order event: late "pending" cannot overwrite "succeeded"', async () => {
    const ok = await deliver(app, mock, conn, { id: 'evt_s', type: 'payment.succeeded', sequence: 3, payment: pay('pay_ooo') }).expect(202);
    await processed(ok.body.eventId);
    const late = await deliver(app, mock, conn, { id: 'evt_p', type: 'payment.pending', sequence: 2, payment: pay('pay_ooo') }).expect(202);
    const ev = await processed(late.body.eventId);
    expect(ev.status).toBe('IGNORED');

    const txn = await prisma.transaction.findFirstOrThrow({ include: { history: true } });
    expect(txn.status).toBe('SUCCEEDED');
    expect(txn.history).toHaveLength(1);
  });

  it('rejects a regression from a terminal state even with a newer sequence', async () => {
    const f = await deliver(app, mock, conn, { id: 'evt_f', type: 'payment.failed', sequence: 2, payment: pay('pay_term') }).expect(202);
    await processed(f.body.eventId);
    const s = await deliver(app, mock, conn, { id: 'evt_s2', type: 'payment.succeeded', sequence: 9, payment: pay('pay_term') }).expect(202);
    expect((await processed(s.body.eventId)).status).toBe('IGNORED');
    expect((await prisma.transaction.findFirstOrThrow()).status).toBe('FAILED');
  });

  it('records a full lifecycle and supports refunds', async () => {
    const seq = [['payment.created', 1], ['payment.pending', 2], ['payment.succeeded', 3], ['payment.refunded', 4]] as const;
    for (const [type, sequence] of seq) {
      const r = await deliver(app, mock, conn, { id: `evt_${sequence}`, type, sequence, payment: pay('pay_life') }).expect(202);
      await processed(r.body.eventId);
    }
    const txn = await prisma.transaction.findFirstOrThrow({ include: { history: { orderBy: { occurredAt: 'asc' } } } });
    expect(txn.status).toBe('REFUNDED');
    expect(txn.history.map((h) => h.toStatus)).toEqual(['CREATED', 'PENDING', 'SUCCEEDED', 'REFUNDED']);
  });

  it('raises exactly one FAILED_PAYMENT exception and one notification for a failed payment', async () => {
    const r = await deliver(app, mock, conn, { id: 'evt_fail', type: 'payment.failed', sequence: 1, payment: pay('pay_fail') }).expect(202);
    await processed(r.body.eventId);
    const dup = await deliver(app, mock, conn, { id: 'evt_fail', type: 'payment.failed', sequence: 1, payment: pay('pay_fail') }).expect(202);
    expect(dup.body.status).toBe('duplicate');
    expect(await prisma.paymentException.count({ where: { type: 'FAILED_PAYMENT' } })).toBe(1);
    expect(await prisma.notification.count({ where: { kind: 'FAILED_PAYMENT' } })).toBe(1);
  });

  it('retries with backoff then dead-letters a persistently failing event, and tracks it', async () => {
    // Make processing fail deterministically: break the stored payload so parse throws inside the worker.
    const svc = app.get(require('../../src/webhooks/webhooks.module').WebhooksService);
    const rec = await prisma.webhookEvent.create({
      data: {
        organisationId: admin.orgId, connectionId: conn.id, providerEventId: 'evt_poison', type: 'payment.succeeded',
        sequence: 1n, payload: { id: 'evt_poison', type: 'payment.succeeded' },
      },
    });
    await svc.enqueue(rec.id);
    const ev = await waitFor(async () => {
      const e = await prisma.webhookEvent.findUnique({ where: { id: rec.id } });
      return e?.status === 'DEAD_LETTER' ? e : null;
    });
    expect(ev.attempts).toBe(3); // WEBHOOK_MAX_ATTEMPTS in test env
    expect(ev.lastError).toBeTruthy();
    expect(await prisma.notification.count({ where: { kind: 'WEBHOOK_DEAD_LETTER' } })).toBe(1);
    expect(await prisma.transaction.count()).toBe(0);
  });

  it('processing the same event twice (double enqueue) applies it once', async () => {
    const svc = app.get(require('../../src/webhooks/webhooks.module').WebhooksService);
    const r = await deliver(app, mock, conn, { id: 'evt_twice', type: 'payment.succeeded', sequence: 1, payment: pay('pay_twice') }).expect(202);
    await processed(r.body.eventId);
    expect(await svc.process(r.body.eventId)).toBe('skipped');
    expect(await prisma.transactionStatusHistory.count()).toBe(1);
  });
});
