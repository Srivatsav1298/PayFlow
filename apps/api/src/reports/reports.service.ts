import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

export interface Range { from?: Date; to?: Date }
export type Report = { columns: string[]; rows: Array<Record<string, unknown>>; summary?: Record<string, unknown> };

const DAY = 86_400_000;
const money = (d: Prisma.Decimal | null | undefined) => (d ?? new Prisma.Decimal(0)).toFixed(2);
const CSV_LIMIT = 10_000;

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private dates(r: Range) {
    return { from: r.from ?? new Date(Date.now() - 90 * DAY), to: r.to ?? new Date() };
  }

  /** Dashboard numbers. Every figure is computed from the live database — nothing is cached or hard-coded. */
  async overview(orgId: string, r: Range) {
    const occurredAt = { ...(r.from && { gte: r.from }), ...(r.to && { lte: r.to }) };
    const base: Prisma.TransactionWhereInput = { organisationId: orgId, ...((r.from || r.to) && { occurredAt }) };

    const [byStatus, succeeded, reconciled, exceptions, outstandingRows, overdue, daily, monthly] = await Promise.all([
      this.prisma.transaction.groupBy({ by: ['status', 'currency'], where: base, _count: true, _sum: { amount: true } }),
      this.prisma.transaction.count({ where: { ...base, status: 'SUCCEEDED' } }),
      this.prisma.transaction.count({ where: { ...base, status: 'SUCCEEDED', invoicePayments: { some: {} } } }),
      this.prisma.paymentException.groupBy({ by: ['type'], where: { organisationId: orgId, status: { in: ['OPEN', 'INVESTIGATING'] } }, _count: true }),
      this.prisma.$queryRaw<{ currency: string; outstanding: string }[]>`
        SELECT currency, COALESCE(SUM(amount - "amountPaid"), 0)::text AS outstanding
        FROM "Invoice" WHERE "organisationId" = ${orgId} AND status IN ('OPEN', 'PARTIALLY_PAID') GROUP BY currency`,
      this.prisma.invoice.count({ where: { organisationId: orgId, status: { in: ['OPEN', 'PARTIALLY_PAID'] }, dueAt: { lt: new Date() } } }),
      this.trend(orgId, 'day', new Date(Date.now() - 30 * DAY)),
      this.trend(orgId, 'month', new Date(Date.now() - 365 * DAY)),
    ]);

    const count = (s: string) => byStatus.filter((x) => x.status === s).reduce((n, x) => n + x._count, 0);
    const sum = (s: string) => byStatus.filter((x) => x.status === s).map((x) => ({ currency: x.currency, amount: money(x._sum.amount) }));
    const totalByCurrency = new Map<string, Prisma.Decimal>();
    for (const x of byStatus) totalByCurrency.set(x.currency, (totalByCurrency.get(x.currency) ?? new Prisma.Decimal(0)).plus(x._sum.amount ?? 0));

    return {
      totals: {
        transactions: byStatus.reduce((n, x) => n + x._count, 0),
        volume: [...totalByCurrency].map(([currency, amount]) => ({ currency, amount: money(amount) })),
        succeeded: { count: count('SUCCEEDED'), amount: sum('SUCCEEDED') },
        failed: { count: count('FAILED'), amount: sum('FAILED') },
        pending: { count: count('PENDING') + count('CREATED'), amount: [...sum('PENDING'), ...sum('CREATED')] },
        refunded: { count: count('REFUNDED'), amount: sum('REFUNDED') },
      },
      reconciliation: {
        succeededPayments: succeeded,
        reconciledPayments: reconciled,
        unmatchedPayments: succeeded - reconciled,
        successRate: succeeded === 0 ? null : Number(((reconciled / succeeded) * 100).toFixed(1)),
      },
      invoices: { overdue, outstanding: outstandingRows.map((o) => ({ currency: o.currency, amount: new Prisma.Decimal(o.outstanding).toFixed(2) })) },
      openExceptions: { total: exceptions.reduce((n, e) => n + e._count, 0), byType: exceptions.map((e) => ({ type: e.type, count: e._count })) },
      trends: { daily, monthly },
    };
  }

  private async trend(orgId: string, unit: 'day' | 'month', since: Date) {
    const rows = await this.prisma.$queryRaw<{ bucket: Date; currency: string; total: number; succeeded: number; failed: number; pending: number; volume: string }[]>`
      SELECT date_trunc(${Prisma.raw(`'${unit}'`)}, "occurredAt") AS bucket, currency,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::int AS succeeded,
        COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
        COUNT(*) FILTER (WHERE status IN ('PENDING', 'CREATED'))::int AS pending,
        COALESCE(SUM(amount) FILTER (WHERE status = 'SUCCEEDED'), 0)::text AS volume
      FROM "Transaction" WHERE "organisationId" = ${orgId} AND "occurredAt" >= ${since}
      GROUP BY 1, 2 ORDER BY 1`;
    return rows.map((r) => ({ ...r, bucket: r.bucket.toISOString(), volume: new Prisma.Decimal(r.volume).toFixed(2) }));
  }

  // ───────── Downloadable reports (each returns columns + rows, rendered as JSON or CSV) ─────────

  async reconciliation(orgId: string, r: Range): Promise<Report> {
    const { from, to } = this.dates(r);
    const where: Prisma.ReconciliationMatchWhereInput = { organisationId: orgId, createdAt: { gte: from, lte: to } };
    const [matches, grouped] = await Promise.all([
      this.prisma.reconciliationMatch.findMany({
        where, orderBy: { createdAt: 'desc' }, take: CSV_LIMIT,
        include: { transaction: { select: { providerRef: true, reference: true, currency: true } }, invoice: { select: { reference: true } } },
      }),
      this.prisma.reconciliationMatch.groupBy({ by: ['status', 'type'], where, _count: true }),
    ]);
    return {
      columns: ['createdAt', 'status', 'type', 'score', 'paymentRef', 'paymentReference', 'invoiceRef', 'amount', 'currency', 'reviewedAt', 'note'],
      rows: matches.map((m) => ({
        createdAt: m.createdAt, status: m.status, type: m.type, score: m.score, paymentRef: m.transaction.providerRef,
        paymentReference: m.transaction.reference, invoiceRef: m.invoice.reference, amount: money(m.matchedAmount),
        currency: m.transaction.currency, reviewedAt: m.reviewedAt, note: m.note,
      })),
      summary: { from, to, byStatusAndType: grouped.map((g) => ({ status: g.status, type: g.type, count: g._count })) },
    };
  }

  async transactionVolume(orgId: string, r: Range, unit: 'day' | 'month'): Promise<Report> {
    const { from, to } = this.dates(r);
    const rows = await this.prisma.$queryRaw<{ bucket: Date; provider: string; currency: string; total: number; succeeded: number; failed: number; pending: number; refunded: number; volume: string }[]>`
      SELECT date_trunc(${Prisma.raw(`'${unit}'`)}, t."occurredAt") AS bucket, p.key AS provider, t.currency,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE t.status = 'SUCCEEDED')::int AS succeeded,
        COUNT(*) FILTER (WHERE t.status = 'FAILED')::int AS failed,
        COUNT(*) FILTER (WHERE t.status IN ('PENDING', 'CREATED'))::int AS pending,
        COUNT(*) FILTER (WHERE t.status = 'REFUNDED')::int AS refunded,
        COALESCE(SUM(t.amount) FILTER (WHERE t.status = 'SUCCEEDED'), 0)::text AS volume
      FROM "Transaction" t
      JOIN "ProviderConnection" c ON c.id = t."connectionId"
      JOIN "PaymentProvider" p ON p.id = c."providerId"
      WHERE t."organisationId" = ${orgId} AND t."occurredAt" >= ${from} AND t."occurredAt" <= ${to}
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
    return {
      columns: ['period', 'provider', 'currency', 'total', 'succeeded', 'failed', 'pending', 'refunded', 'succeededVolume'],
      rows: rows.map((x) => ({ period: x.bucket.toISOString().slice(0, unit === 'day' ? 10 : 7), provider: x.provider, currency: x.currency, total: x.total, succeeded: x.succeeded, failed: x.failed, pending: x.pending, refunded: x.refunded, succeededVolume: new Prisma.Decimal(x.volume).toFixed(2) })),
      summary: { from, to, unit },
    };
  }

  async failedPayments(orgId: string, r: Range): Promise<Report> {
    const { from, to } = this.dates(r);
    const rows = await this.prisma.transaction.findMany({
      where: { organisationId: orgId, status: 'FAILED', occurredAt: { gte: from, lte: to } }, orderBy: { occurredAt: 'desc' }, take: CSV_LIMIT,
      include: { connection: { select: { provider: { select: { key: true } } } }, exceptions: { where: { type: 'FAILED_PAYMENT' }, select: { status: true, resolution: true } } },
    });
    return {
      columns: ['occurredAt', 'provider', 'paymentRef', 'reference', 'customerId', 'amount', 'currency', 'exceptionStatus', 'resolution'],
      rows: rows.map((t) => ({ occurredAt: t.occurredAt, provider: t.connection.provider.key, paymentRef: t.providerRef, reference: t.reference, customerId: t.customerId, amount: money(t.amount), currency: t.currency, exceptionStatus: t.exceptions[0]?.status ?? '', resolution: t.exceptions[0]?.resolution ?? '' })),
      summary: { from, to, count: rows.length },
    };
  }

  async outstandingInvoices(orgId: string): Promise<Report> {
    const now = Date.now();
    const invoices = await this.prisma.invoice.findMany({ where: { organisationId: orgId, status: { in: ['OPEN', 'PARTIALLY_PAID'] } }, orderBy: { dueAt: 'asc' }, take: CSV_LIMIT });
    const aging = (d: number) => (d <= 0 ? 'current' : d <= 30 ? '1-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : '90+');
    const totals = new Map<string, Prisma.Decimal>();
    const rows = invoices.map((i) => {
      const out = i.amount.minus(i.amountPaid);
      const days = Math.floor((now - i.dueAt.getTime()) / DAY);
      totals.set(i.currency, (totals.get(i.currency) ?? new Prisma.Decimal(0)).plus(out));
      return { reference: i.reference, customerId: i.customerId, customerName: i.customerName, status: i.status, amount: money(i.amount), paid: money(i.amountPaid), outstanding: money(out), currency: i.currency, dueAt: i.dueAt, daysOverdue: Math.max(days, 0), aging: aging(days) };
    });
    return {
      columns: ['reference', 'customerId', 'customerName', 'status', 'amount', 'paid', 'outstanding', 'currency', 'dueAt', 'daysOverdue', 'aging'],
      rows,
      summary: { count: rows.length, outstandingByCurrency: [...totals].map(([currency, amount]) => ({ currency, amount: money(amount) })) },
    };
  }

  async providerPerformance(orgId: string, r: Range): Promise<Report> {
    const { from, to } = this.dates(r);
    const [txns, hooks] = await Promise.all([
      this.prisma.$queryRaw<{ provider: string; total: number; succeeded: number; failed: number; pending: number; refunded: number; volume: string }[]>`
        SELECT p.key AS provider, COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE t.status = 'SUCCEEDED')::int AS succeeded,
          COUNT(*) FILTER (WHERE t.status = 'FAILED')::int AS failed,
          COUNT(*) FILTER (WHERE t.status IN ('PENDING', 'CREATED'))::int AS pending,
          COUNT(*) FILTER (WHERE t.status = 'REFUNDED')::int AS refunded,
          COALESCE(SUM(t.amount) FILTER (WHERE t.status = 'SUCCEEDED'), 0)::text AS volume
        FROM "Transaction" t JOIN "ProviderConnection" c ON c.id = t."connectionId" JOIN "PaymentProvider" p ON p.id = c."providerId"
        WHERE t."organisationId" = ${orgId} AND t."occurredAt" >= ${from} AND t."occurredAt" <= ${to} GROUP BY p.key ORDER BY p.key`,
      this.prisma.$queryRaw<{ provider: string; events: number; failed: number; duplicates: number; avg_latency_s: number | null }[]>`
        SELECT p.key AS provider, COUNT(*)::int AS events,
          COUNT(*) FILTER (WHERE w.status IN ('FAILED', 'DEAD_LETTER'))::int AS failed,
          COALESCE(SUM(w."duplicateCount"), 0)::int AS duplicates,
          AVG(EXTRACT(EPOCH FROM (w."processedAt" - w."receivedAt")))::float8 AS avg_latency_s
        FROM "WebhookEvent" w JOIN "ProviderConnection" c ON c.id = w."connectionId" JOIN "PaymentProvider" p ON p.id = c."providerId"
        WHERE w."organisationId" = ${orgId} AND w."receivedAt" >= ${from} AND w."receivedAt" <= ${to} GROUP BY p.key`,
    ]);
    const h = new Map(hooks.map((x) => [x.provider, x]));
    const pct = (a: number, b: number) => (b === 0 ? null : Number(((a / b) * 100).toFixed(1)));
    return {
      columns: ['provider', 'payments', 'succeeded', 'failed', 'pending', 'refunded', 'successRatePct', 'failureRatePct', 'succeededVolume', 'webhookEvents', 'webhookFailures', 'duplicateDeliveries', 'avgWebhookLatencySec'],
      rows: txns.map((t) => ({
        provider: t.provider, payments: t.total, succeeded: t.succeeded, failed: t.failed, pending: t.pending, refunded: t.refunded,
        successRatePct: pct(t.succeeded, t.total), failureRatePct: pct(t.failed, t.total), succeededVolume: new Prisma.Decimal(t.volume).toFixed(2),
        webhookEvents: h.get(t.provider)?.events ?? 0, webhookFailures: h.get(t.provider)?.failed ?? 0, duplicateDeliveries: h.get(t.provider)?.duplicates ?? 0,
        avgWebhookLatencySec: h.get(t.provider)?.avg_latency_s != null ? Number(h.get(t.provider)!.avg_latency_s!.toFixed(3)) : null,
      })),
      summary: { from, to },
    };
  }
}
