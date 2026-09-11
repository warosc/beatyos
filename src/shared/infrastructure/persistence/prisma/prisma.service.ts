import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';

import type { Env } from '../../config/env.schema';
import { applyGuardExtensions, type ExtendedPrismaClient } from './prisma.extensions';

/**
 * Cliente de Prisma con las extensiones de aislamiento aplicadas y conciencia de
 * transacción.
 *
 * El resto de la aplicación nunca instancia `PrismaClient`: siempre pasa por aquí, y
 * por tanto siempre lleva puestas las extensiones. Esa es la razón de que esta clase
 * exista en vez de exportar el cliente directamente.
 */

/** Dentro de una transacción, Prisma retira las operaciones que no tienen sentido. */
export type TransactionalPrismaClient = Omit<
  ExtendedPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

/**
 * Transacción activa de la petición actual.
 *
 * Es la pieza que hace transparente la unidad de trabajo: los repositorios piden
 * `prisma.client` sin saber si están dentro de una transacción. Sin esto, cada
 * repositorio necesitaría un parámetro `tx` opcional en cada método —y bastaría con
 * olvidarlo una vez para que una escritura quedara fuera de la transacción y
 * sobreviviera a un rollback.
 */
const transactionStorage = new AsyncLocalStorage<TransactionalPrismaClient>();

/**
 * Configuracion de log como tupla literal.
 *
 * Prisma deriva de aqui que eventos admite `$on`. Si el campo se declarase con el tipo
 * `PrismaClient` a secas, el generico se perderia y `$on('error', ...)` no compilaria:
 * el parametro quedaria como `never`.
 */
const LOG_CONFIG = [
  { emit: 'event', level: 'error' },
  { emit: 'event', level: 'warn' },
] as const satisfies Prisma.LogDefinition[];

type LoggedPrismaClient = PrismaClient<{ log: typeof LOG_CONFIG }>;

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly base: LoggedPrismaClient;
  private readonly extended: ExtendedPrismaClient;

  constructor(config: ConfigService<Env, true>) {
    const isProduction = config.get('NODE_ENV', { infer: true }) === 'production';

    this.base = new PrismaClient({
      datasources: { db: { url: config.get('DATABASE_URL', { infer: true }) } },
      // Se suscriben ambos niveles siempre y se filtra al recibir: declararlos con un
      // ternario produciría un tipo unión del que Prisma ya no puede derivar qué eventos
      // admite `$on`, y `$on('error', ...)` dejaría de compilar.
      //
      // Nunca se registra `query`: el log de cada consulta es caro y, sobre todo, vuelca
      // los parámetros —correos, teléfonos, importes— al recolector de logs, donde ya no
      // se pueden retirar.
      log: LOG_CONFIG,
      errorFormat: isProduction ? 'minimal' : 'pretty',
    });

    this.base.$on('error', (event) => this.logger.error(event.message));
    this.base.$on('warn', (event) => {
      if (!isProduction) this.logger.warn(event.message);
    });

    this.extended = applyGuardExtensions(this.base);
  }

  /**
   * Cliente a usar para cualquier consulta.
   *
   * Devuelve la transacción activa si la hay, y si no el cliente raíz. Los repositorios
   * solo conocen esta propiedad.
   */
  get client(): TransactionalPrismaClient {
    return transactionStorage.getStore() ?? this.extended;
  }

  /** `true` si ya estamos dentro de una transacción. */
  get inTransaction(): boolean {
    return transactionStorage.getStore() !== undefined;
  }

  /**
   * Ejecuta `work` de forma atómica.
   *
   * Si ya hay una transacción abierta, se **une** a ella en lugar de abrir otra: anidar
   * transacciones en PostgreSQL exige savepoints y una transacción interna que confirma
   * por su cuenta rompería la atomicidad de la externa. Un caso de uso que llama a otro
   * hereda así la transacción del primero, que es lo que casi siempre se quiere.
   */
  async transaction<T>(work: () => Promise<T>, options?: { timeoutMs?: number }): Promise<T> {
    if (this.inTransaction) {
      return work();
    }

    return this.extended.$transaction(
      async (tx) => transactionStorage.run(tx as TransactionalPrismaClient, work),
      {
        maxWait: 5_000,
        timeout: options?.timeoutMs ?? 15_000,
      },
    );
  }

  async onModuleInit(): Promise<void> {
    await this.base.$connect();
    this.logger.log('Conexión con PostgreSQL establecida');
  }

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect();
  }

  /** Comprobación de vida para el endpoint de salud. */
  async ping(): Promise<boolean> {
    try {
      await this.base.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error('La comprobación de salud de la base de datos ha fallado', error);
      return false;
    }
  }

  /**
   * Vacía todas las tablas. **Solo para tests** (ADR-0009).
   *
   * La comprobación de `NODE_ENV` no es paranoia: un `truncateAll` invocado por error
   * contra producción es un incidente del que no se vuelve. El coste de la guarda es
   * cero y el de su ausencia es total.
   *
   * `TRUNCATE` no dispara los triggers de fila, así que las tablas append-only también
   * se limpian; y `CASCADE` evita tener que ordenar las tablas por dependencias.
   */
  async truncateAll(): Promise<void> {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('truncateAll() solo puede ejecutarse con NODE_ENV=test');
    }

    const tables = await this.base.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `;

    if (tables.length === 0) return;

    const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
    await this.base.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
}
