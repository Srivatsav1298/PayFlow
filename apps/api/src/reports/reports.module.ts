import { Controller, Get, Module, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDate, IsIn, IsOptional } from 'class-validator';
import { Response } from 'express';
import { AuditService } from '../audit-logs/audit-logs.module';
import { CurrentUser, MinRole, Org } from '../common/decorators';
import { toCsv } from './csv.util';
import { Report, ReportsService } from './reports.service';

export class RangeQuery {
  @ApiPropertyOptional() @IsOptional() @Type(() => Date) @IsDate() from?: Date;
  @ApiPropertyOptional() @IsOptional() @Type(() => Date) @IsDate() to?: Date;
}
export class ReportQuery extends RangeQuery {
  @ApiPropertyOptional({ enum: ['json', 'csv'], default: 'json' }) @IsOptional() @IsIn(['json', 'csv']) format: 'json' | 'csv' = 'json';
}
export class VolumeQuery extends ReportQuery {
  @ApiPropertyOptional({ enum: ['day', 'month'], default: 'day' }) @IsOptional() @IsIn(['day', 'month']) groupBy: 'day' | 'month' = 'day';
}

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
class ReportsController {
  constructor(private readonly svc: ReportsService, private readonly audit: AuditService) {}

  /** Dashboard figures: open to every role, computed live from the database. */
  @Get('overview') @MinRole(Role.ANALYST)
  overview(@Org() org: { id: string }, @Query() q: RangeQuery) { return this.svc.overview(org.id, q); }

  @Get('reconciliation') @MinRole(Role.MANAGER)
  reconciliation(@Org() o: { id: string }, @CurrentUser() u: { id: string }, @Query() q: ReportQuery, @Res({ passthrough: true }) res: Response) {
    return this.send('reconciliation', this.svc.reconciliation(o.id, q), q.format, o.id, u.id, res);
  }

  @Get('transaction-volume') @MinRole(Role.MANAGER)
  volume(@Org() o: { id: string }, @CurrentUser() u: { id: string }, @Query() q: VolumeQuery, @Res({ passthrough: true }) res: Response) {
    return this.send('transaction-volume', this.svc.transactionVolume(o.id, q, q.groupBy), q.format, o.id, u.id, res);
  }

  @Get('failed-payments') @MinRole(Role.MANAGER)
  failed(@Org() o: { id: string }, @CurrentUser() u: { id: string }, @Query() q: ReportQuery, @Res({ passthrough: true }) res: Response) {
    return this.send('failed-payments', this.svc.failedPayments(o.id, q), q.format, o.id, u.id, res);
  }

  @Get('outstanding-invoices') @MinRole(Role.MANAGER)
  outstanding(@Org() o: { id: string }, @CurrentUser() u: { id: string }, @Query() q: ReportQuery, @Res({ passthrough: true }) res: Response) {
    return this.send('outstanding-invoices', this.svc.outstandingInvoices(o.id), q.format, o.id, u.id, res);
  }

  @Get('provider-performance') @MinRole(Role.MANAGER)
  providers(@Org() o: { id: string }, @CurrentUser() u: { id: string }, @Query() q: ReportQuery, @Res({ passthrough: true }) res: Response) {
    return this.send('provider-performance', this.svc.providerPerformance(o.id, q), q.format, o.id, u.id, res);
  }

  private async send(name: string, pending: Promise<Report>, format: 'json' | 'csv', orgId: string, actorId: string, res: Response) {
    const report = await pending;
    if (format !== 'csv') return { summary: report.summary, columns: report.columns, data: report.rows };
    await this.audit.log({ organisationId: orgId, actorId, action: 'report.export', entityType: 'Report', metadata: { report: name, rows: report.rows.length } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payflow-${name}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return toCsv(report.columns, report.rows);
  }
}

@Module({ controllers: [ReportsController], providers: [ReportsService], exports: [ReportsService] })
export class ReportsModule {}
