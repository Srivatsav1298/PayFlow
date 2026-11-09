import './common/bigint-json';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/http-exception.filter';

/** Shared by main.ts and the test harness so tests exercise the real pipeline. */
export function configureApp(app: INestApplication) {
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.enableCors({ origin: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(','), credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown properties
      forbidNonWhitelisted: true, // reject them (mass-assignment protection)
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
}
