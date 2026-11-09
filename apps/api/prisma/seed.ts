/**
 * Demo data: organisation, one user per role, a SANDBOX mock-provider connection, invoices and
 * simulated payments, then a real reconciliation run. Idempotent — safe to run repeatedly.
 * Refuses to run in production. All credentials below are demo-only.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Prisma, Role } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { encrypt, hashPassword } from '../src/common/crypto.util';
import { PrismaService } from '../src/common/prisma.service';
import { MockPaymentProvider } from '../src/providers/mock.provider';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service';
import { TransactionIngestService } from '../src/transactions/transaction-ingest.service';

export const DEMO_PASSWORD = 'Demo-Passw0rd!';
const USERS: Array<{ email: string; name: string; role: Role }> = [
  { email: 'admin@payflow.demo', name: 'Astrid Admin', role: 'ADMIN' },
  { email: 'manager@payflow.demo', name: 'Magnus Manager', role: 'MANAGER' },
  { email: 'analyst@payflow.demo', name: 'Anna Analyst', role: 'ANALYST' },
];
const COUNT = 60;

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const mock = app.get(MockPaymentProvider);
  const ingest = app.get(TransactionIngestService);
  const recon = app.get(ReconciliationService);
  const key = process.env.ENCRYPTION_KEY!;

  // Organisation + users
  const org = await prisma.organisation.upsert({
    where: { slug: 'nordlys-demo' }, update: {},
    create: { name: 'Nordlys Demo AS', slug: 'nordlys-demo', baseCurrency: 'EUR' },
  });
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  for (const u of USERS) {
    const user = await prisma.user.upsert({ where: { email: u.email }, update: {}, create: { email: u.email, name: u.name, passwordHash } });
    await prisma.organisationMembership.upsert({
      where: { userId_organisationId: { userId: user.id, organisationId: org.id } }, update: { role: u.role },
      create: { userId: user.id, organisationId: org.id, role: u.role },
    });
  }

  // Sandbox provider connection (mock). Webhook secret is printed once for local webhook testing.
  const provider = await prisma.paymentProvider.findUniqueOrThrow({ where: { key: 'mock' } });
  let conn = await prisma.providerConnection.findFirst({ where: { organisationId: org.id, providerId: provider.id } });
  let webhookSecret: string | null = null;
  const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
  const creds = { seed: 'demo', count: COUNT, startDate: new Date(midnight.getTime() - COUNT * 6 * 3_600_000).toISOString() };
  if (!conn) {
    webhookSecret = process.env.MOCK_PROVIDER_WEBHOOK_SECRET ?? 'whsec_mock_dev_secret';
    conn = await prisma.providerConnection.create({
      data: { organisationId: org.id, providerId: provider.id, label: 'Mock sandbox', encryptedCredentials: encrypt(JSON.stringify(creds), key), encryptedWebhookSecret: encrypt(webhookSecret, key) },
    });
  }

  // Pull the simulated provider's payments and create the invoices a business would have issued for them.
  const page = await mock.listPayments(creds, null, COUNT);
  let invoices = 0;
  for (const [i, { payment }] of page.payments.entries()) {
    const ref = payment.reference;
    const isDuplicate = i > 0 && i % 17 === 0; // duplicate payments share the original's invoice
    if (!ref?.startsWith('INV-') || isDuplicate) continue;
    // The provider deliberately overpays every 11th payment by 5.00 and bills every 13th in USD.
    const amount = new Prisma.Decimal(payment.amount).minus(i % 11 === 0 && i > 0 ? 5 : 0);
    const currency = i % 13 === 0 && i > 0 ? 'EUR' : payment.currency;
    const r = await prisma.invoice.createMany({
      data: [{ organisationId: org.id, reference: ref, customerId: payment.customerId, customerName: `Customer ${payment.customerId?.slice(-1)}`, amount, currency, issuedAt: new Date(payment.occurredAt.getTime() - 3 * 86_400_000), dueAt: new Date(payment.occurredAt.getTime() + 14 * 86_400_000) }],
      skipDuplicates: true,
    });
    invoices += r.count;
  }
  // Invoices nobody has paid (some already overdue) → unmatched-invoice exceptions.
  for (let k = 0; k < 8; k++) {
    const due = new Date(Date.now() + (k - 5) * 5 * 86_400_000);
    const r = await prisma.invoice.createMany({
      data: [{ organisationId: org.id, reference: `INV-${2000 + k}`, customerId: `cust_${k % 7}`, customerName: `Customer ${k % 7}`, amount: new Prisma.Decimal(150 + k * 35), currency: 'EUR', issuedAt: new Date(due.getTime() - 20 * 86_400_000), dueAt: due }],
      skipDuplicates: true,
    });
    invoices += r.count;
  }

  // Import payments through the same idempotent path webhooks use.
  let imported = 0;
  for (const { sequence, payment } of page.payments) {
    const r = await ingest.applyEvent(org.id, conn.id, { providerEventId: `import:${payment.providerRef}:${sequence}`, type: 'import', sequence, occurredAt: payment.occurredAt, payment });
    if (r.outcome === 'created') imported++;
  }
  await prisma.providerConnection.update({ where: { id: conn.id }, data: { syncCursor: page.nextCursor, lastSyncAt: new Date() } });

  const run = await recon.run(org.id, null).catch((e) => ({ status: `skipped (${(e as Error).message})` }));

  console.log('\nPayFlow demo data ready');
  console.log(`  organisation : ${org.name}`);
  console.log(`  created      : ${invoices} invoices, ${imported} transactions (idempotent: 0 on re-run)`);
  console.log(`  reconciliation: ${JSON.stringify(run, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  console.log('\n  Demo logins (password for all: ' + DEMO_PASSWORD + ')');
  USERS.forEach((u) => console.log(`    ${u.role.padEnd(8)} ${u.email}`));
  if (webhookSecret) console.log(`\n  Mock webhook: POST /api/webhooks/mock?connection=${conn.id}  (secret: ${webhookSecret})`);
  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
