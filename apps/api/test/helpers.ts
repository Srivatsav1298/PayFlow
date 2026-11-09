import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/common/prisma.service';
import { MockPaymentProvider } from '../src/providers/mock.provider';

export async function createTestApp() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  configureApp(app);
  await app.init();
  return { app, prisma: app.get(PrismaService), mock: app.get(MockPaymentProvider) };
}

export async function resetDb(prisma: PrismaService) {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'PaymentProvider')`;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  if (list) await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export const PASSWORD = 'Str0ngPassw0rd!';

export interface Actor { token: string; refreshToken: string; userId: string; orgId: string; email: string }

export async function register(app: INestApplication, email: string, organisationName = 'Acme Oy'): Promise<Actor> {
  const res = await request(app.getHttpServer()).post('/api/auth/register')
    .send({ email, password: PASSWORD, name: 'Test User', organisationName }).expect(201);
  return {
    token: res.body.accessToken, refreshToken: res.body.refreshToken, userId: res.body.user.id,
    orgId: res.body.user.memberships[0].organisationId, email,
  };
}

export async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
  return res.body.accessToken;
}

/** Admin adds a member with the given role; returns that member's access token. */
export async function addMember(app: INestApplication, admin: Actor, email: string, role: Role): Promise<string> {
  await request(app.getHttpServer()).post('/api/organisations/current/members')
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ email, name: email.split('@')[0], password: PASSWORD, role }).expect(201);
  return login(app, email);
}

export const auth = (token: string, orgId?: string) => ({ Authorization: `Bearer ${token}`, ...(orgId ? { 'X-Organisation-Id': orgId } : {}) });

/** Create a mock connection; returns ids and the one-time webhook secret. */
export async function createConnection(app: INestApplication, admin: Actor, credentials: Record<string, unknown> = { seed: 'test', count: 30 }) {
  const res = await request(app.getHttpServer()).post('/api/integrations')
    .set(auth(admin.token)).send({ providerKey: 'mock', label: 'Mock sandbox', credentials }).expect(201);
  return { id: res.body.id as string, secret: res.body.webhookSecret as string, path: res.body.webhookPath as string };
}

export function deliver(app: INestApplication, mock: MockPaymentProvider, conn: { id: string; secret: string }, e: Parameters<MockPaymentProvider['buildSignedEvent']>[1], ts?: number) {
  const { rawBody, signature } = mock.buildSignedEvent(conn.secret, e, ts);
  return request(app.getHttpServer()).post(`/api/webhooks/mock?connection=${conn.id}`)
    .set('Content-Type', 'application/json').set('X-PayFlow-Signature', signature).send(rawBody);
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function createInvoice(
  app: INestApplication, token: string,
  o: { reference: string; amount?: string; currency?: string; customerId?: string; dueInDays?: number },
) {
  const day = 86_400_000;
  const res = await request(app.getHttpServer()).post('/api/invoices').set(auth(token)).send({
    reference: o.reference, amount: o.amount ?? '100.00', currency: o.currency ?? 'EUR', customerId: o.customerId ?? 'cust_1',
    issuedAt: new Date(Date.now() + (o.dueInDays ?? 10) * day - 20 * day).toISOString(),
    dueAt: new Date(Date.now() + (o.dueInDays ?? 10) * day).toISOString(), // always issued 20 days before it is due
  }).expect(201);
  return res.body as { id: string };
}

let evtCounter = 0;
/** Deliver a signed payment.succeeded (or other) event through the real webhook path and wait until it is stored. */
export async function makePayment(
  app: INestApplication, mock: MockPaymentProvider, prisma: PrismaService, conn: { id: string; secret: string },
  o: { id: string; amount?: string; currency?: string; reference?: string; customerId?: string; type?: string; created?: Date },
) {
  const type = o.type ?? 'payment.succeeded';
  await deliver(app, mock, conn, {
    id: `evt_test_${++evtCounter}_${o.id}`, type, sequence: 1, created: o.created,
    payment: { id: o.id, amount: o.amount ?? '100.00', currency: o.currency ?? 'EUR', reference: o.reference, customer_id: o.customerId ?? 'cust_1' },
  }).expect(202);
  const status = { 'payment.succeeded': 'SUCCEEDED', 'payment.pending': 'PENDING', 'payment.failed': 'FAILED' }[type] ?? 'CREATED';
  return waitFor(() => prisma.transaction.findFirst({ where: { providerRef: o.id, status: status as never } }));
}
