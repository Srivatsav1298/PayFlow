import {
  BadRequestException, Body, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { InvoiceStatus, Prisma, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDate, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested,
} from 'class-validator';
import { AuditService } from '../audit-logs/audit-logs.module';
import { CurrentUser, MinRole, Org } from '../common/decorators';
import { IsCurrency, IsMoney } from '../common/money';
import { PageQueryDto, paged, skipTake } from '../common/pagination';
import { PrismaService } from '../common/prisma.service';

export class CreateInvoiceDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) reference: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) customerName?: string;
  @IsMoney() amount: string;
  @IsCurrency() currency: string;
  @ApiProperty() @Type(() => Date) @IsDate() issuedAt: Date;
  @ApiProperty() @Type(() => Date) @IsDate() dueAt: Date;
}

export class ImportInvoicesDto {
  @ApiProperty({ type: [CreateInvoiceDto] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => CreateInvoiceDto)
  invoices: CreateInvoiceDto[];
}

export class UpdateInvoiceDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) customerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) customerName?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Date) @IsDate() dueAt?: Date;
  @ApiPropertyOptional({ description: 'Only allowed while no payment is linked' }) @IsOptional() @IsMoney() amount?: string;
  @ApiPropertyOptional({ enum: ['VOID'], description: 'Only allowed while no payment is linked' })
  @IsOptional() @IsEnum({ VOID: 'VOID' }) status?: 'VOID';
}

export class ListInvoicesQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: InvoiceStatus }) @IsOptional() @IsEnum(InvoiceStatus) status?: InvoiceStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) search?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) customerId?: string;
  @ApiPropertyOptional({ description: 'Past due and not fully paid' })
  @IsOptional() @Type(() => Boolean) @IsBoolean() overdue?: boolean;
  @ApiPropertyOptional({ description: 'No confirmed payment linked' })
  @IsOptional() @Type(() => Boolean) @IsBoolean() unmatched?: boolean;
}

/** Overdue is derived, never stored, so it can't go stale. */
const withDerived = <T extends { status: InvoiceStatus; dueAt: Date; amount: Prisma.Decimal; amountPaid: Prisma.Decimal }>(i: T) => ({
  ...i,
  outstanding: i.amount.minus(i.amountPaid),
  isOverdue: (i.status === 'OPEN' || i.status === 'PARTIALLY_PAID') && i.dueAt < new Date(),
});

@Injectable()
export class InvoicesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private data(orgId: string, d: CreateInvoiceDto): Prisma.InvoiceCreateManyInput {
    if (d.dueAt < d.issuedAt) throw new BadRequestException(`Invoice ${d.reference}: dueAt is before issuedAt`);
    return { organisationId: orgId, reference: d.reference.trim(), customerId: d.customerId, customerName: d.customerName, amount: new Prisma.Decimal(d.amount), currency: d.currency, issuedAt: d.issuedAt, dueAt: d.dueAt };
  }

  async create(orgId: string, actorId: string, dto: CreateInvoiceDto) {
    const inv = await this.prisma.invoice.create({ data: this.data(orgId, dto) }); // P2002 → 409 on duplicate reference
    await this.audit.log({ organisationId: orgId, actorId, action: 'invoice.create', entityType: 'Invoice', entityId: inv.id, metadata: { reference: inv.reference } });
    return withDerived(inv);
  }

  /** Bulk import is all-or-nothing and skips references that already exist (re-importing a file is safe). */
  async import(orgId: string, actorId: string, dto: ImportInvoicesDto) {
    const refs = dto.invoices.map((i) => i.reference.trim());
    if (new Set(refs).size !== refs.length) throw new BadRequestException('Duplicate references inside the import file');
    const r = await this.prisma.invoice.createMany({ data: dto.invoices.map((i) => this.data(orgId, i)), skipDuplicates: true });
    await this.audit.log({ organisationId: orgId, actorId, action: 'invoice.import', entityType: 'Invoice', metadata: { submitted: refs.length, created: r.count } });
    return { submitted: refs.length, created: r.count, skipped: refs.length - r.count };
  }

  async list(orgId: string, q: ListInvoicesQuery) {
    const now = new Date();
    const where: Prisma.InvoiceWhereInput = {
      organisationId: orgId,
      ...(q.status && { status: q.status }),
      ...(q.customerId && { customerId: q.customerId }),
      ...(q.search && { OR: [{ reference: { contains: q.search, mode: 'insensitive' } }, { customerName: { contains: q.search, mode: 'insensitive' } }] }),
      ...(q.overdue && { status: { in: ['OPEN', 'PARTIALLY_PAID'] }, dueAt: { lt: now } }),
      ...(q.unmatched && { status: { not: 'VOID' }, payments: { none: {} } }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.invoice.findMany({ where, orderBy: { dueAt: 'asc' }, ...skipTake(q) }),
      this.prisma.invoice.count({ where }),
    ]);
    return paged(rows.map(withDerived), total, q);
  }

  async get(orgId: string, id: string) {
    const inv = await this.prisma.invoice.findFirst({
      where: { id, organisationId: orgId },
      include: {
        payments: { include: { transaction: { select: { id: true, providerRef: true, status: true, occurredAt: true } } } },
        matches: { orderBy: { score: 'desc' } },
        exceptions: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    return withDerived(inv);
  }

  async update(orgId: string, actorId: string, id: string, dto: UpdateInvoiceDto) {
    const inv = await this.prisma.invoice.findFirst({ where: { id, organisationId: orgId }, include: { _count: { select: { payments: true } } } });
    if (!inv) throw new NotFoundException('Invoice not found');
    if ((dto.amount || dto.status) && inv._count.payments > 0) {
      throw new BadRequestException('Amount/status cannot change once payments are linked');
    }
    const updated = await this.prisma.invoice.update({
      where: { id },
      data: { customerId: dto.customerId, customerName: dto.customerName, dueAt: dto.dueAt, status: dto.status, ...(dto.amount && { amount: new Prisma.Decimal(dto.amount) }) },
    });
    await this.audit.log({ organisationId: orgId, actorId, action: 'invoice.update', entityType: 'Invoice', entityId: id, metadata: dto as Record<string, unknown> });
    return withDerived(updated);
  }
}

@ApiTags('invoices')
@ApiBearerAuth()
@Controller('invoices')
class InvoicesController {
  constructor(private readonly svc: InvoicesService) {}

  @Get() @MinRole(Role.ANALYST)
  list(@Org() org: { id: string }, @Query() q: ListInvoicesQuery) { return this.svc.list(org.id, q); }

  @Post() @MinRole(Role.MANAGER)
  create(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Body() dto: CreateInvoiceDto) { return this.svc.create(org.id, u.id, dto); }

  @Post('import') @MinRole(Role.MANAGER)
  import(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Body() dto: ImportInvoicesDto) { return this.svc.import(org.id, u.id, dto); }

  @Get(':id') @MinRole(Role.ANALYST)
  get(@Org() org: { id: string }, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(org.id, id); }

  @Patch(':id') @MinRole(Role.MANAGER)
  update(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateInvoiceDto) {
    return this.svc.update(org.id, u.id, id, dto);
  }
}

@Module({ controllers: [InvoicesController], providers: [InvoicesService], exports: [InvoicesService] })
export class InvoicesModule {}
