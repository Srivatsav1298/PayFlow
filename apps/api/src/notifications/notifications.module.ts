import { Controller, Get, Injectable, Module, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma, Role } from '@prisma/client';
import { CurrentUser, MinRole, Org } from '../common/decorators';
import { PageQueryDto, paged, skipTake } from '../common/pagination';
import { PrismaService } from '../common/prisma.service';

export interface NotifyInput {
  kind: 'FAILED_PAYMENT' | 'UNMATCHED_PAYMENT' | 'EXCEPTION' | 'WEBHOOK_DEAD_LETTER' | 'RECONCILIATION';
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
}

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** userId = null means "visible to every finance manager/admin in the organisation". */
  notifyOrg(orgId: string, n: NotifyInput, tx: Prisma.TransactionClient = this.prisma) {
    return tx.notification.create({ data: { organisationId: orgId, userId: null, ...n } });
  }

  async list(orgId: string, userId: string, q: PageQueryDto, unreadOnly: boolean) {
    const where: Prisma.NotificationWhereInput = {
      organisationId: orgId,
      OR: [{ userId: null }, { userId }],
      ...(unreadOnly ? { readAt: null } : {}),
    };
    const [rows, total, unread] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(q) }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { ...where, readAt: null } }),
    ]);
    return { ...paged(rows, total, q), unread };
  }

  async markRead(orgId: string, id: string) {
    const r = await this.prisma.notification.updateMany({ where: { id, organisationId: orgId, readAt: null }, data: { readAt: new Date() } });
    return { updated: r.count };
  }
}

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get() @MinRole(Role.ANALYST)
  list(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Query() q: PageQueryDto, @Query('unread') unread?: string) {
    return this.svc.list(org.id, u.id, q, unread === 'true');
  }

  @Patch(':id/read') @MinRole(Role.ANALYST)
  read(@Org() org: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.markRead(org.id, id);
  }
}

@Module({ controllers: [NotificationsController], providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}
