import { ValidationPipe, VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getOptionsToken } from '@nestjs/throttler';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from '@app/app.module';
import { GlobalExceptionFilter } from '@shared/infrastructure/http/filters/domain-exception.filter';
import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';

/**
 * Arnés de la suite de integración (ADR-0009).
 *
 * Levanta la aplicación **completa** —guards, filtros, interceptores, extensiones de
 * Prisma y PostgreSQL de verdad—. Aquí no hay dobles: si un test pasa, es que el sistema
 * funciona de extremo a extremo.
 *
 * Es lo que la suite unitaria no puede cubrir por definición: que el filtro de tenant de
 * la extensión de Prisma se aplique de verdad, que un índice único parcial permita
 * reutilizar el correo de un cliente borrado, o que un solapamiento de agenda lo rechace
 * PostgreSQL bajo peticiones concurrentes.
 *
 * La configuración replica la de `main.ts` deliberadamente y **no** la importa: un test
 * de integración que reutilizara el bootstrap real dejaría de detectar que alguien ha
 * desactivado la validación global. Duplicar unas pocas líneas es el precio de que estos
 * tests puedan afirmar algo sobre el borde HTTP.
 */

export interface IntegrationContext {
  readonly app: INestApplication;
  readonly prisma: PrismaService;
}

export interface TestAppOptions {
  /**
   * Sustituye las opciones del rate limiter.
   *
   * Existe porque los limites llegan desde `.env.test` y ahi son deliberadamente altos:
   * la suite comparte una unica IP y con valores realistas se estrangularia a si misma.
   * Cambiar `process.env` justo antes de crear la aplicacion no basta —`@nestjs/config`
   * da prioridad al fichero—, asi que la unica via limpia es sustituir el proveedor por
   * su token, que es exactamente para lo que existe `overrideProvider`.
   */
  readonly throttlers?: { name: string; ttl: number; limit: number }[];
}

export async function createTestApp(options?: TestAppOptions): Promise<IntegrationContext> {
  const builder = Test.createTestingModule({ imports: [AppModule] });

  if (options?.throttlers) {
    builder.overrideProvider(getOptionsToken()).useValue({ throttlers: options.throttlers });
  }

  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter(false));

  await app.init();

  return { app, prisma: app.get(PrismaService) };
}

/**
 * Vacía la base entre tests.
 *
 * `TRUNCATE ... CASCADE` en lugar de borrar tabla por tabla: no hay que mantener un orden
 * de dependencias que se rompería con cada relación nueva, y no dispara los triggers de
 * fila, de modo que las tablas append-only —auditoría e inventario— también se limpian.
 */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.truncateAll();
}

/** Ruta completa de un endpoint, para no repetir el prefijo en cada test. */
export const api = (path: string): string => `/api/v1${path}`;
