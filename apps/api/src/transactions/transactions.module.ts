import {
  BadGatewayException, Body, Controller, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma, Role, TransactionStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { AuditService } from '../audit-logs/audit-logs.module';
import { CurrentUser, MinRole, Org } from '../common/decorators';
import { decrypt } from '../common/crypto.util';
import { MONEY_REGEX } from '../common/money';
import { PageQueryDto, paged, skipTake } from '../common/pagination';
import { PrismaService } from '../common/prisma.service';
import { ConfigService } from '@nestjs/config';
import { ExceptionsModule } from '../exceptions/exceptions.module';
import { PaymentProvidersModule } from '../providers/providers.module';
import { PaymentProviderService } from '../providers/payment-provider.service';
import { ProviderUnavailableError } from '../providers/provider.types';
import { TransactionIngestService } from './transaction-ingest.service';

export class ListTransactionsQuery extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Date) @IsDate() from?: Date;
  @ApiPropertyOptional() @IsOptional() @Type(() => Date) @IsDate() to?: Date;
  @ApiPropertyOptional({ description: 'Provider key, e.g. "mock"' }) @IsOptional() @IsString() @MaxLength(50) provider?: string;
  @ApiPropertyOptional({ enum: TransactionStatus }) @IsOptional() @IsEnum(TransactionStatus) status?: TransactionStatus;
  @ApiPropertyOptional() @IsOptional() @Matches(MONEY_REGEX) minAmount?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(MONEY_REGEX) maxAmount?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^[A-Z]{3}$/) currency?: string;
  @ApiPropertyOptional({ description: 'Matches provider ref or reference (case-insensitive)' })
  @IsOptional() @IsString() @MaxLength(100) search?: string;
}

