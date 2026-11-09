import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { MatchStatus, MatchType, Prisma } from '@prisma/client';
import { AuditService } from '../audit-logs/audit-logs.module';
import { PrismaService } from '../common/prisma.service';
import { ExceptionsService } from '../exceptions/exceptions.module';
import { findDuplicateGroups, InvoiceLike, outstanding, rankCandidates, TxnLike } from './matching';
import { resolveConfig } from './matching.config';

const Dec = Prisma.Decimal;
type Tx = Prisma.TransactionClient;
const minDec = (a: Prisma.Decimal, b: Prisma.Decimal) => (a.lt(b) ? a : b);

export interface Allocation {
  transactionId: string;
  invoiceId: string;
  amount: Prisma.Decimal;
  matchId?: string;
  /** An invoice whose remaining balance is within this amount after the allocation counts as settled. */
  tolerance?: Prisma.Decimal;
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly exceptions: ExceptionsService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────── Allocation (the only place money is applied to invoices) ─────────────────────────

  /**
   * Apply (part of) a payment to an invoice. Locks the transaction row, then the invoice row
   * (always in that order → no deadlocks), re-validates under the lock, and updates the invoice
   * balance with exact decimal arithmetic. Everything commits or nothing does.
   */
  async allocate(tx: Tx, orgId: string, a: Allocation) {
    const t = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Transaction" WHERE id = ${a.transactionId} AND "organisationId" = ${orgId} FOR UPDATE`;
    if (!t.length) throw new NotFoundException('Transaction not found');
    const i = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Invoice" WHERE id = ${a.invoiceId} AND "organisationId" = ${orgId} FOR UPDATE`;
    if (!i.length) throw new NotFoundException('Invoice not found');

    const [txn, inv, allocated] = await Promise.all([
      tx.transaction.findUniqueOrThrow({ where: { id: a.transactionId } }),
      tx.invoice.findUniqueOrThrow({ where: { id: a.invoiceId } }),
      tx.invoicePayment.aggregate({ where: { transactionId: a.transactionId }, _sum: { amount: true } }),
    ]);
    if (txn.status !== 'SUCCEEDED') throw new BadRequestException('Only succeeded payments can be applied to invoices');
    if (inv.status === 'VOID') throw new BadRequestException('Invoice is void');
    if (txn.currency !== inv.currency) throw new BadRequestException(`Currency mismatch (${txn.currency} vs ${inv.currency}); currency conversion is not supported`);
    if (a.amount.lte(0)) throw new BadRequestException('Amount must be positive');

    const remaining = txn.amount.minus(allocated._sum.amount ?? 0);
    if (a.amount.gt(remaining)) throw new ConflictException(`Only ${remaining.toFixed(2)} of this payment is still unallocated`);
    const due = outstanding(inv);
    if (a.amount.gt(due)) throw new ConflictException(`Invoice only has ${due.toFixed(2)} outstanding`);

    await tx.invoicePayment.create({
      data: { organisationId: orgId, invoiceId: inv.id, transactionId: txn.id, amount: a.amount, currency: inv.currency, matchId: a.matchId },
    });
    const paid = inv.amountPaid.plus(a.amount);
    const updated = await tx.invoice.update({
      where: { id: inv.id },
      data: { amountPaid: paid, status: paid.gte(inv.amount.minus(a.tolerance ?? 0)) ? 'PAID' : 'PARTIALLY_PAID' },
    });
    // The problems this payment/invoice caused are now solved — close them so the queue stays honest.
    const keys = [`unmatched:${txn.id}`, `unmatchedinv:${inv.id}`, ...(updated.status === 'PAID' ? [`missing:${inv.id}`] : [])];
    await tx.paymentException.updateMany({
      where: { organisationId: orgId, dedupeKey: { in: keys }, status: { in: ['OPEN', 'INVESTIGATING'] } },
      data: { status: 'RESOLVED', resolution: 'Resolved automatically by a confirmed match', resolvedAt: new Date() },
    });
    return updated;
  }

