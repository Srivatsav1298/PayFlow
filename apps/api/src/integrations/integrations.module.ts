import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import {
  IsBoolean, IsIn, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Max, MaxLength, Min,
} from 'class-validator';
import { AuditService } from '../audit-logs/audit-logs.module';
import { decrypt, encrypt } from '../common/crypto.util';
import { CurrentUser, MinRole, Org } from '../common/decorators';
import { IsCurrency, IsMoney } from '../common/money';
import { PrismaService } from '../common/prisma.service';
import { MockPaymentProvider } from '../providers/mock.provider';
import { PaymentProviderService } from '../providers/payment-provider.service';
import { PaymentProvidersModule } from '../providers/providers.module';
import { SUPPORTED_EVENT_TYPES } from '../providers/provider.types';
import { WebhooksModule, WebhooksService } from '../webhooks/webhooks.module';

export class CreateConnectionDto {
  @ApiProperty({ example: 'mock' }) @IsString() @IsNotEmpty() @MaxLength(50) providerKey: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) label: string;
  @ApiProperty({ description: 'Provider credentials (sandbox only). Stored AES-256-GCM encrypted, never returned.' })
  @IsObject() credentials: Record<string, unknown>;
}
export class UpdateConnectionDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) label?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}
export class SimulateEventDto {
  @ApiProperty({ enum: SUPPORTED_EVENT_TYPES }) @IsIn(SUPPORTED_EVENT_TYPES as unknown as string[]) type: string;
  @ApiPropertyOptional({ description: 'Existing provider payment id; omit to create a new simulated payment' })
  @IsOptional() @IsString() @MaxLength(100) paymentRef?: string;
  @ApiPropertyOptional({ description: 'Reuse an event id to simulate a duplicate delivery' })
  @IsOptional() @IsString() @MaxLength(128) eventId?: string;
  @ApiPropertyOptional({ description: 'Per-payment ordering number; send a lower one to simulate an out-of-order event' })
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) sequence?: number;
  @ApiPropertyOptional() @IsOptional() @IsMoney() amount?: string;
  @ApiPropertyOptional() @IsOptional() @IsCurrency() currency?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) reference?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) customerId?: string;
}

const publicView = <T extends { encryptedCredentials: string; encryptedWebhookSecret: string }>(c: T) => {
  const { encryptedCredentials: _a, encryptedWebhookSecret: _b, ...rest } = c;
  return rest;
};
const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

