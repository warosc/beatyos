import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Category as CategoryRow, Prisma } from '@prisma/client';

import { CLOCK, type Clock } from '../../../../shared/application/ports';
import { EntityNotFoundError } from '../../../../shared/domain/errors';
import {
  buildPage,
  type Page,
  type PageRequest,
  type QueryOptions,
} from '../../../../shared/domain/ports/repository.port';
import { Money } from '../../../../shared/domain/value-objects/money.vo';
import { Percentage } from '../../../../shared/domain/value-objects/time-range.vo';
import type { Env } from '../../../../shared/infrastructure/config/env.schema';
import { withMappedErrors } from '../../../../shared/infrastructure/persistence/prisma/prisma-error.mapper';
import {
  PrismaRepositoryBase,
  type OrderByClause,
} from '../../../../shared/infrastructure/persistence/prisma/prisma-repository.base';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import { QueryScopeStore } from '../../../../shared/infrastructure/persistence/prisma/query-scope';
import { Category, type CategoryKindValue } from '../../domain/category.entity';
import type {
  CategoryFilter,
  CategoryRepository,
  CategorySortField,
  ServiceFilter,
  ServiceRepository,
  ServiceSortField,
} from '../../domain/catalog.repositories';
import { Service } from '../../domain/service.entity';

const SERVICE_INCLUDE = { consumables: true } satisfies Prisma.ServiceInclude;
type ServiceWithConsumables = Prisma.ServiceGetPayload<{ include: typeof SERVICE_INCLUDE }>;

/**
 * Adaptador Prisma de servicios.
 *
 * Hereda de `PrismaRepositoryBase` toda la mecánica común y solo añade lo propio: el
 * escandallo, la carga en lote para la agenda y el mapeo de `Decimal` a `Money`.
 */
