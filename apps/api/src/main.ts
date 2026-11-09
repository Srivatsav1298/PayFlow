import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

async function bootstrap() {
  // rawBody is required: webhook signatures are computed over the exact bytes received.
  const app = await NestFactory.create(AppModule, { rawBody: true, bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);

  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('PayFlow API')
      .setDescription('Payment reconciliation & transaction monitoring. Sandbox/mock providers only.')
      .setVersion('0.1.0')
      .addBearerAuth()
      .addApiKey({ type: 'apiKey', name: 'X-Organisation-Id', in: 'header' }, 'org')
      .build(),
  );
  SwaggerModule.setup('api/docs', app, doc);

  const port = Number(process.env.PORT ?? 3100);
  await app.listen(port, '0.0.0.0');
}
void bootstrap();
