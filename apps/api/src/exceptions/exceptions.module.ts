import {
  BadRequestException, Body, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ExceptionStatus, ExceptionType, Prisma, Role } from '@prisma/client';
import { IsEnum, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AuditService } from '../audit-logs/audit-logs.module';
import { CurrentUser, MinRole, Org } from '../common/decorators';
import { PageQueryDto, paged, skipTake } from '../common/pagination';
import { PrismaService } from '../common/prisma.service';
import { NotificationsModule, NotificationsService } from '../notifications/notifications.module';

export interface RaiseInput {
  type: ExceptionType;
  /** Stable per-problem key — re-running reconciliation can never create the same exception twice. */
  dedupeKey: string;
  summary: string;
  transactionId?: string;
  invoiceId?: string;
  details?: Record<string, unknown>;
}

export class ListExceptionsQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: ExceptionType }) @IsOptional() @IsEnum(ExceptionType) type?: ExceptionType;
  @ApiPropertyOptional({ enum: ExceptionStatus }) @IsOptional() @IsEnum(ExceptionStatus) status?: ExceptionStatus;
  @ApiPropertyOptional() @IsOptional() @IsUUID() assigneeId?: string;
}

export class ResolveExceptionDto {
  @ApiProperty({ description: 'How it was resolved — kept for audit' }) @IsString() @IsNotEmpty() @MaxLength(2000) resolution: string;
  @ApiPropertyOptional({ enum: ['RESOLVED', 'DISMISSED'], default: 'RESOLVED' })
  @IsOptional() @IsIn(['RESOLVED', 'DISMISSED']) status?: 'RESOLVED' | 'DISMISSED';
}
export class AssignExceptionDto {
  @ApiProperty({ nullable: true }) @IsOptional() @IsUUID() assigneeId: string | null;
}
export class AddNoteDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(2000) text: string;
}
export class StartInvestigationDto {}