@Injectable()
export class PrismaServiceRepository
  extends PrismaRepositoryBase<Service, ServiceWithConsumables, ServiceFilter, ServiceSortField>
  implements ServiceRepository
{
  private readonly currency: string;

  constructor(
    prisma: PrismaService,
    @Inject(CLOCK) clock: Clock,
    config: ConfigService<Env, true>,
  ) {
    super(prisma, clock);
    this.currency = config.get('DEFAULT_CURRENCY', { infer: true });
  }

  protected readonly delegateName = 'service';
  protected readonly entityName = 'Servicio';

  protected readonly sortableFields: ReadonlyMap<
    ServiceSortField,
    OrderByClause | OrderByClause[]
  > = new Map<ServiceSortField, OrderByClause | OrderByClause[]>([
    ['name', { name: true }],
    ['code', { code: true }],
    ['price', { price: true }],
    ['durationMinutes', { durationMinutes: true }],
    // El orden del catálogo lo fija el salón; el nombre desempata para que la lista sea
    // estable entre peticiones y la interfaz no baile.
    ['sortOrder', [{ sortOrder: true }, { name: true }]],
    ['createdAt', { createdAt: true }],
  ]);

  protected readonly defaultSort = [{ field: 'sortOrder' as const, direction: 'asc' as const }];

  override async findById(id: string, options?: QueryOptions): Promise<Service | null> {
    const row = await this.scoped(options, () =>
      withMappedErrors(this.entityName, () =>
        this.prisma.client.service.findFirst({ where: { id }, include: SERVICE_INCLUDE }),
      ),
    );
    return row ? this.toDomain(row) : null;
  }

  async findByCode(code: string, options?: QueryOptions): Promise<Service | null> {
    const find = () =>
      withMappedErrors(this.entityName, () =>
        this.prisma.client.service.findFirst({
          where: { code: code.trim().toUpperCase() },
          include: SERVICE_INCLUDE,
        }),
      );

    const row = options?.includeDeleted
      ? await QueryScopeStore.includingDeleted(find)
      : await find();

    return row ? this.toDomain(row) : null;
  }

  async findManyByIds(ids: readonly string[]): Promise<Service[]> {
    if (ids.length === 0) return [];

    const rows = await withMappedErrors(this.entityName, () =>
      this.prisma.client.service.findMany({
        where: { id: { in: [...ids] } },
        include: SERVICE_INCLUDE,
      }),
    );

    return rows.map((row) => this.toDomain(row));
  }

  override async search(
    filter: ServiceFilter,
    page: PageRequest<ServiceSortField>,
    options?: QueryOptions,
  ): Promise<Page<Service>> {
    const where = this.buildWhere(filter);
    const orderBy = this.buildOrderBy(page.sort);

    const [total, rows] = await this.scoped(options, () =>
      withMappedErrors(this.entityName, () =>
        Promise.all([
          this.prisma.client.service.count({ where }),
          this.prisma.client.service.findMany({
            where,
            orderBy,
            skip: (page.page - 1) * page.limit,
            take: page.limit,
            include: SERVICE_INCLUDE,
          }),
        ]),
      ),
    );

    return buildPage(
      rows.map((row) => this.toDomain(row)),
      total,
      page,
    );
  }

  async create(service: Service): Promise<Service> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.service.create({
        data: {
          id: service.id,
          tenantId: service.tenantId,
          ...this.toPersistence(service),
          createdAt: service.audit.createdAt,
          updatedAt: service.audit.updatedAt,
          createdBy: service.audit.createdBy,
          updatedBy: service.audit.updatedBy,
        },
        include: SERVICE_INCLUDE,
      }),
    );
    return this.toDomain(row);
  }

  async update(service: Service): Promise<Service> {
    return this.prisma.transaction(async () => {
      const result = await withMappedErrors(this.entityName, () =>
        this.prisma.client.service.updateMany({
          where: { id: service.id },
          data: {
            ...this.toPersistence(service),
            updatedAt: service.audit.updatedAt,
            updatedBy: service.audit.updatedBy,
          },
        }),
      );

      if (result.count === 0) {
        throw new EntityNotFoundError(this.entityName, service.id);
      }

      await this.prisma.client.serviceConsumable.deleteMany({ where: { serviceId: service.id } });
      if (service.consumables.length > 0) {
        // `tenantId` explícito: `createMany` no pasa por la extensión que lo inyecta.
        await this.prisma.client.serviceConsumable.createMany({
          data: service.consumables.map((item) => ({
            tenantId: service.tenantId,
            serviceId: service.id,
            productId: item.productId,
            quantity: item.quantity.toFixed(3),
          })),
        });
      }

      const row = await this.prisma.client.service.findFirst({
        where: { id: service.id },
        include: SERVICE_INCLUDE,
      });

      if (!row) throw new EntityNotFoundError(this.entityName, service.id);
      return this.toDomain(row);
    });
  }

  async save(service: Service): Promise<Service> {
    return this.update(service);
  }

  protected buildWhere(filter: ServiceFilter): Record<string, unknown> {
    return this.compose(
      this.textSearch(filter.search, ['name', 'code', 'description']),
      filter.categoryId ? { categoryId: filter.categoryId } : undefined,
      filter.isActive !== undefined ? { isActive: filter.isActive } : undefined,
      filter.bookableOnline !== undefined ? { isBookableOnline: filter.bookableOnline } : undefined,
      filter.maxDurationMinutes !== undefined
        ? { durationMinutes: { lte: filter.maxDurationMinutes } }
        : undefined,
    );
  }

  private toPersistence(service: Service) {
    return {
      categoryId: service.categoryId,
      code: service.code,
      name: service.name,
      description: service.description,
      durationMinutes: service.durationMinutes,
      bufferMinutes: service.bufferMinutes,
      price: service.price.toDecimalString(),
      currency: service.price.currency,
      taxRate: service.taxRate.value.toFixed(2),
      commissionRate: service.commissionRate?.value.toFixed(2) ?? null,
      isActive: service.isActive,
      isBookableOnline: service.isBookableOnline,
      color: service.color,
      sortOrder: service.sortOrder,
      deletedAt: service.audit.deletedAt,
      deletedBy: service.audit.deletedBy,
    };
  }

  protected toDomain(row: ServiceWithConsumables): Service {
    return Service.rehydrate(row.id, {
      tenantId: row.tenantId,
      categoryId: row.categoryId,
      code: row.code,
      name: row.name,
      description: row.description,
      durationMinutes: row.durationMinutes,
      bufferMinutes: row.bufferMinutes,
      // `toFixed(2)` sobre el `Decimal` de Prisma: pasar por `Number` reintroduciría la
      // coma flotante que `Money` existe para evitar (ADR-0010).
      price: Money.fromDecimal(row.price.toFixed(2), row.currency || this.currency),
      taxRate: Percentage.create(Number(row.taxRate)),
      commissionRate:
        row.commissionRate === null ? null : Percentage.create(Number(row.commissionRate)),
      isActive: row.isActive,
      isBookableOnline: row.isBookableOnline,
      color: row.color,
      sortOrder: row.sortOrder,
      consumables: row.consumables.map((item) => ({
        productId: item.productId,
        quantity: Number(item.quantity),
      })),
      audit: {
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deletedAt: row.deletedAt,
        createdBy: row.createdBy,
        updatedBy: row.updatedBy,
        deletedBy: row.deletedBy,
      },
    });
  }
}

// ---------------------------------------------------------------------------

