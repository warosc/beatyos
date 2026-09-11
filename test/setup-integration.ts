import 'reflect-metadata';

import { config as loadDotenv } from 'dotenv';

/**
 * Preparación del entorno de la suite de integración.
 *
 * ── Por qué esto existe ────────────────────────────────────────────────────────────
 *
 * Algo del árbol de dependencias carga `.env` en `process.env` antes de que arranque
 * ningún test, y `@nestjs/config` da prioridad a `process.env` sobre el fichero que se le
 * indique. Resultado: la suite tomaba la configuración de **desarrollo** —incluida su
 * `DATABASE_URL`— pese a declarar `.env.test`.
 *
 * Eso no es una molestia: `resetDatabase()` ejecuta `TRUNCATE` sobre todas las tablas.
 * Apuntando a la base de desarrollo, cada ejecución de los tests borraba los datos de
 * trabajo del programador. Se descubrió porque los límites de peticiones de `.env.test`
 * no se aplicaban; el borrado de la base era el daño colateral silencioso.
 *
 * `override: true` impone `.env.test` sobre cualquier valor previo, y la comprobación de
 * abajo convierte un error de configuración en un fallo inmediato y explicado en lugar de
 * una pérdida de datos.
 */
loadDotenv({ path: '.env.test', override: true });

const databaseUrl = process.env.DATABASE_URL ?? '';

if (process.env.NODE_ENV !== 'test') {
  throw new Error(
    `La suite de integración exige NODE_ENV=test y se ha encontrado "${process.env.NODE_ENV}". ` +
      'Abortando antes de tocar ninguna base de datos.',
  );
}

/**
 * Guarda contra ejecutar los tests sobre una base que no sea la de pruebas.
 *
 * El criterio es el nombre de la base y el puerto declarados en `docker-compose.yml`.
 * Es una comprobación tosca a propósito: tiene que ser imposible de saltarse por
 * descuido y trivial de entender cuando salta.
 */
if (!databaseUrl.includes('salon_test')) {
  throw new Error(
    'DATABASE_URL no apunta a la base de datos de pruebas (se esperaba "salon_test").\n' +
      `Valor actual: ${databaseUrl.replace(/:[^:@]+@/, ':***@')}\n\n` +
      'La suite ejecuta TRUNCATE sobre todas las tablas. Se aborta para no destruir ' +
      'datos de desarrollo o, peor, de producción.\n' +
      'Levante la base de pruebas con: docker compose up -d postgres-test',
  );
}

jest.setTimeout(60_000);
