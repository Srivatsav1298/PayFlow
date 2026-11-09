import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuditLogsModule } from './audit-logs/audit-logs.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard, OrgContextGuard, RolesGuard } from './common/guards';
import { PrismaModule } from './common/prisma.service';
import { Public } from './common/decorators';
import { OrganisationsModule } from './organisations/organisations.module';
import { validateEnv } from './config/env';
import { BullModule } from '@nestjs/bullmq';
import { ExceptionsModule } from './exceptions/exceptions.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PaymentProvidersModule } from './providers/providers.module';
import { TransactionsModule } from './transactions/transactions.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { InvoicesModule } from './invoices/invoices.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { ReportsModule } from './reports/reports.module';

/** Parse redis://[:password@]host:port[/db] into BullMQ connection options. */
function redisConnection() {
  const u = new URL(process.env.REDIS_URL ?? 'redis://localhost:6380');
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null as null,
  };
}

@Controller('health')
class HealthController {
  @Public() @Get() health() { return { status: 'ok' }; }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
        // Secrets and tokens must never reach logs.
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-payflow-signature"]',
            'req.body.password',
            'req.body.refreshToken',
            'req.body.credentials',
            'req.body.webhookSecret',
            'res.headers["set-cookie"]',
          ],
          censor: '[REDACTED]',
        },
        autoLogging: { ignore: (req) => req.url === '/api/health' },
      },
    }),
    ThrottlerModule.forRoot([
      { ttl: Number(process.env.THROTTLE_TTL_MS ?? 60_000), limit: Number(process.env.THROTTLE_LIMIT ?? 120) },
    ]),
    JwtModule.register({ global: true }),
    BullModule.forRoot({ connection: redisConnection() }),
    PrismaModule,
    AuditLogsModule,
    AuthModule,
    OrganisationsModule,
    NotificationsModule,
    ExceptionsModule,
    PaymentProvidersModule,
    TransactionsModule,
    WebhooksModule,
    IntegrationsModule,
    InvoicesModule,
    ReconciliationModule,
    ReportsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: rate-limit → authenticate → resolve org membership → enforce role.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: OrgContextGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