@Injectable()
export class ExceptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Idempotent: returns true only when a NEW exception was created. Never reopens a resolved one. */
  async raise(orgId: string, input: RaiseInput, tx: Prisma.TransactionClient = this.prisma): Promise<boolean> {
    const r = await tx.paymentException.createMany({
      data: [{
        organisationId: orgId, type: input.type, dedupeKey: input.dedupeKey, summary: input.summary,
        transactionId: input.transactionId, invoiceId: input.invoiceId,
        details: (input.details ?? {}) as Prisma.InputJsonValue,
      }],
      skipDuplicates: true,
    });
    if (r.count === 1) {
      await this.notifications.notifyOrg(orgId, {
        kind: input.type === 'FAILED_PAYMENT' ? 'FAILED_PAYMENT' : input.type === 'UNMATCHED_TRANSACTION' ? 'UNMATCHED_PAYMENT' : 'EXCEPTION',
        title: input.type.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()),
        body: input.summary,
        entityType: 'PaymentException',
      }, tx);
    }
    return r.count === 1;
  }

  async list(orgId: string, q: ListExceptionsQuery) {
    const where: Prisma.PaymentExceptionWhereInput = {
      organisationId: orgId,
      ...(q.type && { type: q.type }),
      ...(q.status && { status: q.status }),
      ...(q.assigneeId && { assigneeId: q.assigneeId }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.paymentException.findMany({
        where, orderBy: { createdAt: 'desc' }, ...skipTake(q),
        include: {
          transaction: { select: { id: true, providerRef: true, reference: true, amount: true, currency: true, status: true } },
          invoice: { select: { id: true, reference: true, amount: true, currency: true } },
          assignee: { select: { id: true, name: true, email: true } },
        },
      }),
      this.prisma.paymentException.count({ where }),
    ]);
    return paged(rows, total, q);
  }

  async get(orgId: string, id: string) {
    const ex = await this.prisma.paymentException.findFirst({
      where: { id, organisationId: orgId },
      include: { transaction: { include: { history: { orderBy: { occurredAt: 'asc' } } } }, invoice: true, assignee: { select: { id: true, name: true, email: true } } },
    });
    if (!ex) throw new NotFoundException('Exception not found');
    return ex;
  }

  /** Mutations lock the row so concurrent reviewers cannot both resolve it or lose a note. */
  private async locked<T>(orgId: string, id: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "PaymentException" WHERE id = ${id} AND "organisationId" = ${orgId} FOR UPDATE`;
      if (!rows.length) throw new NotFoundException('Exception not found');
      return fn(tx);
    });
  }

  resolve(orgId: string, actorId: string, id: string, dto: ResolveExceptionDto) {
    return this.locked(orgId, id, async (tx) => {
      const cur = await tx.paymentException.findUniqueOrThrow({ where: { id } });
      if (cur.status === 'RESOLVED' || cur.status === 'DISMISSED') throw new BadRequestException('Exception is already closed');
      const updated = await tx.paymentException.update({
        where: { id },
        data: { status: dto.status ?? 'RESOLVED', resolution: dto.resolution, resolvedById: actorId, resolvedAt: new Date() },
      });
      await this.audit.log({ organisationId: orgId, actorId, action: 'exception.resolve', entityType: 'PaymentException', entityId: id, metadata: { status: updated.status } }, tx);
      return updated;
    });
  }

  assign(orgId: string, actorId: string, id: string, assigneeId: string | null) {
    return this.locked(orgId, id, async (tx) => {
      if (assigneeId) {
        const m = await tx.organisationMembership.findUnique({ where: { userId_organisationId: { userId: assigneeId, organisationId: orgId } } });
        if (!m) throw new BadRequestException('Assignee is not a member of this organisation');
      }
      const cur = await tx.paymentException.findUniqueOrThrow({ where: { id } });
      const updated = await tx.paymentException.update({
        where: { id },
        data: { assigneeId, status: assigneeId && cur.status === 'OPEN' ? 'INVESTIGATING' : cur.status },
      });
      await this.audit.log({ organisationId: orgId, actorId, action: 'exception.assign', entityType: 'PaymentException', entityId: id, metadata: { assigneeId } }, tx);
      return updated;
    });
  }

  startInvestigation(orgId: string, actorId: string, id: string) {
    return this.locked(orgId, id, async (tx) => {
      const cur = await tx.paymentException.findUniqueOrThrow({ where: { id } });
      if (cur.status !== 'OPEN') throw new BadRequestException('Only open exceptions can move to investigating');
      return tx.paymentException.update({ where: { id }, data: { status: 'INVESTIGATING', assigneeId: cur.assigneeId ?? actorId } });
    });
  }

  addNote(orgId: string, actorId: string, id: string, text: string) {
    return this.locked(orgId, id, async (tx) => {
      const cur = await tx.paymentException.findUniqueOrThrow({ where: { id } });
      const notes = [...(cur.notes as unknown[]), { at: new Date().toISOString(), by: actorId, text }];
      return tx.paymentException.update({ where: { id }, data: { notes: notes as Prisma.InputJsonValue } });
    });
  }

  /** Counts by type/status for dashboards and the mobile app. */
  async summary(orgId: string) {
    const rows = await this.prisma.paymentException.groupBy({ by: ['type', 'status'], where: { organisationId: orgId }, _count: true });
    return rows.map((r) => ({ type: r.type, status: r.status, count: r._count }));
  }
}

@ApiTags('exceptions')
@ApiBearerAuth()
@Controller('exceptions')
class ExceptionsController {
  constructor(private readonly svc: ExceptionsService) {}

  @Get() @MinRole(Role.ANALYST)
  list(@Org() org: { id: string }, @Query() q: ListExceptionsQuery) { return this.svc.list(org.id, q); }

  @Get('summary') @MinRole(Role.ANALYST)
  summary(@Org() org: { id: string }) { return this.svc.summary(org.id); }

  @Get(':id') @MinRole(Role.ANALYST)
  get(@Org() org: { id: string }, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(org.id, id); }

  @Patch(':id/resolve') @MinRole(Role.MANAGER)
  resolve(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveExceptionDto) {
    return this.svc.resolve(org.id, u.id, id, dto);
  }

  @Patch(':id/assign') @MinRole(Role.MANAGER)
  assign(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignExceptionDto) {
    return this.svc.assign(org.id, u.id, id, dto.assigneeId ?? null);
  }

  @Patch(':id/investigate') @MinRole(Role.ANALYST)
  investigate(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.startInvestigation(org.id, u.id, id);
  }

  @Post(':id/notes') @MinRole(Role.ANALYST)
  note(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddNoteDto) {
    return this.svc.addNote(org.id, u.id, id, dto.text);
  }
}

@Module({
  imports: [NotificationsModule],
  controllers: [ExceptionsController],
  providers: [ExceptionsService],
  exports: [ExceptionsService],
})
export class ExceptionsModule {}