export class ImportTransactionsDto {
  @ApiProperty() @IsUUID() connectionId: string;
}

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: PaymentProviderService,
    private readonly ingest: TransactionIngestService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  where(orgId: string, q: Partial<ListTransactionsQuery>): Prisma.TransactionWhereInput {
    return {
      organisationId: orgId,
      ...(q.status && { status: q.status }),
      ...(q.currency && { currency: q.currency }),
      ...(q.provider && { connection: { provider: { key: q.provider } } }),
      ...((q.from || q.to) && { occurredAt: { ...(q.from && { gte: q.from }), ...(q.to && { lte: q.to }) } }),
      ...((q.minAmount || q.maxAmount) && {
        amount: { ...(q.minAmount && { gte: new Prisma.Decimal(q.minAmount) }), ...(q.maxAmount && { lte: new Prisma.Decimal(q.maxAmount) }) },
      }),
      ...(q.search && {
        OR: [
          { providerRef: { contains: q.search, mode: 'insensitive' } },
          { reference: { contains: q.search, mode: 'insensitive' } },
        ],
      }),
    };
  }

  async list(orgId: string, q: ListTransactionsQuery) {
    const where = this.where(orgId, q);
    const [rows, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where, orderBy: { occurredAt: 'desc' }, ...skipTake(q),
        include: { connection: { select: { id: true, label: true, provider: { select: { key: true, name: true } } } } },
      }),
      this.prisma.transaction.count({ where }),
    ]);
    return paged(rows, total, q);
  }

  async get(orgId: string, id: string) {
    const t = await this.prisma.transaction.findFirst({
      where: { id, organisationId: orgId },
      include: {
        connection: { select: { id: true, label: true, provider: { select: { key: true, name: true } } } },
        history: { orderBy: { occurredAt: 'asc' } },
        invoicePayments: { include: { invoice: { select: { id: true, reference: true, amount: true, currency: true, status: true } } } },
        matches: { include: { invoice: { select: { id: true, reference: true, amount: true, currency: true } } }, orderBy: { score: 'desc' } },
        exceptions: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!t) throw new NotFoundException('Transaction not found');
    return t;
  }

  async history(orgId: string, id: string) {
    const t = await this.prisma.transaction.findFirst({ where: { id, organisationId: orgId }, select: { id: true } });
    if (!t) throw new NotFoundException('Transaction not found');
    return this.prisma.transactionStatusHistory.findMany({ where: { transactionId: id }, orderBy: { occurredAt: 'asc' } });
  }

  /** Incremental sync: resumes from the connection's cursor, applies every record through the idempotent ingest path. */
  async sync(orgId: string, actorId: string, connectionId: string) {
    const conn = await this.prisma.providerConnection.findFirst({
      where: { id: connectionId, organisationId: orgId, isActive: true },
      include: { provider: true },
    });
    if (!conn) throw new NotFoundException('Connection not found');
    const adapter = this.providers.get(conn.provider.key);
    const creds = JSON.parse(decrypt(conn.encryptedCredentials, this.config.getOrThrow('ENCRYPTION_KEY')));

    const stats = { pages: 0, fetched: 0, created: 0, updated: 0, unchanged: 0, rejected: 0 };
    let cursor = conn.syncCursor;
    try {
      for (;;) {
        const page = await this.providers.withRetry(() => adapter.listPayments(creds, cursor, 100));
        stats.pages++;
        for (const { sequence, payment } of page.payments) {
          stats.fetched++;
          const r = await this.ingest.applyEvent(orgId, conn.id, {
            providerEventId: `import:${payment.providerRef}:${sequence}`, type: 'import', sequence, occurredAt: payment.occurredAt, payment,
          });
          if (r.outcome === 'created') stats.created++;
          else if (r.outcome === 'updated') stats.updated++;
          else if (r.outcome === 'invalid_transition') stats.rejected++;
          else stats.unchanged++;
        }
        cursor = page.nextCursor;
        await this.prisma.providerConnection.update({ where: { id: conn.id }, data: { syncCursor: cursor } }); // progress survives a mid-run failure
        if (!page.hasMore) break;
      }
    } catch (e) {
      // Store a short message only — provider errors can echo request details, so never persist raw error objects.
      const msg = e instanceof ProviderUnavailableError ? e.message : 'Unexpected error during sync';
      await this.prisma.providerConnection.update({ where: { id: conn.id }, data: { lastSyncError: msg.slice(0, 300) } });
      await this.audit.log({ organisationId: orgId, actorId, action: 'transactions.import_failed', entityType: 'ProviderConnection', entityId: conn.id, metadata: { error: msg } });
      throw new BadGatewayException(`Provider sync failed: ${msg}`);
    }
    await this.prisma.providerConnection.update({ where: { id: conn.id }, data: { lastSyncAt: new Date(), lastSyncError: null } });
    await this.audit.log({ organisationId: orgId, actorId, action: 'transactions.import', entityType: 'ProviderConnection', entityId: conn.id, metadata: stats });
    return stats;
  }
}

@ApiTags('transactions')
@ApiBearerAuth()
@Controller('transactions')
class TransactionsController {
  constructor(private readonly svc: TransactionsService) {}

  @Get() @MinRole(Role.ANALYST)
  list(@Org() org: { id: string }, @Query() q: ListTransactionsQuery) { return this.svc.list(org.id, q); }

  @Post('import') @HttpCode(200) @MinRole(Role.MANAGER)
  import(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Body() dto: ImportTransactionsDto) {
    return this.svc.sync(org.id, u.id, dto.connectionId);
  }

  @Get(':id') @MinRole(Role.ANALYST)
  get(@Org() org: { id: string }, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(org.id, id); }

  @Get(':id/history') @MinRole(Role.ANALYST)
  history(@Org() org: { id: string }, @Param('id', ParseUUIDPipe) id: string) { return this.svc.history(org.id, id); }
}

@Module({
  imports: [PaymentProvidersModule, ExceptionsModule],
  controllers: [TransactionsController],
  providers: [TransactionsService, TransactionIngestService],
  exports: [TransactionsService, TransactionIngestService],
})
export class TransactionsModule {}
