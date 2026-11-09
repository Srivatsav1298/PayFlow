import { Controller, Get, Global, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma, Role } from '@prisma/client';
import { MinRole, Org } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { PageQueryDto, paged, skipTake } from '../common/pagination';

const SENSITIVE = /(password|secret|token|authorization|apikey|api_key|credential)/i;

/** Strip anything that looks like a secret before it can reach the audit trail or logs. */
export function sanitise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitise);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE.test(k) ? '[REDACTED]' : sanitise(v)]),
    );
  }
  return value;
}

export interface AuditEntry {
  organisationId?: string | null;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  log(entry: AuditEntry, tx: Prisma.TransactionClient = this.prisma) {
    return tx.auditLog.create({
      data: { ...entry, metadata: sanitise(entry.metadata ?? {}) as Prisma.InputJsonValue },
    });
  }
}

@ApiTags('audit-logs')
@ApiBearerAuth()
@Controller('audit-logs')
class AuditLogsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @MinRole(Role.ADMIN)
  async list(@Org() org: { id: string }, @Query() q: PageQueryDto) {
    const where = { organisationId: org.id };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(q) }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paged(rows, total, q);
  }
}

@Global()
@Module({ controllers: [AuditLogsController], providers: [AuditService], exports: [AuditService] })
export class AuditLogsModule {}