@Injectable()
class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: PaymentProviderService,
    private readonly mock: MockPaymentProvider,
    private readonly webhooks: WebhooksService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  private get key() { return this.config.getOrThrow<string>('ENCRYPTION_KEY'); }
  private webhookPath = (providerKey: string, id: string) => `/api/webhooks/${providerKey}?connection=${id}`;

  async list(orgId: string) {
    const rows = await this.prisma.providerConnection.findMany({
      where: { organisationId: orgId }, orderBy: { createdAt: 'asc' }, include: { provider: { select: { key: true, name: true, isSandbox: true } } },
    });
    return rows.map((c) => ({ ...publicView(c), webhookPath: this.webhookPath(c.provider.key, c.id) }));
  }

  async create(orgId: string, actorId: string, dto: CreateConnectionDto) {
    this.providers.get(dto.providerKey); // 404 on unknown provider
    const provider = await this.prisma.paymentProvider.findUniqueOrThrow({ where: { key: dto.providerKey } });
    if (!provider.isSandbox) throw new BadRequestException('Only sandbox providers are supported in this build');
    // Mock data starts N·6h ago so dashboards show recent activity; pinned now so later syncs stay deterministic.
    const credentials = { ...dto.credentials };
    if (dto.providerKey === 'mock' && !credentials.startDate) {
      const count = Math.min(Number(credentials.count ?? 60), 5000);
      const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
      credentials.startDate = new Date(midnight.getTime() - count * 6 * 3_600_000).toISOString();
    }
    const creds = JSON.stringify(credentials);
    if (creds.length > 4000) throw new BadRequestException('credentials too large');
    const secret = newSecret();
    const conn = await this.prisma.providerConnection.create({
      data: {
        organisationId: orgId, providerId: provider.id, label: dto.label,
        encryptedCredentials: encrypt(creds, this.key), encryptedWebhookSecret: encrypt(secret, this.key),
      },
      include: { provider: { select: { key: true, name: true, isSandbox: true } } },
    });
    await this.audit.log({ organisationId: orgId, actorId, action: 'integration.create', entityType: 'ProviderConnection', entityId: conn.id, metadata: { provider: dto.providerKey, label: dto.label } });
    // The webhook secret is shown exactly once — it cannot be read back later.
    return { ...publicView(conn), webhookPath: this.webhookPath(provider.key, conn.id), webhookSecret: secret };
  }

  private async own(orgId: string, id: string) {
    const c = await this.prisma.providerConnection.findFirst({ where: { id, organisationId: orgId }, include: { provider: true } });
    if (!c) throw new NotFoundException('Connection not found');
    return c;
  }

  async update(orgId: string, actorId: string, id: string, dto: UpdateConnectionDto) {
    await this.own(orgId, id);
    const c = await this.prisma.providerConnection.update({ where: { id }, data: dto });
    await this.audit.log({ organisationId: orgId, actorId, action: 'integration.update', entityType: 'ProviderConnection', entityId: id, metadata: dto as Record<string, unknown> });
    return publicView(c);
  }

  /** Deactivate rather than delete: transactions keep a foreign key to their connection. */
  async deactivate(orgId: string, actorId: string, id: string) {
    await this.own(orgId, id);
    await this.prisma.providerConnection.update({ where: { id }, data: { isActive: false } });
    await this.audit.log({ organisationId: orgId, actorId, action: 'integration.deactivate', entityType: 'ProviderConnection', entityId: id });
    return { success: true };
  }

  async rotateSecret(orgId: string, actorId: string, id: string) {
    await this.own(orgId, id);
    const secret = newSecret();
    await this.prisma.providerConnection.update({ where: { id }, data: { encryptedWebhookSecret: encrypt(secret, this.key) } });
    await this.audit.log({ organisationId: orgId, actorId, action: 'integration.rotate_webhook_secret', entityType: 'ProviderConnection', entityId: id });
    return { webhookSecret: secret };
  }

  /**
   * Sandbox helper: builds a correctly SIGNED provider event and pushes it through the real webhook
   * intake (signature check → dedupe → queue → worker), so demos exercise the production path.
   */
  async simulate(orgId: string, id: string, dto: SimulateEventDto) {
    const c = await this.own(orgId, id);
    if (!c.provider.isSandbox || c.provider.key !== 'mock') throw new BadRequestException('Simulation is only available for the mock provider');
    if (!c.isActive) throw new BadRequestException('Connection is inactive');
    const secret = decrypt(c.encryptedWebhookSecret, this.key);

    const paymentRef = dto.paymentRef ?? `sim_${randomBytes(6).toString('hex')}`;
    const existing = dto.paymentRef
      ? await this.prisma.transaction.findUnique({ where: { connectionId_providerRef: { connectionId: id, providerRef: dto.paymentRef } } })
      : null;
    const sequence = dto.sequence ?? Number((existing?.lastEventSequence ?? 0n) + 1n);
    const { rawBody, signature } = this.mock.buildSignedEvent(secret, {
      id: dto.eventId ?? `evt_${randomUUID()}`, type: dto.type, sequence,
      payment: {
        id: paymentRef,
        amount: dto.amount ?? existing?.amount.toFixed(2) ?? '100.00',
        currency: dto.currency ?? existing?.currency ?? 'EUR',
        reference: dto.reference ?? existing?.reference ?? undefined,
        customer_id: dto.customerId ?? existing?.customerId ?? undefined,
        metadata: { simulated: true },
      },
    });
    const result = await this.webhooks.receive('mock', id, rawBody, { 'x-payflow-signature': signature });
    return { ...result, paymentRef, sequence };
  }
}

@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations')
class IntegrationsController {
  constructor(private readonly svc: IntegrationsService) {}

  @Get() @MinRole(Role.ADMIN)
  list(@Org() org: { id: string }) { return this.svc.list(org.id); }

  @Post() @MinRole(Role.ADMIN)
  create(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Body() dto: CreateConnectionDto) { return this.svc.create(org.id, u.id, dto); }

  @Patch(':id') @MinRole(Role.ADMIN)
  update(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateConnectionDto) {
    return this.svc.update(org.id, u.id, id, dto);
  }

  @Delete(':id') @MinRole(Role.ADMIN)
  remove(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Param('id', ParseUUIDPipe) id: string) { return this.svc.deactivate(org.id, u.id, id); }

  @Post(':id/rotate-webhook-secret') @HttpCode(200) @MinRole(Role.ADMIN)
  rotate(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Param('id', ParseUUIDPipe) id: string) { return this.svc.rotateSecret(org.id, u.id, id); }

  @Post(':id/simulate') @HttpCode(202) @MinRole(Role.MANAGER)
  simulate(@Org() org: { id: string }, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SimulateEventDto) { return this.svc.simulate(org.id, id, dto); }
}

@Module({
  imports: [PaymentProvidersModule, WebhooksModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService],
})
export class IntegrationsModule {}
