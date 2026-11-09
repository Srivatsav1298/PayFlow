import { Body, Controller, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { MatchStatus, MatchType, Prisma, Role } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CurrentUser, MinRole, Org } from '../common/decorators';
import { IsMoney } from '../common/money';
import { PageQueryDto, paged, skipTake } from '../common/pagination';
import { PrismaService } from '../common/prisma.service';
import { ExceptionsModule } from '../exceptions/exceptions.module';
import { ReconciliationService } from './reconciliation.service';

export class ManualMatchDto {
  @ApiProperty() @IsUUID() transactionId: string;
  @ApiProperty() @IsUUID() invoiceId: string;
  @ApiPropertyOptional({ description: 'Defaults to the largest amount that fits both the payment and the invoice' })
  @IsOptional() @IsMoney() amount?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
export class ReviewDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
export class ResultsQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: MatchStatus }) @IsOptional() @IsEnum(MatchStatus) status?: MatchStatus;
  @ApiPropertyOptional({ enum: MatchType }) @IsOptional() @IsEnum(MatchType) type?: MatchType;
  @ApiPropertyOptional() @IsOptional() @IsUUID() runId?: string;
}

@Injectable()
class ReconciliationQueries {
  constructor(private readonly prisma: PrismaService) {}

  async runs(orgId: string, q: PageQueryDto) {
    const where = { organisationId: orgId };
    const [rows, total] = await Promise.all([
      this.prisma.reconciliationRun.findMany({ where, orderBy: { startedAt: 'desc' }, ...skipTake(q) }),
      this.prisma.reconciliationRun.count({ where }),
    ]);
    return paged(rows, total, q);
  }

  async run(orgId: string, id: string) {
    const r = await this.prisma.reconciliationRun.findFirst({ where: { id, organisationId: orgId } });
    if (!r) throw new NotFoundException('Run not found');
    return r;
  }

  async results(orgId: string, q: ResultsQuery) {
    const where: Prisma.ReconciliationMatchWhereInput = {
      organisationId: orgId, ...(q.status && { status: q.status }), ...(q.type && { type: q.type }), ...(q.runId && { runId: q.runId }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.reconciliationMatch.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { score: 'desc' }], ...skipTake(q),
        include: {
          transaction: { select: { id: true, providerRef: true, reference: true, amount: true, currency: true, customerId: true, occurredAt: true } },
          invoice: { select: { id: true, reference: true, amount: true, amountPaid: true, currency: true, customerId: true, dueAt: true } },
        },
      }),
      this.prisma.reconciliationMatch.count({ where }),
    ]);
    return paged(rows, total, q);
  }
}

@ApiTags('reconciliation')
@ApiBearerAuth()
@Controller('reconciliation')
class ReconciliationController {
  constructor(private readonly svc: ReconciliationService, private readonly q: ReconciliationQueries) {}

  @Post('run') @HttpCode(200) @MinRole(Role.MANAGER)
  run(@Org() org: { id: string }, @CurrentUser() u: { id: string }) { return this.svc.run(org.id, u.id); }

  @Get('runs') @MinRole(Role.ANALYST)
  runs(@Org() org: { id: string }, @Query() q: PageQueryDto) { return this.q.runs(org.id, q); }

  @Get('runs/:id') @MinRole(Role.ANALYST)
  runOne(@Org() org: { id: string }, @Param('id', ParseUUIDPipe) id: string) { return this.q.run(org.id, id); }

  @Get('results') @MinRole(Role.ANALYST)
  results(@Org() org: { id: string }, @Query() q: ResultsQuery) { return this.q.results(org.id, q); }

  @Post('matches/manual') @MinRole(Role.MANAGER)
  manual(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Body() dto: ManualMatchDto) { return this.svc.manual(org.id, u.id, dto); }

  @Post('matches/:id/confirm') @HttpCode(200) @MinRole(Role.MANAGER)
  confirm(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewDto) { return this.svc.confirm(org.id, u.id, id, dto.note); }

  @Post('matches/:id/reject') @HttpCode(200) @MinRole(Role.MANAGER)
  reject(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewDto) { return this.svc.reject(org.id, u.id, id, dto.note); }

  @Post('matches/:id/reverse') @HttpCode(200) @MinRole(Role.MANAGER)
  reverse(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewDto) { return this.svc.reverse(org.id, u.id, id, dto.note); }
}

@Module({
  imports: [ExceptionsModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService, ReconciliationQueries],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
