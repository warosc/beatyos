/**
 * Contratos de persistencia (ADR-0001).
 *
 * Son **puertos**: los define el dominio y los implementa la infraestructura. Por eso
 * viven aquí y no junto a Prisma, y por eso no mencionan tablas, `select`, `include`
 * ni ningún otro concepto de ORM.
 *
 * Estos tipos son también el contrato que deben cumplir los dobles en memoria de la
 * suite unitaria (ADR-0009): un doble que se desvíe de ellos deja de probar nada.
 */

/** Orden de un campo. La lista de campos permitidos la fija cada repositorio. */
export interface SortCriterion<TField extends string = string> {
  readonly field: TField;
  readonly direction: 'asc' | 'desc';
}

/** Paginación por desplazamiento (ADR-0007). */
export interface PageRequest<TField extends string = string> {
  readonly page: number;
  readonly limit: number;
  readonly sort?: readonly SortCriterion<TField>[];
}

export interface PageMeta {
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly totalPages: number;
  readonly hasNext: boolean;
  readonly hasPrevious: boolean;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly meta: PageMeta;
}

export const buildPage = <T>(data: readonly T[], total: number, request: PageRequest): Page<T> => {
  const { page, limit } = request;
  // Con `total = 0` el resultado son 0 páginas, no 1: "página 1 de 0" describe mejor
  // una lista vacía que "página 1 de 1", que sugiere que hay contenido.
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    data,
    meta: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrevious: page > 1 && total > 0,
    },
  };
};

/**
 * Opciones comunes a toda consulta.
 *
 * `includeDeleted` es explícito y por defecto `false` (ADR-0004): ver filas borradas
 * tiene que ser una decisión consciente, nunca el resultado de olvidar un filtro.
 */
export interface QueryOptions {
  readonly includeDeleted?: boolean;
}

/**
 * Operaciones que comparten todos los repositorios de entidades con tenant.
 *
 * Ningún método recibe `tenantId`: lo aporta el contexto de petición y lo aplica la
 * extensión de Prisma (ADR-0003). Pasarlo por parámetro invitaría a que algún caso de
 * uso lo tomara del cuerpo de la petición, que es exactamente el agujero que se quiere
 * cerrar.
 */
export interface Repository<TEntity, TId extends string = string> {
  findById(id: TId, options?: QueryOptions): Promise<TEntity | null>;
  exists(id: TId, options?: QueryOptions): Promise<boolean>;
  save(entity: TEntity): Promise<TEntity>;
  /** Marca como borrada. Nunca ejecuta `DELETE` (ADR-0004). */
  softDelete(id: TId, actorId: string | null): Promise<void>;
  restore(id: TId, actorId: string | null): Promise<TEntity>;
}

/** Repositorio con listado paginado y filtro tipado por recurso. */
export interface SearchableRepository<
  TEntity,
  TFilter,
  TSortField extends string = string,
  TId extends string = string,
> extends Repository<TEntity, TId> {
  search(
    filter: TFilter,
    page: PageRequest<TSortField>,
    options?: QueryOptions,
  ): Promise<Page<TEntity>>;
  count(filter: TFilter, options?: QueryOptions): Promise<number>;
}

/**
 * Unidad de trabajo.
 *
 * Necesaria en cuanto una operación toca varios agregados y debe ser atómica: facturar
 * escribe la factura, sus líneas, los movimientos de inventario y los cobros. Que la
 * factura quede emitida y el stock sin descontar no es un estado aceptable.
 *
 * El puerto no revela que por debajo hay una transacción de Prisma; podría ser cualquier
 * otra cosa.
 */
export interface UnitOfWork {
  execute<T>(work: () => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
