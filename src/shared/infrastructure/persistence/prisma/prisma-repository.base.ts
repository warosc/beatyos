import { DomainValidationError, EntityNotFoundError } from '../../../domain/errors';
import {
  buildPage,
  type Page,
  type PageRequest,
  type QueryOptions,
  type SortCriterion,
} from '../../../domain/ports/repository.port';
import type { Clock } from '../../../application/ports';
import type { PrismaService } from './prisma.service';
import { QueryScopeStore } from './query-scope';
import { withMappedErrors } from './prisma-error.mapper';

/**
 * Base de todos los repositorios Prisma.
 *
 * Aquí viven, escritas **una sola vez**, la paginación, la ordenación validada, el soft
 * delete, la restauración y la traducción de errores. Ese es el mecanismo concreto que
 * hace cumplir la regla "nunca generar código duplicado" del ADR-0002: sin esta clase,
 * cada uno de los quince repositorios tendría su propia copia de `skip`/`take` y su
 * propio `deletedAt: null`, y bastaría con que uno se desviara para tener un fallo
 * imposible de encontrar.
 *
 * Nótese lo que **no** está aquí: el `tenantId`. Lo pone la extensión de Prisma por
 * debajo (ADR-0003). Si estuviera aquí, un repositorio que no heredara de esta clase
 * quedaría desprotegido.
 */

/** Superficie mínima de un delegado de Prisma. Evita `any` en la clase genérica. */
interface PrismaDelegate<TModel> {
  findFirst(args: unknown): Promise<TModel | null>;
  findMany(args: unknown): Promise<TModel[]>;
  count(args: unknown): Promise<number>;
  create(args: unknown): Promise<TModel>;
  update(args: unknown): Promise<TModel>;
  updateMany(args: unknown): Promise<{ count: number }>;
}

export type OrderByClause = Record<string, unknown>;

export abstract class PrismaRepositoryBase<
  TEntity,
  TModel,
  TFilter,
  TSortField extends string = string,
