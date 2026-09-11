import { Prisma, PrismaClient } from '@prisma/client';

import { RequestContextStore } from '../../context/request-context';
import { QueryScopeStore } from './query-scope';

/**
 * Extensiones de Prisma: la red de seguridad del aislamiento (ADR-0003) y del soft
 * delete (ADR-0004).
 *
 * La idea de fondo: un repositorio bien escrito filtra por `tenantId` y por `deletedAt`.
 * Pero en un sistema de este tamaño, con años de evolución y varias manos, *alguno* se
 * olvidará. Estas extensiones hacen que ese olvido no tenga consecuencias, porque el
 * filtro se inyecta por debajo aunque nadie lo pida.
 *
 * ── Límites conocidos, y por qué se aceptan ──────────────────────────────────────────
 *
 * 1. **Escrituras anidadas.** `create({ data: { lines: { create: [...] } } })` no pasa
 *    por la extensión en sus hijos. Los repositorios ponen el `tenantId` de las líneas
 *    explícitamente; los tests de integración lo verifican.
 *
 * 2. **SQL crudo.** `$queryRaw` no se intercepta: es SQL, no una operación de modelo.
 *    Los informes lo usan y deben filtrar a mano. Por eso existe `tenantFilter()`, que
 *    obliga a pasar por un sitio donde la omisión es visible.
 *
 * Ninguno de los dos se puede resolver dentro de Prisma. La solución real y definitiva
 * es Row Level Security de PostgreSQL, que cubre también estos casos; el ADR-0003
 * documenta por qué se pospone y esto es lo que hay mientras tanto.
 */

/**
 * Modelos sin `tenantId`.
 *
 * La lista es explícita y cerrada: un modelo nuevo queda con ámbito de tenant por
 * defecto, de modo que el olvido falle hacia el lado seguro. Si alguien añade un modelo
 * global y no lo apunta aquí, sus consultas fallarán ruidosamente en desarrollo —que es
 * exactamente lo que debe pasar.
 */
export const TENANT_EXEMPT_MODELS: ReadonlySet<string> = new Set([
  'Tenant',
  'Permission',
  // Tablas puente: heredan el ámbito de sus extremos, que sí lo tienen.
  'RolePermission',
  'UserRole',
  // Se consulta por su propio hash antes de saber a qué salón pertenece la sesión.
  'RefreshToken',
  'PasswordResetToken',
]);

/**
 * Modelos con `tenantId` opcional.
 *
 * `User` y `Role` admiten `tenantId = null` para las cuentas y roles de plataforma. Se
 * filtran igual que el resto cuando hay un tenant activo; la diferencia es que sin
 * tenant activo no se rechaza la consulta.
 */
const NULLABLE_TENANT_MODELS: ReadonlySet<string> = new Set(['User', 'Role', 'AuditLog']);

/** Modelos append-only: la extensión rechaza mutarlos antes de llegar a la base. */
const APPEND_ONLY_MODELS: ReadonlySet<string> = new Set(['AuditLog', 'InventoryMovement']);

const READ_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

const WHERE_SCOPED_WRITE_OPERATIONS = new Set([
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
]);

const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn', 'upsert']);

const SOFT_DELETABLE_EXCLUSIONS: ReadonlySet<string> = new Set([
  'Permission',
  'RolePermission',
  'UserRole',
  'RefreshToken',
  'PasswordResetToken',
  'AuditLog',
  'InventoryMovement',
  'DocumentSequence',
  'ServiceConsumable',
  'SupplierProduct',
  'StylistService',
  'AppointmentService',
  'PurchaseOrderLine',
  'InvoiceLine',
]);

