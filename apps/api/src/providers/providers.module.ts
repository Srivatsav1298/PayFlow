import { Controller, Get, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { MinRole } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { MockPaymentProvider } from './mock.provider';
import { PaymentProviderService } from './payment-provider.service';

/** Keeps the PaymentProvider catalogue table in sync with the registered adapters at boot. */
@Injectable()
class ProviderCatalogue implements OnModuleInit {
  constructor(private readonly prisma: PrismaService, private readonly providers: PaymentProviderService) {}

  async onModuleInit() {
    for (const p of this.providers.list()) {
      await this.prisma.paymentProvider.upsert({
        where: { key: p.key },
        update: { name: p.name, isSandbox: p.isSandbox },
        create: p,
      });
    }
  }
}

@ApiTags('payment-providers')
@ApiBearerAuth()
@Controller('payment-providers')
class ProvidersController {
  constructor(private readonly providers: PaymentProviderService) {}

  @Get() @MinRole(Role.ANALYST)
  list() { return this.providers.list(); }
}

@Module({
  controllers: [ProvidersController],
  providers: [MockPaymentProvider, PaymentProviderService, ProviderCatalogue],
  exports: [PaymentProviderService, MockPaymentProvider],
})
export class PaymentProvidersModule {}