  // ───────────────────────── Review actions ─────────────────────────

  private async loadMatch(tx: Tx, orgId: string, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "ReconciliationMatch" WHERE id = ${id} AND "organisationId" = ${orgId} FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Match not found');
    return tx.reconciliationMatch.findUniqueOrThrow({ where: { id } });
  }

  async confirm(orgId: string, actorId: string, id: string, note?: string) {
    return this.prisma.$transaction(async (tx) => {
      const m = await this.loadMatch(tx, orgId, id);
      if (m.status !== 'SUGGESTED') throw new ConflictException(`Match is already ${m.status.toLowerCase()}`);
      await this.allocate(tx, orgId, { transactionId: m.transactionId, invoiceId: m.invoiceId, amount: m.matchedAmount, matchId: m.id });
      const updated = await tx.reconciliationMatch.update({ where: { id }, data: { status: 'CONFIRMED', reviewedById: actorId, reviewedAt: new Date(), note } });
      await this.audit.log({ organisationId: orgId, actorId, action: 'reconciliation.confirm', entityType: 'ReconciliationMatch', entityId: id, metadata: { amount: m.matchedAmount.toString() } }, tx);
      return updated;
    });
  }

  async reject(orgId: string, actorId: string, id: string, note?: string) {
    return this.prisma.$transaction(async (tx) => {
      const m = await this.loadMatch(tx, orgId, id);
      if (m.status !== 'SUGGESTED') throw new ConflictException(`Match is already ${m.status.toLowerCase()}`);
      const updated = await tx.reconciliationMatch.update({ where: { id }, data: { status: 'REJECTED', reviewedById: actorId, reviewedAt: new Date(), note } });
      await this.audit.log({ organisationId: orgId, actorId, action: 'reconciliation.reject', entityType: 'ReconciliationMatch', entityId: id }, tx);
      return updated;
    });
  }