type QueryArgs = {
  where?: Record<string, unknown>;
  data?: Record<string, unknown> | Record<string, unknown>[];
  create?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Error de configuración, no de negocio: significa que una consulta con ámbito de
 * tenant se ha ejecutado sin tenant y sin declarar que es una operación entre
 * inquilinos. Se prefiere reventar a devolver datos de todos los salones.
 */
export class MissingTenantScopeError extends Error {
  constructor(model: string, operation: string) {
    super(
      `La operación ${model}.${operation} requiere un salón activo. ` +
        'Autentique la petición o envuelva la llamada en QueryScopeStore.crossTenant() ' +
        'si es deliberadamente entre inquilinos (ADR-0003).',
    );
    this.name = 'MissingTenantScopeError';
  }
}

export class AppendOnlyViolationError extends Error {
  constructor(model: string, operation: string) {
    super(
      `${model} es append-only y no admite ${operation}. ` +
        'Registre un asiento compensatorio en su lugar (ADR-0011).',
    );
    this.name = 'AppendOnlyViolationError';
  }
}

const isSoftDeletable = (model: string): boolean => !SOFT_DELETABLE_EXCLUSIONS.has(model);

/** Añade una condición al `where` sin pisar lo que el llamante ya haya puesto. */
const mergeWhere = (args: QueryArgs, condition: Record<string, unknown>): QueryArgs => ({
  ...args,
  where: { ...(args.where ?? {}), ...condition },
});

export function applyGuardExtensions(client: PrismaClient) {
  return client.$extends({
    name: 'tenant-scope-and-soft-delete',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const scope = QueryScopeStore.current();
          const context = RequestContextStore.get();
          let nextArgs = (args ?? {}) as QueryArgs;

          // --- Inmutabilidad del ledger --------------------------------------------
          // La base de datos también lo impide con un trigger. Aquí se atrapa antes,
          // con un mensaje que dice qué hacer en lugar de un error de PostgreSQL.
          if (
            APPEND_ONLY_MODELS.has(model) &&
            (operation === 'update' ||
              operation === 'updateMany' ||
              operation === 'delete' ||
              operation === 'upsert')
          ) {
            throw new AppendOnlyViolationError(model, operation);
          }

          // --- Aislamiento por salón ------------------------------------------------
          const needsTenantScope =
            !TENANT_EXEMPT_MODELS.has(model) && !scope.bypassTenant && !context.bypassTenantScope;

          if (needsTenantScope) {
            const tenantId = context.tenantId;

            if (tenantId === null && !NULLABLE_TENANT_MODELS.has(model)) {
              throw new MissingTenantScopeError(model, operation);
            }

            if (tenantId !== null) {
              if (READ_OPERATIONS.has(operation) || WHERE_SCOPED_WRITE_OPERATIONS.has(operation)) {
                nextArgs = mergeWhere(nextArgs, { tenantId });
              }

              if (CREATE_OPERATIONS.has(operation)) {
                // `createMany` recibe un array; `create` y `upsert.create`, un objeto.
                if (Array.isArray(nextArgs.data)) {
                  nextArgs = {
                    ...nextArgs,
                    data: nextArgs.data.map((row) => ({ tenantId, ...row })),
                  };
                } else if (nextArgs.data) {
                  nextArgs = { ...nextArgs, data: { tenantId, ...nextArgs.data } };
                }
                if (nextArgs.create) {
                  nextArgs = { ...nextArgs, create: { tenantId, ...nextArgs.create } };
                }
              }
            }
          }

          // --- Soft delete ----------------------------------------------------------
          if (isSoftDeletable(model) && !scope.includeDeleted) {
            if (READ_OPERATIONS.has(operation)) {
              nextArgs = mergeWhere(nextArgs, { deletedAt: null });
            }
            // Una actualización nunca debe alcanzar una fila ya borrada: sería resucitar
            // datos por la puerta de atrás.
            if (operation === 'update' || operation === 'updateMany') {
              nextArgs = mergeWhere(nextArgs, { deletedAt: null });
            }
          }

          // `findUnique` solo admite claves únicas en su `where`, y `tenantId` no forma
          // parte de ninguna. Degradarlo a `findFirst` permite componer los filtros; el
          // plan de ejecución es equivalente porque la clave primaria sigue ahí.
          if (
            (nextArgs.where?.tenantId !== undefined || nextArgs.where?.deletedAt !== undefined) &&
            (operation === 'findUnique' || operation === 'findUniqueOrThrow')
          ) {
            const downgraded = operation === 'findUnique' ? 'findFirst' : 'findFirstOrThrow';
            const delegate = (client as unknown as Record<string, Record<string, unknown>>)[
              lowerFirst(model)
            ];
            const method = delegate?.[downgraded] as ((a: unknown) => Promise<unknown>) | undefined;
            if (method) {
              return method.call(delegate, nextArgs);
            }
          }

          return query(nextArgs);
        },
      },
    },
  });
}

const lowerFirst = (value: string): string => value.charAt(0).toLowerCase() + value.slice(1);

/**
 * Filtro de tenant para SQL crudo.
 *
 * Los informes agregan con `$queryRaw`, que las extensiones no interceptan. Este helper
 * existe para que ese filtro sea imposible de olvidar en silencio: si no hay tenant
 * activo, lanza, en vez de devolver una cláusula vacía que agregaría los datos de todos
 * los salones en el panel de uno solo.
 */
export function tenantFilter(): Prisma.Sql {
  const tenantId = RequestContextStore.tenantId;
  if (tenantId === null) {
    throw new MissingTenantScopeError('rawQuery', 'select');
  }
  return Prisma.sql`"tenantId" = ${tenantId}`;
}

export type ExtendedPrismaClient = ReturnType<typeof applyGuardExtensions>;
