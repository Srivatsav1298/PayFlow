import { InjectQueue, Processor, WorkerHost, BullModule } from '@nestjs/bullmq';
import {
  BadRequestException, Controller, Get, HttpCode, Injectable, Logger, Module, NotFoundException, Param, ParseUUIDPipe,
  Post, Query, Req, UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Prisma, Role, WebhookStatus } from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { AuditService } from '../audit-logs/audit-logs.module';
import { AuthedRequest } from '../common/auth.types';
import { decrypt } from '../common/crypto.util';
import { MinRole, Org, Public } from '../common/decorators';
import { PageQueryDto, paged, skipTake } from '../common/pagination';
import { PrismaService } from '../common/prisma.service';
import { NotificationsModule, NotificationsService } from '../notifications/notifications.module';
import { PaymentProviderService } from '../providers/payment-provider.service';
import { PaymentProvidersModule } from '../providers/providers.module';
import { InvalidWebhookPayloadError } from '../providers/provider.types';
import { TransactionsModule } from '../transactions/transactions.module';
import { TransactionIngestService } from '../transactions/transaction-ingest.service';
import { decideRetry } from './retry';

export const WEBHOOK_QUEUE = 'webhooks';

export type ReceiveResult = { status: 'accepted' | 'duplicate'; eventId: string };