> {
  protected constructor(
    protected readonly prisma: PrismaService,
    protected readonly clock: Clock,
  ) {}

  // -- Contrato que implementa cada repositorio concreto --------------------

  /** Nombre del delegado en el cliente de Prisma (`client`, `appointment`, ...). */
  protected abstract readonly delegateName: string;

  /** Nombre legible de la entidad, para los mensajes de error. */
  protected abstract readonly entityName: string;

  /**
   * Campos por los que se puede ordenar.
   *
   * Es una **lista blanca**, no una comodidad: sin ella, el parámetro `sort` de la URL
   * llegaría tal cual a la consulta. No es inyección SQL —Prisma parametriza— pero sí
   * permitiría ordenar por columnas que no deberían ser observables y provocar escaneos
   * completos sobre columnas sin índice a voluntad de cualquier cliente.
   */
  protected abstract readonly sortableFields: ReadonlyMap<
    TSortField,
    OrderByClause | OrderByClause[]
  >;

  protected abstract readonly defaultSort: readonly SortCriterion<TSortField>[];

  protected abstract toDomain(model: TModel): TEntity;

  /** Traduce el filtro tipado del recurso a un `where` de Prisma. */
  protected abstract buildWhere(filter: TFilter): Record<string, unknown>;

  // -- Acceso al delegado ---------------------------------------------------

  protected get delegate(): PrismaDelegate<TModel> {
    const client = this.prisma.client as unknown as Record<string, PrismaDelegate<TModel>>;
    const delegate = client[this.delegateName];
    if (!delegate) {
      throw new Error(
        `El modelo "${this.delegateName}" no existe en el cliente de Prisma. ` +
          '¿Falta ejecutar `prisma generate` tras cambiar el esquema?',
      );
    }
    return delegate;
  }

  // -- Lecturas -------------------------------------------------------------

  async findById(id: string, options?: QueryOptions): Promise<TEntity | null> {
    const model = await this.scoped(options, () =>
      withMappedErrors(this.entityName, () => this.delegate.findFirst({ where: { id } })),
    );
    return model ? this.toDomain(model) : null;
  }

  /**
   * Como `findById`, pero lanza si no existe.
   *
   * Existe porque el patrón `const x = await find(); if (!x) throw` aparecía en cada
   * caso de uso, y repetido veinte veces acaba divergiendo: uno lanza 404, otro devuelve
   * null y revienta más abajo con un `TypeError` incomprensible.
   */
  async findByIdOrFail(id: string, options?: QueryOptions): Promise<TEntity> {
    const entity = await this.findById(id, options);
    if (!entity) {
      throw new EntityNotFoundError(this.entityName, id);
    }
    return entity;
  }

  async exists(id: string, options?: QueryOptions): Promise<boolean> {
    const count = await this.scoped(options, () =>
      withMappedErrors(this.entityName, () => this.delegate.count({ where: { id } })),
    );
    return count > 0;
  }

  async count(filter: TFilter, options?: QueryOptions): Promise<number> {
    return this.scoped(options, () =>
      withMappedErrors(this.entityName, () =>
        this.delegate.count({ where: this.buildWhere(filter) }),
      ),
    );
  }

  /**
   * Listado paginado, ordenado y filtrado.
   *
   * El `count` y el `findMany` van en la misma transacción implícita de Prisma para que
   * el total y la página se lean de la misma instantánea. Si no, entre ambas consultas
   * puede insertarse una fila y el cliente recibe "20 de 137" habiendo 138: un salto
   * visible en la paginación de la interfaz.
   */
  async search(
    filter: TFilter,
    page: PageRequest<TSortField>,
    options?: QueryOptions,
  ): Promise<Page<TEntity>> {
    const where = this.buildWhere(filter);
    const orderBy = this.buildOrderBy(page.sort);
    const skip = (page.page - 1) * page.limit;

    const [total, models] = await this.scoped(options, () =>
      withMappedErrors(this.entityName, () =>
        Promise.all([
          this.delegate.count({ where }),
          this.delegate.findMany({ where, orderBy, skip, take: page.limit }),
        ]),
      ),
    );

    return buildPage(
      models.map((model) => this.toDomain(model)),
      total,
      page,
    );
  }

  // -- Escrituras -----------------------------------------------------------

  /**
   * Soft delete (ADR-0004).
   *
   * `updateMany` en lugar de `update` no es un capricho: `update` requiere una clave
   * única en el `where` y no admitiría el `tenantId` que inyecta la extensión, con lo
   * que el borrado ignoraría el ámbito de salón. Además, `updateMany` devuelve el
   * número de filas tocadas, que es como se detecta que el recurso no existía —o era de
   * otro inquilino— sin una consulta previa.
   */
  async softDelete(id: string, actorId: string | null): Promise<void> {
    const now = this.clock.now();
    const result = await withMappedErrors(this.entityName, () =>
      this.delegate.updateMany({
        where: { id },
        data: { deletedAt: now, deletedBy: actorId, updatedAt: now, updatedBy: actorId },
      }),
    );

    if (result.count === 0) {
      throw new EntityNotFoundError(this.entityName, id);
    }
  }

  /** Deshace un soft delete. Requiere mirar entre las filas borradas, de ahí el ámbito. */
  async restore(id: string, actorId: string | null): Promise<TEntity> {
    const now = this.clock.now();

    return QueryScopeStore.includingDeleted(async () => {
      const result = await withMappedErrors(this.entityName, () =>
        this.delegate.updateMany({
          where: { id, deletedAt: { not: null } },
          data: { deletedAt: null, deletedBy: null, updatedAt: now, updatedBy: actorId },
        }),
      );

      if (result.count === 0) {
        // Sin registro borrado con ese id: o no existe, o nunca se borró. Ambos casos
        // son "no hay nada que restaurar" desde el punto de vista del usuario.
        throw new EntityNotFoundError(`${this.entityName} eliminado`, id);
      }

      return this.findByIdOrFail(id);
    });
  }

  // -- Auxiliares protegidos ------------------------------------------------

  /**
   * Traduce criterios de ordenación validándolos contra la lista blanca.
   *
   * Un campo desconocido lanza en vez de ignorarse: ordenar por algo distinto de lo
   * pedido, en silencio, produce un informe de error del tipo "los datos salen
   * desordenados" que cuesta días localizar.
   */
  protected buildOrderBy(sort?: readonly SortCriterion<TSortField>[]): OrderByClause[] {
    const criteria = sort?.length ? sort : this.defaultSort;

    return criteria.flatMap(({ field, direction }) => {
      const mapping = this.sortableFields.get(field);
      if (!mapping) {
        throw new DomainValidationError(
          `No se puede ordenar por "${field}". Campos admitidos: ${[...this.sortableFields.keys()].join(', ')}`,
          'sort',
        );
      }
      // Un campo lógico puede expandirse a varias columnas: ordenar por "nombre"
      // significa apellidos y luego nombre, como en cualquier listado de personas.
      const clauses = Array.isArray(mapping) ? mapping : [mapping];
      return clauses.map((clause) => this.applyDirection(clause, direction));
    });
  }

  private applyDirection(clause: OrderByClause, direction: 'asc' | 'desc'): OrderByClause {
    return Object.fromEntries(
      Object.entries(clause).map(([key, value]) => [
        key,
        // Permite mapeos anidados (`{ client: { lastName: true } }`) sin repetir la
        // dirección en cada nivel.
        value === true ? direction : this.applyDirection(value as OrderByClause, direction),
      ]),
    );
  }

  /**
   * Ejecuta la consulta con el ambito de borrados que corresponda.
   *
   * `protected` y no `private`: los repositorios que necesitan `include` propios
   * sobrescriben `findById` o `search`, y deben poder respetar el mismo ambito sin
   * reimplementarlo.
   */
  protected scoped<T>(options: QueryOptions | undefined, work: () => Promise<T>): Promise<T> {
    return options?.includeDeleted ? QueryScopeStore.includingDeleted(work) : work();
  }

  /** Fragmento de auditoría para una creación (ADR-0004). */
  protected auditOnCreate(actorId: string | null): Record<string, unknown> {
    const now = this.clock.now();
    return { createdAt: now, updatedAt: now, createdBy: actorId, updatedBy: actorId };
  }

  /** Fragmento de auditoría para una modificación. */
  protected auditOnUpdate(actorId: string | null): Record<string, unknown> {
    return { updatedAt: this.clock.now(), updatedBy: actorId };
  }

  /**
   * Construye un filtro de búsqueda por texto insensible a mayúsculas.
   *
   * Devuelve `undefined` para una búsqueda vacía, en lugar de `contains: ''`, que
   * casaría con todo y haría un escaneo completo por nada.
   */
  protected textSearch(term: string | undefined, fields: readonly string[]): object | undefined {
    const value = term?.trim();
    if (!value) return undefined;
    return {
      OR: fields.map((field) => ({ [field]: { contains: value, mode: 'insensitive' } })),
    };
  }

  /** Compone un `where` descartando las condiciones no aplicables. */
  protected compose(...conditions: (object | undefined | null | false)[]): Record<string, unknown> {
    const active = conditions.filter((c): c is object => Boolean(c));
    if (active.length === 0) return {};
    if (active.length === 1) return active[0] as Record<string, unknown>;
    return { AND: active };
  }

  /** Rango cerrado por arriba y por abajo, omitiendo los extremos no informados. */
  protected dateRange(from?: Date, to?: Date): object | undefined {
    if (!from && !to) return undefined;
    return { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }
}
