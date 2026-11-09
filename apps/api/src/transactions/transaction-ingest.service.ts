import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { ExceptionsService } from '../exceptions/exceptions.module';
import { NormalizedEvent } from '../providers/provider.types';

export type ApplyOutcome = 'created' | 'updated' | 'stale' | 'invalid_transition';
export interface ApplyResult {
  outcome: ApplyOutcome;
  transactionId: string;
  status: TransactionStatus;
}

/**
 * Allowed status moves. Terminal states cannot regress; only a SUCCEEDED payment can be REFUNDED.
 * (A late `payment.pending` after `payment.succeeded` is rejected here even if its sequence is newer.)
 */
const ALLOWED: Record<TransactionStatus, TransactionStatus[]> = {
  CREATED: ['PENDING', 'SUCCEEDED', 'FAILED'],
  PENDING: ['SUCCEEDED', 'FAILED'],
  SUCCEEDED: ['REFUNDED'],
  FAILED: [],
  REFUNDED: [],
};
export const canTransition = (from: TransactionStatus, to: TransactionStatus) => from === to || ALLOWED[from].includes(to);

@Injectable()
export class TransactionIngestService {
  private readonly logger = new Logger(TransactionIngestService.name);

  constructor(private readonly prisma: PrismaService, private readonly exceptions: ExceptionsService) {}

  /**
   * The single write path for payment state — used by both webhooks and imports.
   *
   * Guarantees:
   *  - IDEMPOTENT: (connectionId, providerRef) is unique, so replays never create a second record.
   *  - ORDER-SAFE: an event only applies if its sequence is newer than what we have stored,
   *    so a late `payment.pending` cannot overwrite `payment.succeeded`.
   *  - CONSISTENT: row lock + one DB transaction; the status change and its history entry commit together.
   *  - CONCURRENT-SAFE: two workers racing to create the same payment → one hits the unique
   *    constraint, rolls back, and retries into the update path.
   */
  async applyEvent(orgId: string, connectionId: string, ev: NormalizedEvent, webhookEventId?: string): Promise<ApplyResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction((tx) => this.applyInTx(tx, orgId, connectionId, ev, webhookEventId));
      } catch (e) {
        const uniqueRace = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
        if (uniqueRace && attempt < 2) continue;
        throw e;
      }
    }
  }

  private async applyInTx(
    tx: Prisma.TransactionClient, orgId: string, connectionId: string, ev: NormalizedEvent, webhookEventId?: string,
  ): Promise<ApplyResult> {
    const p = ev.payment;
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Transaction" WHERE "connectionId" = ${connectionId} AND "providerRef" = ${p.providerRef} FOR UPDATE`;
    const existing = locked[0] ? await tx.transaction.findUniqueOrThrow({ where: { id: locked[0].id } }) : null;

    if (!existing) {
      const created = await tx.transaction.create({
        data: {
          organisationId: orgId, connectionId, providerRef: p.providerRef, reference: p.reference, customerId: p.customerId,
          amount: new Prisma.Decimal(p.amount), currency: p.currency, status: p.status,
          lastEventSequence: ev.sequence, lastEventAt: ev.occurredAt, occurredAt: p.occurredAt,
          metadata: p.metadata as Prisma.InputJsonValue,
        },
      });
      await tx.transactionStatusHistory.create({
        data: { transactionId: created.id, fromStatus: null, toStatus: p.status, eventType: ev.type, webhookEventId, occurredAt: ev.occurredAt },
      });
      await this.onStatusEntered(tx, orgId, created.id, p.status, p.reference);
      return { outcome: 'created', transactionId: created.id, status: p.status };
    }

    if (ev.sequence <= existing.lastEventSequence) {
      this.logger.warn(`Ignoring stale event ${ev.providerEventId} (seq ${ev.sequence} <= ${existing.lastEventSequence})`);
      return { outcome: 'stale', transactionId: existing.id, status: existing.status };
    }
    if (!canTransition(existing.status, p.status)) {
      this.logger.warn(`Rejecting ${existing.status} → ${p.status} for ${existing.id} (event ${ev.providerEventId})`);
      return { outcome: 'invalid_transition', transactionId: existing.id, status: existing.status };
    }

    await tx.transaction.update({
      where: { id: existing.id },
      data: { status: p.status, lastEventSequence: ev.sequence, lastEventAt: ev.occurredAt },
    });
    if (existing.status !== p.status) {
      await tx.transactionStatusHistory.create({
        data: { transactionId: existing.id, fromStatus: existing.status, toStatus: p.status, eventType: ev.type, webhookEventId, occurredAt: ev.occurredAt },
      });
      await this.onStatusEntered(tx, orgId, existing.id, p.status, existing.reference);
    }
    return { outcome: 'updated', transactionId: existing.id, status: p.status };
  }

  /** A failed payment is raised as an exception (and notifies finance) inside the same DB transaction. */
  private async onStatusEntered(tx: Prisma.TransactionClient, orgId: string, transactionId: string, status: TransactionStatus, reference: string | null) {
    if (status === 'FAILED') {
      await this.exceptions.raise(orgId, {
        type: 'FAILED_PAYMENT',
        dedupeKey: `failed:${transactionId}`,
        summary: `Payment${reference ? ` for ${reference}` : ''} failed`,
        transactionId,
      }, tx);
    }
  }
}
