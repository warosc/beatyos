import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { parseCorsOrigins, type Env } from './shared/infrastructure/config/env.schema';
import { GlobalExceptionFilter } from './shared/infrastructure/http/filters/domain-exception.filter';
import { setupOpenApi } from './shared/infrastructure/http/openapi';

/**
 * Punto de entrada.
 *
 * Todo lo que hay aquí es configuración del borde: seguridad de transporte, validación,
 * versionado y documentación. Ninguna regla de negocio.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  // `bufferLogs` retiene los logs del arranque hasta que el logger está listo, de modo
  // que un fallo de configuración se vea entero en lugar de perderse a medias.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.flushLogs();

  const config = app.get(ConfigService<Env, true>);
  const nodeEnv = config.get('NODE_ENV', { infer: true });
  const isProduction = nodeEnv === 'production';
  const port = config.get('PORT', { infer: true });
  const apiPrefix = config.get('API_PREFIX', { infer: true });

  // --- Seguridad de transporte (ADR-0007) ---------------------------------
  app.use(
    helmet({
      // La CSP por defecto de helmet rompe la interfaz de Swagger, que usa estilos y
      // scripts en línea. Se relaja solo lo justo, y únicamente donde Swagger existe.
      contentSecurityPolicy: isProduction ? undefined : false,
      crossOriginEmbedderPolicy: false,
      hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    }),
  );
  app.use(compression());

  // Detrás de un proxy inverso, sin esto `request.ip` sería siempre la IP del proxy y el
  // rate limiting por IP dejaría de distinguir clientes: todos compartirían cupo.
  // Render siempre coloca el servicio detrás de su proxy, también cuando un entorno de
  // demostración usa NODE_ENV=development para cargar el seed. Sin esta excepción todas
  // las personas compartirían la IP del proxy y agotarían juntas el rate limit.
  app.set('trust proxy', isProduction || process.env.RENDER === 'true' ? 1 : false);

  const corsOrigins = parseCorsOrigins(config.get('CORS_ORIGINS', { infer: true }));
  app.enableCors({
    // Lista blanca explícita. Nunca `*` junto a `credentials: true`: el navegador lo
    // rechaza, y si se forzara sería una fuga total de la API a cualquier sitio.
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id', 'Idempotency-Key'],
    exposedHeaders: ['X-Correlation-Id'],
    maxAge: 86_400,
  });

  // --- Rutas y versionado (ADR-0007) --------------------------------------
  app.setGlobalPrefix(apiPrefix, {
    // La salud queda fuera del prefijo versionado: la consultan sondas que no deben
    // enterarse de que la API ha cambiado de versión.
    exclude: [],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // --- Validación ----------------------------------------------------------
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Un campo no declarado es un 400, no algo que se ignore en silencio: quien manda
      // `{ "role": "OWNER" }` a un endpoint que no lo admite merece un error, y quien
      // se equivoca al teclear un nombre de campo merece enterarse.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      // En producción no se devuelve el valor recibido: podría contener la contraseña
      // que acaba de fallar la validación.
      disableErrorMessages: false,
      validationError: { target: false, value: !isProduction },
    }),
  );

  app.useGlobalFilters(new GlobalExceptionFilter(isProduction));

  // --- Documentación (ADR-0007) -------------------------------------------
  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    setupOpenApi(app, config);
  }

  // Cierra las conexiones de Prisma al recibir SIGTERM en lugar de dejarlas colgando.
  app.enableShutdownHooks();

  await app.listen(port, '0.0.0.0');

  logger.log(`Entorno: ${nodeEnv}`);
  logger.log(`API escuchando en http://localhost:${port}/${apiPrefix}/v1`);
  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    logger.log(
      `Documentación en http://localhost:${port}/${config.get('SWAGGER_PATH', { infer: true })}`,
    );
  }
  if (corsOrigins.length === 0) {
    logger.warn('CORS_ORIGINS está vacío: ningún navegador podrá consumir esta API.');
  }
}

void bootstrap().catch((error: unknown) => {
  // Un fallo de arranque tiene que ser ruidoso y terminar el proceso: un contenedor que
  // se queda vivo sin escuchar es peor que uno que muere, porque el orquestador lo da
  // por bueno y le envía tráfico.

  console.error('Fallo al arrancar la aplicación:', error);
  process.exit(1);
});