@Injectable()
export class PrismaCategoryRepository
  extends PrismaRepositoryBase<Category, CategoryRow, CategoryFilter, CategorySortField>
  implements CategoryRepository
{
  constructor(prisma: PrismaService, @Inject(CLOCK) clock: Clock) {
    super(prisma, clock);
  }

  protected readonly delegateName = 'category';
  protected readonly entityName = 'Categoría';

  protected readonly sortableFields: ReadonlyMap<
    CategorySortField,
    OrderByClause | OrderByClause[]
  > = new Map<CategorySortField, OrderByClause | OrderByClause[]>([
    ['name', { name: true }],
    ['sortOrder', [{ sortOrder: true }, { name: true }]],
    ['createdAt', { createdAt: true }],
  ]);

  protected readonly defaultSort = [{ field: 'sortOrder' as const, direction: 'asc' as const }];

  /**
   * Cadena de ascendientes, de la raíz hacia abajo.
   *
   * Se recorre en bucle y no con una CTE recursiva a propósito: el árbol tiene como mucho
   * tres niveles (`MAX_CATEGORY_DEPTH`), así que son tres consultas triviales por índice
   * primario frente al coste de mantener SQL crudo que además tendría que filtrar el
   * `tenantId` a mano.
   *
   * El tope de iteraciones protege frente a un ciclo que ya estuviera en la base —creado
   * por una importación o por SQL directo—: sin él, este bucle no terminaría nunca.
   */
  async findAncestorIds(categoryId: string): Promise<string[]> {
    const ancestors: string[] = [];
    let currentId: string | null = categoryId;

    for (let depth = 0; depth < 10 && currentId !== null; depth += 1) {
      const row: { parentId: string | null } | null = await this.prisma.client.category.findFirst({
        where: { id: currentId },
        select: { parentId: true },
      });

      if (!row?.parentId) break;

      ancestors.unshift(row.parentId);
      currentId = row.parentId;
    }

    return ancestors;
  }

  async hasChildren(categoryId: string): Promise<boolean> {
    const [subcategories, services, products] = await Promise.all([
      this.prisma.client.category.count({ where: { parentId: categoryId } }),
      this.prisma.client.service.count({ where: { categoryId } }),
      this.prisma.client.product.count({ where: { categoryId } }),
    ]);

    return subcategories + services + products > 0;
  }

  async findTree(kind: CategoryKindValue): Promise<Category[]> {
    // Una sola consulta para todo el árbol: son decenas de filas y el cliente arma la
    // jerarquía. Pedirlo nivel a nivel serían tantas consultas como profundidad.
    const rows = await withMappedErrors(this.entityName, () =>
      this.prisma.client.category.findMany({
        where: { kind },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    );

    return rows.map((row) => this.toDomain(row));
  }

  async create(category: Category): Promise<Category> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.category.create({
        data: {
          id: category.id,
          tenantId: category.tenantId,
          ...this.toPersistence(category),
          createdAt: category.audit.createdAt,
          updatedAt: category.audit.updatedAt,
          createdBy: category.audit.createdBy,
          updatedBy: category.audit.updatedBy,
        },
      }),
    );
    return this.toDomain(row);
  }

  async update(category: Category): Promise<Category> {
    const result = await withMappedErrors(this.entityName, () =>
      this.prisma.client.category.updateMany({
        where: { id: category.id },
        data: {
          ...this.toPersistence(category),
          updatedAt: category.audit.updatedAt,
          updatedBy: category.audit.updatedBy,
        },
      }),
    );

    if (result.count === 0) {
      throw new EntityNotFoundError(this.entityName, category.id);
    }

    return this.findByIdOrFail(category.id);
  }

  async save(category: Category): Promise<Category> {
    return this.update(category);
  }

  protected buildWhere(filter: CategoryFilter): Record<string, unknown> {
    return this.compose(
      this.textSearch(filter.search, ['name', 'slug', 'description']),
      filter.kind ? { kind: filter.kind } : undefined,
      // `null` significa «solo raíces», que es distinto de «no filtrar por padre».
      filter.parentId !== undefined ? { parentId: filter.parentId } : undefined,
      filter.isActive !== undefined ? { isActive: filter.isActive } : undefined,
    );
  }

  private toPersistence(category: Category) {
    return {
      kind: category.kind,
      name: category.name,
      slug: category.slug,
      description: category.description,
      color: category.color,
      parentId: category.parentId,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
      deletedAt: category.audit.deletedAt,
      deletedBy: category.audit.deletedBy,
    };
  }

  protected toDomain(row: CategoryRow): Category {
    return Category.rehydrate(row.id, {
      tenantId: row.tenantId,
      kind: row.kind,
      name: row.name,
      slug: row.slug,
      description: row.description,
      color: row.color,
      parentId: row.parentId,
      sortOrder: row.sortOrder,
      isActive: row.isActive,
      audit: {
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deletedAt: row.deletedAt,
        createdBy: row.createdBy,
        updatedBy: row.updatedBy,
        deletedBy: row.deletedBy,
      },
    });
  }
}