  /** Correction: undo a confirmed match, restoring the invoice balance. The pair is not re-suggested afterwards. */
  async reverse(orgId: string, actorId: string, id: string, note?: string) {
    return this.prisma.$transaction(async (tx) => {
      const m = await this.loadMatch(tx, orgId, id);
      if (m.status !== 'CONFIRMED') throw new ConflictException('Only confirmed matches can be reversed');
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${m.invoiceId} FOR UPDATE`;
      const payment = await tx.invoicePayment.findUnique({ where: { matchId: id } });
      if (!payment) throw new ConflictException('Match has no linked payment to reverse');
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: m.invoiceId } });
      const paid = inv.amountPaid.minus(payment.amount);
      await tx.invoicePayment.delete({ where: { id: payment.id } });
      await tx.invoice.update({ where: { id: inv.id }, data: { amountPaid: paid, status: paid.lte(0) ? 'OPEN' : 'PARTIALLY_PAID' } });
      const updated = await tx.reconciliationMatch.update({ where: { id }, data: { status: 'REJECTED', reviewedById: actorId, reviewedAt: new Date(), note: note ?? 'Reversed' } });
      await this.audit.log({ organisationId: orgId, actorId, action: 'reconciliation.reverse', entityType: 'ReconciliationMatch', entityId: id, metadata: { amount: payment.amount.toString() } }, tx);
      return updated;
    });
  }

  /** Finance user links a payment to an invoice themselves (also used to correct a wrong auto/suggested match). */
  async manual(orgId: string, actorId: string, d: { transactionId: string; invoiceId: string; amount?: string; note?: string }) {
    return this.prisma.$transaction(async (tx) => {
      const [txn, inv] = await Promise.all([
        tx.transaction.findFirst({ where: { id: d.transactionId, organisationId: orgId } }),
        tx.invoice.findFirst({ where: { id: d.invoiceId, organisationId: orgId } }),
      ]);
      if (!txn || !inv) throw new NotFoundException('Transaction or invoice not found');
      const allocated = await tx.invoicePayment.aggregate({ where: { transactionId: txn.id }, _sum: { amount: true } });
      const amount = d.amount ? new Dec(d.amount) : minDec(txn.amount.minus(allocated._sum.amount ?? 0), outstanding(inv));

      const existing = await tx.reconciliationMatch.findUnique({ where: { transactionId_invoiceId: { transactionId: txn.id, invoiceId: inv.id } } });
      if (existing?.status === 'CONFIRMED') throw new ConflictException('This payment is already matched to this invoice');
      const data = { type: MatchType.MANUAL, status: MatchStatus.CONFIRMED, matchedAmount: amount, reviewedById: actorId, reviewedAt: new Date(), note: d.note, reasons: [{ criterion: 'manual', matched: true, detail: 'Matched by a finance user' }] as Prisma.InputJsonValue };
      const match = existing
        ? await tx.reconciliationMatch.update({ where: { id: existing.id }, data })
        : await tx.reconciliationMatch.create({ data: { ...data, organisationId: orgId, transactionId: txn.id, invoiceId: inv.id, score: 100 } });
      await this.allocate(tx, orgId, { transactionId: txn.id, invoiceId: inv.id, amount, matchId: match.id });
      await this.audit.log({ organisationId: orgId, actorId, action: 'reconciliation.manual_match', entityType: 'ReconciliationMatch', entityId: match.id, metadata: { amount: amount.toString(), note: d.note } }, tx);
      return match;
    });
  }

  // ───────────────────────── The run ─────────────────────────

  async run(orgId: string, actorId: string | null) {
    const org = await this.prisma.organisation.findUniqueOrThrow({ where: { id: orgId } });
    const cfg = resolveConfig(org.reconciliationConfig);
    // A crashed worker must not block the organisation forever.
    await this.prisma.reconciliationRun.updateMany({
      where: { organisationId: orgId, status: 'RUNNING', startedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
      data: { status: 'FAILED', error: 'Timed out', finishedAt: new Date() },
    });
    let run;
    try {
      run = await this.prisma.reconciliationRun.create({ data: { organisationId: orgId, triggeredById: actorId, configSnapshot: cfg as unknown as Prisma.InputJsonValue } });
    } catch (e) {
      // Partial unique index: one RUNNING run per organisation.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('A reconciliation run is already in progress');
      throw e;
    }
    const stats = { transactionsScanned: 0, invoicesScanned: 0, exactMatches: 0, suggestedMatches: 0, exceptionsRaised: 0 };
    try {
      await this.execute(orgId, run.id, cfg, stats);
      const done = await this.prisma.reconciliationRun.update({ where: { id: run.id }, data: { ...stats, status: 'COMPLETED', finishedAt: new Date() } });
      await this.audit.log({ organisationId: orgId, actorId, action: 'reconciliation.run', entityType: 'ReconciliationRun', entityId: run.id, metadata: stats });
      return done;
    } catch (e) {
      this.logger.error(`Reconciliation run ${run.id} failed: ${(e as Error).message}`);
      await this.prisma.reconciliationRun.update({ where: { id: run.id }, data: { ...stats, status: 'FAILED', error: (e as Error).message.slice(0, 500), finishedAt: new Date() } });
      throw e;
    }
  }

  private async execute(orgId: string, runId: string, cfg: ReturnType<typeof resolveConfig>, stats: Record<string, number>) {
    const raise = async (...args: Parameters<ExceptionsService['raise']> extends [string, ...infer R] ? R : never) => {
      if (await this.exceptions.raise(orgId, ...args)) stats.exceptionsRaised++;
    };
    const now = Date.now();

    const succeeded = await this.prisma.transaction.findMany({ where: { organisationId: orgId, status: 'SUCCEEDED' }, orderBy: { occurredAt: 'asc' } });
    const allocs = await this.prisma.invoicePayment.groupBy({ by: ['transactionId'], where: { organisationId: orgId }, _sum: { amount: true } });
    const allocated = new Map(allocs.map((a) => [a.transactionId, a._sum.amount ?? new Dec(0)]));

    // 1) Duplicates first — a duplicate must never be matched (it would double-pay an invoice).
    const dupIds = new Set<string>();
    for (const group of findDuplicateGroups(succeeded)) {
      const [original, ...copies] = group;
      for (const c of copies) {
        dupIds.add(c.id);
        await raise({ type: 'DUPLICATE_TRANSACTION', dedupeKey: `dup:${c.id}`, transactionId: c.id, summary: `Possible duplicate of ${original.providerRef} (same customer, amount and reference)`, details: { duplicateOf: original.id } });
      }
    }

    // 2) Match every unallocated, non-duplicate payment.
    let invoices = await this.prisma.invoice.findMany({ where: { organisationId: orgId, status: { in: ['OPEN', 'PARTIALLY_PAID'] } } });
    stats.invoicesScanned = invoices.length;
    for (const t of succeeded) {
      if (dupIds.has(t.id)) continue;
      const remainder = t.amount.minus(allocated.get(t.id) ?? 0);
      if (remainder.lte(0)) continue;
      // A leftover within tolerance after an earlier allocation is rounding, not an unmatched payment.
      if (allocated.has(t.id) && remainder.lte(cfg.amountTolerance)) continue;
      stats.transactionsScanned++;
      const txn: TxnLike = { id: t.id, providerRef: t.providerRef, reference: t.reference, customerId: t.customerId, amount: remainder, currency: t.currency, occurredAt: t.occurredAt };
      const open: InvoiceLike[] = invoices.filter((i) => outstanding(i).gt(0));
      const ranked = rankCandidates(txn, open, cfg);

      if (!ranked.length) {
        await raise({ type: 'UNMATCHED_TRANSACTION', dedupeKey: `unmatched:${t.id}`, transactionId: t.id, summary: `No invoice found for payment ${t.providerRef}${t.reference ? ` (ref ${t.reference})` : ''}` });
        continue;
      }
      const top = ranked[0];
      if (top.exact && cfg.autoConfirmExact) {
        // Within tolerance the payment may be slightly above/below the balance: apply only what fits.
        const applied = minDec(remainder, outstanding(open.find((i) => i.id === top.invoiceId)!));
        try {
          const updated = await this.prisma.$transaction(async (tx) => {
            const match = await tx.reconciliationMatch.upsert({
              where: { transactionId_invoiceId: { transactionId: t.id, invoiceId: top.invoiceId } },
              update: {}, // never touch a human's earlier decision
              create: { organisationId: orgId, runId, transactionId: t.id, invoiceId: top.invoiceId, type: 'EXACT', status: 'CONFIRMED', score: top.score, reasons: top.reasons as unknown as Prisma.InputJsonValue, matchedAmount: applied },
            });
            if (match.status !== 'CONFIRMED' || match.runId !== runId) return null; // previously reviewed (e.g. rejected) — leave alone
            return this.allocate(tx, orgId, { transactionId: t.id, invoiceId: top.invoiceId, amount: applied, matchId: match.id, tolerance: new Dec(cfg.amountTolerance) });
          });
          if (updated) {
            stats.exactMatches++;
            invoices = invoices.map((i) => (i.id === updated.id ? updated : i));
          }
        } catch (e) {
          this.logger.warn(`Auto-confirm skipped for ${t.id}: ${(e as Error).message}`);
        }
        continue;
      }

      for (const c of ranked.slice(0, 3)) {
        const inv = open.find((i) => i.id === c.invoiceId)!;
        const existing = await this.prisma.reconciliationMatch.findUnique({ where: { transactionId_invoiceId: { transactionId: t.id, invoiceId: c.invoiceId } } });
        const data = { runId, score: c.score, reasons: c.reasons as unknown as Prisma.InputJsonValue, matchedAmount: minDec(remainder, outstanding(inv)) };
        if (!existing) {
          await this.prisma.reconciliationMatch.create({ data: { ...data, organisationId: orgId, transactionId: t.id, invoiceId: c.invoiceId, type: c.exact ? 'EXACT' : 'PARTIAL', status: 'SUGGESTED' } });
          stats.suggestedMatches++;
        } else if (existing.status === 'SUGGESTED') {
          await this.prisma.reconciliationMatch.update({ where: { id: existing.id }, data });
        } // CONFIRMED / REJECTED are human decisions: never resurrect
      }
      if (top.currencyMismatch) {
        await raise({ type: 'CURRENCY_MISMATCH', dedupeKey: `cur:${t.id}:${top.invoiceId}`, transactionId: t.id, invoiceId: top.invoiceId, summary: `Payment ${t.providerRef} is in ${t.currency} but the invoice is in another currency`, details: { amountDiff: null } });
      } else if (top.partial || top.overpayment) {
        await raise({ type: 'AMOUNT_DISCREPANCY', dedupeKey: `amt:${t.id}:${top.invoiceId}`, transactionId: t.id, invoiceId: top.invoiceId, summary: `${top.overpayment ? 'Overpayment' : 'Underpayment'} of ${top.amountDiff.abs().toFixed(2)} ${t.currency} against outstanding balance`, details: { difference: top.amountDiff.toString() } });
      }
    }

    // 3) Invoice-side problems.
    const open = await this.prisma.invoice.findMany({ where: { organisationId: orgId, status: { in: ['OPEN', 'PARTIALLY_PAID'] } } });
    const [paidCounts, suggestedCounts] = await Promise.all([
      this.prisma.invoicePayment.groupBy({ by: ['invoiceId'], where: { organisationId: orgId }, _count: true }),
      this.prisma.reconciliationMatch.groupBy({ by: ['invoiceId'], where: { organisationId: orgId, status: 'SUGGESTED' }, _count: true }),
    ]);
    const hasPayment = new Set(paidCounts.map((p) => p.invoiceId));
    const hasSuggestion = new Set(suggestedCounts.map((p) => p.invoiceId));
    for (const inv of open) {
      const days = (now - inv.dueAt.getTime()) / 86_400_000;
      if (days <= 0) continue;
      if (!hasPayment.has(inv.id) && !hasSuggestion.has(inv.id)) {
        await raise({ type: 'UNMATCHED_INVOICE', dedupeKey: `unmatchedinv:${inv.id}`, invoiceId: inv.id, summary: `Invoice ${inv.reference} is overdue with no payment or candidate`, details: { daysOverdue: Math.floor(days) } });
      }
      if (days > cfg.missingPaymentGraceDays && hasPayment.has(inv.id) && outstanding(inv).gt(0)) {
        await raise({ type: 'MISSING_PAYMENT', dedupeKey: `missing:${inv.id}`, invoiceId: inv.id, summary: `Invoice ${inv.reference} still has ${outstanding(inv).toFixed(2)} ${inv.currency} outstanding after due date`, details: { outstanding: outstanding(inv).toString(), daysOverdue: Math.floor(days) } });
      }
    }

    // 4) Payments stuck in PENDING.
    const cutoff = new Date(now - cfg.delayedEventHours * 3_600_000);
    const pending = await this.prisma.transaction.findMany({ where: { organisationId: orgId, status: 'PENDING', OR: [{ lastEventAt: { lt: cutoff } }, { lastEventAt: null, occurredAt: { lt: cutoff } }] } });
    for (const p of pending) {
      await raise({ type: 'DELAYED_EVENT', dedupeKey: `delayed:${p.id}`, transactionId: p.id, summary: `Payment ${p.providerRef} has been pending for over ${cfg.delayedEventHours}h` });
    }
  }
}
