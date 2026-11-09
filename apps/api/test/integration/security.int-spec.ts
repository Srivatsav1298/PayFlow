import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../../src/common/prisma.service';
import { MockPaymentProvider } from '../../src/providers/mock.provider';
import {
  Actor, addMember, auth, createConnection, createInvoice, createTestApp, makePayment, register, resetDb,
} from '../helpers';

describe('Security: authentication, RBAC and organisation isolation (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let mock: MockPaymentProvider;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => ({ app, prisma, mock } = await createTestApp()));
  afterAll(async () => { await app.close(); });
  beforeEach(async () => resetDb(prisma));

  describe('organisation isolation', () => {
    let a: Actor, b: Actor, connA: { id: string; secret: string };
    let invoiceA: { id: string }, txnA: { id: string }, exceptionA: { id: string };

    beforeEach(async () => {
      a = await register(app, 'admin-a@a.test', 'Org A');
      b = await register(app, 'admin-b@b.test', 'Org B');
      connA = await createConnection(app, a);
      invoiceA = await createInvoice(app, a.token, { reference: 'A-1' });
      txnA = await makePayment(app, mock, prisma, connA, { id: 'pa1', reference: 'MYSTERY', amount: '77.00', customerId: 'x' });
      await http().post('/api/reconciliation/run').set(auth(a.token)).expect(200);
      exceptionA = await prisma.paymentException.findFirstOrThrow({ where: { organisationId: a.orgId } });
    });

    it("org B cannot read org A's records by id (404, not 403 — existence is not leaked)", async () => {
      await http().get(`/api/invoices/${invoiceA.id}`).set(auth(b.token)).expect(404);
      await http().get(`/api/transactions/${txnA.id}`).set(auth(b.token)).expect(404);
      await http().get(`/api/transactions/${txnA.id}/history`).set(auth(b.token)).expect(404);
      await http().get(`/api/exceptions/${exceptionA.id}`).set(auth(b.token)).expect(404);
    });

    it("org B's lists never contain org A's data", async () => {
      for (const path of ['invoices', 'transactions', 'exceptions', 'reconciliation/results', 'reconciliation/runs']) {
        const res = await http().get(`/api/${path}`).set(auth(b.token)).expect(200);
        expect(res.body.meta?.total ?? res.body.length).toBe(0);
      }
      const hit = await http().get('/api/transactions?search=pa1').set(auth(b.token)).expect(200);
      expect(hit.body.data).toHaveLength(0);
    });

    it('org B cannot act on org A records (resolve, assign, patch, manual match, simulate, sync)', async () => {
      await http().patch(`/api/exceptions/${exceptionA.id}/resolve`).set(auth(b.token)).send({ resolution: 'hijack' }).expect(404);
      await http().patch(`/api/exceptions/${exceptionA.id}/assign`).set(auth(b.token)).send({ assigneeId: b.userId }).expect(404);
      await http().patch(`/api/invoices/${invoiceA.id}`).set(auth(b.token)).send({ customerName: 'x' }).expect(404);
      const invB = await createInvoice(app, b.token, { reference: 'B-1' });
      await http().post('/api/reconciliation/matches/manual').set(auth(b.token)).send({ transactionId: txnA.id, invoiceId: invB.id }).expect(404);
      await http().post('/api/reconciliation/matches/manual').set(auth(b.token)).send({ transactionId: txnA.id, invoiceId: invoiceA.id }).expect(404);
      await http().post(`/api/integrations/${connA.id}/simulate`).set(auth(b.token)).send({ type: 'payment.succeeded' }).expect(404);
      await http().post('/api/transactions/import').set(auth(b.token)).send({ connectionId: connA.id }).expect(404);
      await http().post(`/api/integrations/${connA.id}/rotate-webhook-secret`).set(auth(b.token)).expect(404);
      expect((await prisma.paymentException.findUniqueOrThrow({ where: { id: exceptionA.id } })).status).toBe('OPEN');
    });

    it('cannot select another organisation via X-Organisation-Id (403)', async () => {
      await http().get('/api/invoices').set(auth(b.token, a.orgId)).expect(403);
      await http().get('/api/invoices').set(auth(b.token, b.orgId)).expect(200);
    });

    it("same invoice reference in two organisations is allowed and isolated", async () => {
      await createInvoice(app, b.token, { reference: 'A-1' });
      await http().post('/api/invoices').set(auth(a.token)).send({
        reference: 'A-1', amount: '1.00', currency: 'EUR', issuedAt: new Date().toISOString(), dueAt: new Date().toISOString(),
      }).expect(409); // but duplicate inside the SAME org is rejected
    });

    it("a webhook for org A's connection cannot be delivered with org B's secret", async () => {
      const connB = await createConnection(app, b);
      const { rawBody, signature } = mock.buildSignedEvent(connB.secret, { id: 'cross', type: 'payment.succeeded', sequence: 1, payment: { id: 'x', amount: '5.00', currency: 'EUR' } });
      await http().post(`/api/webhooks/mock?connection=${connA.id}`).set('Content-Type', 'application/json').set('X-PayFlow-Signature', signature).send(rawBody).expect(401);
    });
  });

  describe('role-based access control (enforced by the backend)', () => {
    let admin: Actor, manager: string, analyst: string;
    let invoice: { id: string }, exceptionId: string;

    beforeEach(async () => {
      admin = await register(app, 'admin@acme.test');
      manager = await addMember(app, admin, 'manager@acme.test', 'MANAGER');
      analyst = await addMember(app, admin, 'analyst@acme.test', 'ANALYST');
      invoice = await createInvoice(app, admin.token, { reference: 'R-1' });
      const conn = await createConnection(app, admin);
      await makePayment(app, mock, prisma, conn, { id: 'rp1', type: 'payment.failed' });
      exceptionId = (await prisma.paymentException.findFirstOrThrow()).id;
    });

    const newInvoice = { reference: 'R-NEW', amount: '10.00', currency: 'EUR', issuedAt: '2025-01-01T00:00:00Z', dueAt: '2025-02-01T00:00:00Z' };

    it('ANALYST: read-only on finance data; cannot mutate, run, resolve, or administer', async () => {
      for (const p of ['invoices', 'transactions', 'exceptions', 'reconciliation/results', 'reconciliation/runs', 'notifications', 'payment-providers']) {
        await http().get(`/api/${p}`).set(auth(analyst)).expect(200);
      }
      await http().post('/api/invoices').set(auth(analyst)).send(newInvoice).expect(403);
      await http().patch(`/api/invoices/${invoice.id}`).set(auth(analyst)).send({ customerName: 'x' }).expect(403);
      await http().post('/api/reconciliation/run').set(auth(analyst)).expect(403);
      await http().post('/api/reconciliation/matches/manual').set(auth(analyst)).send({ transactionId: invoice.id, invoiceId: invoice.id }).expect(403);
      await http().patch(`/api/exceptions/${exceptionId}/resolve`).set(auth(analyst)).send({ resolution: 'x' }).expect(403);
      await http().patch(`/api/exceptions/${exceptionId}/assign`).set(auth(analyst)).send({ assigneeId: null }).expect(403);
      await http().post('/api/transactions/import').set(auth(analyst)).send({ connectionId: invoice.id }).expect(403);
      await http().get('/api/integrations').set(auth(analyst)).expect(403);
      await http().get('/api/organisations/current/members').set(auth(analyst)).expect(403);
      await http().patch('/api/organisations/current').set(auth(analyst)).send({ name: 'x' }).expect(403);
      await http().get('/api/audit-logs').set(auth(analyst)).expect(403);
      await http().get('/api/webhooks/events/history').set(auth(analyst)).expect(403);
    });

    it('ANALYST can investigate: start investigation and add notes', async () => {
      await http().patch(`/api/exceptions/${exceptionId}/investigate`).set(auth(analyst)).expect(200);
      await http().post(`/api/exceptions/${exceptionId}/notes`).set(auth(analyst)).send({ text: 'Looks like card declined' }).expect(201);
      const ex = await prisma.paymentException.findUniqueOrThrow({ where: { id: exceptionId } });
      expect(ex.status).toBe('INVESTIGATING');
      expect(ex.notes as unknown[]).toHaveLength(1);
    });

    it('MANAGER: can operate finance workflows but not administer the organisation', async () => {
      await http().post('/api/invoices').set(auth(manager)).send(newInvoice).expect(201);
      await http().post('/api/reconciliation/run').set(auth(manager)).expect(200);
      await http().patch(`/api/exceptions/${exceptionId}/resolve`).set(auth(manager)).send({ resolution: 'Card declined, customer contacted' }).expect(200);
      await http().get('/api/integrations').set(auth(manager)).expect(403);
      await http().post('/api/integrations').set(auth(manager)).send({ providerKey: 'mock', label: 'x', credentials: {} }).expect(403);
      await http().post('/api/organisations/current/members').set(auth(manager)).send({ email: 'x@x.test', name: 'x', password: 'Str0ngPassw0rd!', role: 'ADMIN' }).expect(403);
      await http().patch('/api/organisations/current').set(auth(manager)).send({ name: 'x' }).expect(403);
    });

    it('ADMIN: full access including integrations, members and audit log', async () => {
      await http().get('/api/integrations').set(auth(admin.token)).expect(200);
      await http().get('/api/organisations/current/members').set(auth(admin.token)).expect(200);
      await http().get('/api/audit-logs').set(auth(admin.token)).expect(200);
      await http().post('/api/reconciliation/run').set(auth(admin.token)).expect(200);
    });

    it('role changes take effect immediately (membership is re-checked on every request)', async () => {
      await http().post('/api/invoices').set(auth(manager)).send(newInvoice).expect(201);
      const members = await http().get('/api/organisations/current/members').set(auth(admin.token)).expect(200);
      const m = members.body.find((x: { user: { email: string } }) => x.user.email === 'manager@acme.test');
      await http().patch(`/api/organisations/current/members/${m.id}`).set(auth(admin.token)).send({ role: 'ANALYST' }).expect(200);
      await http().post('/api/invoices').set(auth(manager)).send({ ...newInvoice, reference: 'R-NEW-2' }).expect(403);
      await http().delete(`/api/organisations/current/members/${m.id}`).set(auth(admin.token)).expect(200);
      await http().get('/api/invoices').set(auth(manager)).expect(403); // removed → no organisation at all
    });

    it('an organisation can never lose its last admin', async () => {
      const members = await http().get('/api/organisations/current/members').set(auth(admin.token)).expect(200);
      const self = members.body.find((x: { user: { email: string } }) => x.user.email === 'admin@acme.test');
      await http().delete(`/api/organisations/current/members/${self.id}`).set(auth(admin.token)).expect(403);
      await http().patch(`/api/organisations/current/members/${self.id}`).set(auth(admin.token)).send({ role: 'ANALYST' }).expect(403);
    });
  });

  describe('authentication & token handling', () => {
    it('rejects missing, malformed and forged tokens (401)', async () => {
      await http().get('/api/invoices').expect(401);
      await http().get('/api/invoices').set('Authorization', 'Bearer garbage').expect(401);
      await http().get('/api/invoices').set('Authorization', 'Basic abc').expect(401);
      const forged = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"x"}').toString('base64url')}.`;
      await http().get('/api/invoices').set('Authorization', `Bearer ${forged}`).expect(401);
    });

    it('login does not reveal whether an email exists', async () => {
      await register(app, 'real@acme.test');
      const wrongPw = await http().post('/api/auth/login').send({ email: 'real@acme.test', password: 'Wrong-Passw0rd' }).expect(401);
      const noUser = await http().post('/api/auth/login').send({ email: 'ghost@acme.test', password: 'Wrong-Passw0rd' }).expect(401);
      expect(wrongPw.body.message).toBe(noUser.body.message);
    });

    it('rotates refresh tokens and revokes the whole family on reuse (theft detection)', async () => {
      const u = await register(app, 'rot@acme.test');
      const r1 = await http().post('/api/auth/refresh').send({ refreshToken: u.refreshToken }).expect(200);
      expect(r1.body.refreshToken).not.toBe(u.refreshToken);
      await http().post('/api/auth/refresh').send({ refreshToken: u.refreshToken }).expect(401); // old token replayed
      await http().post('/api/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401); // family revoked
    });

    it('logout revokes the refresh token', async () => {
      const u = await register(app, 'out@acme.test');
      await http().post('/api/auth/logout').send({ refreshToken: u.refreshToken }).expect(200);
      await http().post('/api/auth/refresh').send({ refreshToken: u.refreshToken }).expect(401);
    });

    it('stores only hashes: no plaintext password or refresh token in the database', async () => {
      const u = await register(app, 'hash@acme.test');
      const user = await prisma.user.findUniqueOrThrow({ where: { email: 'hash@acme.test' } });
      expect(user.passwordHash).toMatch(/^scrypt\$/);
      expect(user.passwordHash).not.toContain('Str0ng');
      expect(await prisma.refreshToken.count({ where: { tokenHash: u.refreshToken } })).toBe(0);
    });

    it('enforces password strength and rejects unknown/extra fields (mass-assignment protection)', async () => {
      await http().post('/api/auth/register').send({ email: 'weak@acme.test', password: 'short', name: 'x', organisationName: 'y' }).expect(400);
      await http().post('/api/auth/register').send({ email: 'weak@acme.test', password: 'alllowercase1234', name: 'x', organisationName: 'y' }).expect(400);
      await http().post('/api/auth/register').send({ email: 'x@acme.test', password: 'Str0ngPassw0rd!', name: 'x', organisationName: 'y', role: 'ADMIN' }).expect(400);
    });

    it('rejects duplicate registration', async () => {
      await register(app, 'dup@acme.test');
      await http().post('/api/auth/register').send({ email: 'DUP@acme.test', password: 'Str0ngPassw0rd!', name: 'x', organisationName: 'y' }).expect(409);
    });
  });

  describe('input validation and secret handling', () => {
    let admin: Actor;
    beforeEach(async () => { admin = await register(app, 'admin@acme.test'); });

    it('rejects malformed money, currency and ids', async () => {
      const base = { reference: 'V-1', issuedAt: '2025-01-01T00:00:00Z', dueAt: '2025-02-01T00:00:00Z' };
      for (const amount of ['abc', '-5', '0', '1e5', '12.34567', '10,50', 100 as never]) {
        await http().post('/api/invoices').set(auth(admin.token)).send({ ...base, amount, currency: 'EUR' }).expect(400);
      }
      await http().post('/api/invoices').set(auth(admin.token)).send({ ...base, amount: '10.00', currency: 'eur' }).expect(400);
      await http().get('/api/invoices/not-a-uuid').set(auth(admin.token)).expect(400);
      await http().get('/api/invoices?pageSize=100000').set(auth(admin.token)).expect(400);
    });

    it('rejects an invoice due before it was issued', async () => {
      await http().post('/api/invoices').set(auth(admin.token)).send({ reference: 'V-2', amount: '1.00', currency: 'EUR', issuedAt: '2025-03-01T00:00:00Z', dueAt: '2025-01-01T00:00:00Z' }).expect(400);
    });

    it('never returns or stores provider secrets in plaintext', async () => {
      const created = await http().post('/api/integrations').set(auth(admin.token))
        .send({ providerKey: 'mock', label: 'Sandbox', credentials: { seed: 'topsecret-seed-value' } }).expect(201);
      expect(created.body.webhookSecret).toMatch(/^whsec_/); // shown once
      const list = await http().get('/api/integrations').set(auth(admin.token)).expect(200);
      const text = JSON.stringify(list.body);
      expect(text).not.toContain('webhookSecret');
      expect(text).not.toContain('encrypted');
      expect(text).not.toContain('topsecret-seed-value');
      const row = await prisma.providerConnection.findFirstOrThrow();
      expect(row.encryptedCredentials).not.toContain('topsecret-seed-value');
      expect(row.encryptedWebhookSecret).not.toContain(created.body.webhookSecret);
    });

    it('audit logs never contain secrets', async () => {
      await http().post('/api/integrations').set(auth(admin.token)).send({ providerKey: 'mock', label: 'S', credentials: { seed: 'abc' } }).expect(201);
      await http().post('/api/organisations/current/members').set(auth(admin.token))
        .send({ email: 'new@acme.test', name: 'New', password: 'Str0ngPassw0rd!', role: 'ANALYST' }).expect(201);
      const dump = JSON.stringify(await prisma.auditLog.findMany());
      expect(dump).not.toContain('Str0ngPassw0rd');
      expect(dump).not.toContain('whsec_');
    });

    it('does not leak internals in error responses', async () => {
      const res = await http().get('/api/invoices/00000000-0000-4000-8000-000000000000').set(auth(admin.token)).expect(404);
      expect(JSON.stringify(res.body)).not.toMatch(/prisma|stack|select|SQL/i);
    });

    it('sets security headers', async () => {
      const res = await http().get('/api/health').expect(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });
});