export class ListWebhookEventsQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: WebhookStatus }) @IsOptional() @IsEnum(WebhookStatus) status?: WebhookStatus;
}
export class ConnectionQuery {
  @ApiPropertyOptional({ description: 'PayFlow connection id this webhook endpoint belongs to' })
  @IsUUID() connection: string;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: PaymentProviderService,
    private readonly ingest: TransactionIngestService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    @InjectQueue(WEBHOOK_QUEUE) private readonly queue: Queue,
  ) {}

  get maxAttempts() { return Number(this.config.get('WEBHOOK_MAX_ATTEMPTS', 5)); }
  get backoffBaseMs() { return Number(this.config.get('WEBHOOK_BACKOFF_BASE_MS', 1000)); }

  /**
   * Intake: verify → validate → persist (idempotent) → enqueue. Returns fast; processing is asynchronous.
   * Unknown connection and bad signature are indistinguishable (both 401) to avoid endpoint enumeration.
   */
  async receive(providerKey: string, connectionId: string, rawBody: string, headers: Record<string, string | string[] | undefined>, ip?: string): Promise<ReceiveResult> {
    const adapter = this.providers.get(providerKey);
    const conn = await this.prisma.providerConnection.findFirst({
      where: { id: connectionId, isActive: true, provider: { key: providerKey } },
    });
    if (!conn) throw new UnauthorizedException('Invalid webhook signature');

    const secret = decrypt(conn.encryptedWebhookSecret, this.config.getOrThrow('ENCRYPTION_KEY'));
    // Never trust (or even parse) the payload before the signature is verified over the exact raw bytes.
    if (!adapter.verifyWebhook(rawBody, headers, secret)) {
      await this.audit.log({ organisationId: conn.organisationId, action: 'webhook.signature_invalid', entityType: 'ProviderConnection', entityId: conn.id, ip });
      throw new UnauthorizedException('Invalid webhook signature');
    }

    let ev;
    try {
      ev = adapter.parseWebhook(rawBody);
    } catch (e) {
      if (e instanceof InvalidWebhookPayloadError) throw new BadRequestException(e.message);
      throw e;
    }

    let record;
    try {
      record = await this.prisma.webhookEvent.create({
        data: {
          organisationId: conn.organisationId, connectionId: conn.id, providerEventId: ev.providerEventId,
          type: ev.type, sequence: ev.sequence, payload: JSON.parse(rawBody) as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        // Provider redelivered an event we already have: acknowledge (so it stops retrying) but do nothing.
        const existing = await this.prisma.webhookEvent.update({
          where: { connectionId_providerEventId: { connectionId: conn.id, providerEventId: ev.providerEventId } },
          data: { duplicateCount: { increment: 1 } },
        });
        return { status: 'duplicate', eventId: existing.id };
      }
      throw e;
    }
    await this.enqueue(record.id);
    return { status: 'accepted', eventId: record.id };
  }

  async enqueue(eventId: string) {
    try {
      await this.queue.add('process', { eventId }, {
        attempts: this.maxAttempts,
        backoff: { type: 'exponential', delay: this.backoffBaseMs },
        removeOnComplete: true,
        removeOnFail: true,
      });
    } catch (e) {
      // The event is safely persisted as RECEIVED; an operator can retry it from the events list.
      this.logger.error(`Failed to enqueue webhook event ${eventId}: ${(e as Error).message}`);
    }
  }

  /**
   * Worker entry point. Safe to call repeatedly: the status claim below means a redelivered job, a double
   * enqueue or a manual retry can never apply the same event twice. Throws on retryable failure so BullMQ backs off.
   */
  async process(eventId: string): Promise<'processed' | 'ignored' | 'skipped' | 'dead_letter'> {
    const claimed = await this.prisma.webhookEvent.updateMany({
      where: { id: eventId, status: { in: ['RECEIVED', 'FAILED'] } },
      data: { status: 'PROCESSING', attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return 'skipped';

    const ev = await this.prisma.webhookEvent.findUniqueOrThrow({ where: { id: eventId }, include: { connection: { include: { provider: true } } } });
    try {
      const adapter = this.providers.get(ev.connection.provider.key);
      const normalised = adapter.parseWebhook(JSON.stringify(ev.payload));
      const result = await this.ingest.applyEvent(ev.organisationId, ev.connectionId, normalised, ev.id);
      const ignored = result.outcome === 'stale' || result.outcome === 'invalid_transition';
      await this.prisma.webhookEvent.update({
        where: { id: ev.id },
        data: { status: ignored ? 'IGNORED' : 'PROCESSED', processedAt: new Date(), lastError: ignored ? `Not applied: ${result.outcome}` : null, nextRetryAt: null },
      });
      return ignored ? 'ignored' : 'processed';
    } catch (e) {
      const message = (e instanceof Error ? e.message : 'Unknown error').slice(0, 500);
      const decision = decideRetry(ev.attempts, this.maxAttempts, this.backoffBaseMs);
      await this.prisma.webhookEvent.update({
        where: { id: ev.id },
        data: {
          status: decision.deadLetter ? 'DEAD_LETTER' : 'FAILED',
          lastError: message,
          nextRetryAt: decision.deadLetter ? null : new Date(Date.now() + decision.delayMs),
        },
      });
      if (decision.deadLetter) {
        this.logger.error(`Webhook event ${ev.id} moved to dead-letter after ${ev.attempts} attempts`);
        await this.notifications.notifyOrg(ev.organisationId, {
          kind: 'WEBHOOK_DEAD_LETTER', title: 'Webhook event failed permanently',
          body: `Event ${ev.providerEventId} (${ev.type}) failed ${ev.attempts} times: ${message}`,
          entityType: 'WebhookEvent', entityId: ev.id,
        });
        return 'dead_letter';
      }
      throw e; // let BullMQ schedule the exponential-backoff retry
    }
  }

  async list(orgId: string, q: ListWebhookEventsQuery) {
    const where: Prisma.WebhookEventWhereInput = { organisationId: orgId, ...(q.status && { status: q.status }) };
    const [rows, total] = await Promise.all([
      this.prisma.webhookEvent.findMany({
        where, orderBy: { receivedAt: 'desc' }, ...skipTake(q),
        select: { id: true, providerEventId: true, type: true, sequence: true, status: true, attempts: true, lastError: true, receivedAt: true, processedAt: true, nextRetryAt: true, duplicateCount: true, connectionId: true },
      }),
      this.prisma.webhookEvent.count({ where }),
    ]);
    return paged(rows.map((r) => ({ ...r, sequence: r.sequence.toString() })), total, q);
  }

  /** Manual replay of FAILED / DEAD_LETTER (or stuck) events — safe because of the processing claim + idempotent ingest. */
  async retry(orgId: string, actorId: string, id: string) {
    const ev = await this.prisma.webhookEvent.findFirst({ where: { id, organisationId: orgId } });
    if (!ev) throw new NotFoundException('Webhook event not found');
    if (ev.status === 'PROCESSED') throw new BadRequestException('Event was already processed');
    await this.prisma.webhookEvent.update({ where: { id }, data: { status: 'RECEIVED', attempts: 0, lastError: null, nextRetryAt: null } });
    await this.audit.log({ organisationId: orgId, actorId, action: 'webhook.retry', entityType: 'WebhookEvent', entityId: id });
    await this.enqueue(id);
    return { queued: true };
  }
}

@Processor(WEBHOOK_QUEUE)
class WebhookProcessor extends WorkerHost {
  constructor(private readonly svc: WebhooksService) { super(); }
  async process(job: Job<{ eventId: string }>) {
    return this.svc.process(job.data.eventId);
  }
}

@ApiTags('webhooks')
@Controller('webhooks')
class WebhooksController {
  constructor(private readonly svc: WebhooksService) {}

  /** Public by design — authenticity comes from the provider signature, not a bearer token. */
  @Public() @Throttle({ default: { limit: 600, ttl: 60_000 } }) @HttpCode(202) @Post(':provider')
  receive(@Param('provider') provider: string, @Query() q: ConnectionQuery, @Req() req: AuthedRequest) {
    if (!req.rawBody) throw new BadRequestException('Empty body');
    return this.svc.receive(provider, q.connection, req.rawBody.toString('utf8'), req.headers, req.ip);
  }

  @ApiBearerAuth() @Get('events/history') @MinRole(Role.MANAGER)
  list(@Org() org: { id: string }, @Query() q: ListWebhookEventsQuery) { return this.svc.list(org.id, q); }

  @ApiBearerAuth() @HttpCode(202) @Post('events/:id/retry') @MinRole(Role.MANAGER)
  retry(@Org() org: { id: string }, @Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.retry(org.id, req.user!.id, id);
  }
}

@Module({
  imports: [
    BullModule.registerQueue({ name: WEBHOOK_QUEUE }),
    PaymentProvidersModule, TransactionsModule, NotificationsModule,
  ],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookProcessor],
  exports: [WebhooksService],
})
export class WebhooksModule {}
