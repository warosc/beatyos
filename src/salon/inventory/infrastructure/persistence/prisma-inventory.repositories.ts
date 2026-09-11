import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  InventoryMovement as MovementRow,
  Prisma,
  ProductBatch as BatchRow,
  Product as ProductRow,
} from '@prisma/client';

import { CLOCK, type Clock } from '../../../../shared/application/ports';
import { BusinessRuleViolationError, EntityNotFoundError } from '../../../../shared/domain/errors';
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
import { Batch } from '../../domain/batch.entity';
import { InventoryMovement } from '../../domain/inventory-movement.entity';
import type {
  BatchFilter,
  BatchRepository,
  BatchSortField,
  MovementFilter,
  MovementRepository,
  MovementSortField,
  ProductFilter,
  ProductRepository,
  ProductSortField,
} from '../../domain/inventory.repositories';
import { Product } from '../../domain/product.entity';

/** Tolerancia de comparación: las cantidades llevan tres decimales en la base. */
const QUANTITY_EPSILON = 0.0005;

// ===========================================================================
// Productos
// ===========================================================================

@Injectable()
export class PrismaProductRepository
  extends PrismaRepositoryBase<Product, ProductRow, ProductFilter, ProductSortField>
  implements ProductRepository
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

  protected readonly delegateName = 'product';
  protected readonly entityName = 'Producto';

  protected readonly sortableFields: ReadonlyMap<
    ProductSortField,
    OrderByClause | OrderByClause[]
  > = new Map<ProductSortField, OrderByClause | OrderByClause[]>([
    ['name', { name: true }],
    ['sku', { sku: true }],
    ['price', { price: true }],
    ['stockOnHand', { stockOnHand: true }],
    ['createdAt', { createdAt: true }],
  ]);

  protected readonly defaultSort = [{ field: 'name' as const, direction: 'asc' as const }];

  async findBySku(sku: string, options?: QueryOptions): Promise<Product | null> {
    const find = () =>
      withMappedErrors(this.entityName, () =>
        this.prisma.client.product.findFirst({ where: { sku: sku.trim().toUpperCase() } }),
      );

    const row = options?.includeDeleted
      ? await QueryScopeStore.includingDeleted(find)
      : await find();
    return row ? this.toDomain(row) : null;
  }

  async findByBarcode(barcode: string, options?: QueryOptions): Promise<Product | null> {
    const row = await this.scoped(options, () =>
      withMappedErrors(this.entityName, () =>
        this.prisma.client.product.findFirst({ where: { barcode: barcode.trim() } }),
      ),
    );
    return row ? this.toDomain(row) : null;
  }

  async findManyByIds(ids: readonly string[]): Promise<Product[]> {
    if (ids.length === 0) return [];

    const rows = await withMappedErrors(this.entityName, () =>
      this.prisma.client.product.findMany({ where: { id: { in: [...ids] } } }),
    );

    return rows.map((row) => this.toDomain(row));
  }

  /**
   * Variación atómica de existencias.
   *
   * `updateMany` con la condición dentro del `where` y el incremento relativo dentro del
   * `data` compila a un único `UPDATE ... SET "stockOnHand" = "stockOnHand" + $1 WHERE id =
   * $2 AND "stockOnHand" >= $3`. Ese `WHERE` es lo que hace que la comprobación y la
   * escritura ocurran en la misma sentencia, bajo el mismo bloqueo de fila, sin ventana
   * entre una y otra.
   *
   * Con el patrón anterior —leer, sumar en JavaScript, escribir el total— dos recepciones
   * simultáneas leían el mismo stock de partida y la segunda pisaba a la primera: una caja
   * entera desaparecía del sistema sin dejar rastro. El ledger la registraba y la caché no,
   * de modo que el error solo salía a la luz en el recuento físico.
   *
   * `count === 0` no distingue «no existe» de «no había bastante», así que se consulta
   * después para dar el mensaje correcto. Es una consulta extra únicamente en el camino de
   * error, que no es el caliente.
   */
  async applyStockDelta(productId: string, delta: number, actorId: string | null): Promise<number> {
    const now = this.clock.now();
    const rounded = round3(delta);

    const result = await withMappedErrors(this.entityName, () =>
      this.prisma.client.product.updateMany({
        where: {
          id: productId,
          // Solo para las salidas: exigir `stockOnHand >= 0` en una entrada sería
          // redundante, y en un producto con stock negativo heredado impediría corregirlo.
          ...(rounded < 0 ? { stockOnHand: { gte: Math.abs(rounded) } } : {}),
        },
        data: {
          stockOnHand: { increment: rounded },
          updatedAt: now,
          updatedBy: actorId,
        },
      }),
    );

    if (result.count === 0) {
      const current = await this.prisma.client.product.findFirst({
        where: { id: productId },
        select: { name: true, stockOnHand: true },
      });

      if (!current) throw new EntityNotFoundError(this.entityName, productId);

      throw new BusinessRuleViolationError(
        'INSUFFICIENT_STOCK',
        `Existencias insuficientes de ${current.name}: hay ${current.stockOnHand.toFixed(3)} y se piden ${Math.abs(rounded)}`,
        {
          productId,
          available: Number(current.stockOnHand),
          requested: Math.abs(rounded),
        },
      );
    }

    const updated = await this.prisma.client.product.findFirst({
      where: { id: productId },
      select: { stockOnHand: true },
    });

    if (!updated) throw new EntityNotFoundError(this.entityName, productId);
    return Number(updated.stockOnHand);
  }

  async create(product: Product): Promise<Product> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.product.create({
        data: {
          id: product.id,
          tenantId: product.tenantId,
          sku: product.sku,
          stockOnHand: product.stockOnHand.toFixed(3),
          ...this.toPersistence(product),
          createdAt: product.audit.createdAt,
          updatedAt: product.audit.updatedAt,
          createdBy: product.audit.createdBy,
          updatedBy: product.audit.updatedBy,
        },
      }),
    );
    return this.toDomain(row);
  }

  /** Guarda todo menos `stockOnHand`. El motivo está en el puerto. */
  async update(product: Product): Promise<Product> {
    const result = await withMappedErrors(this.entityName, () =>
      this.prisma.client.product.updateMany({
        where: { id: product.id },
        data: {
          ...this.toPersistence(product),
          updatedAt: product.audit.updatedAt,
          updatedBy: product.audit.updatedBy,
        },
      }),
    );

    if (result.count === 0) {
      throw new EntityNotFoundError(this.entityName, product.id);
    }

    return this.findByIdOrFail(product.id, { includeDeleted: product.isDeleted });
  }

  async save(product: Product): Promise<Product> {
    return this.update(product);
  }

  /**
   * Recupera un producto dado de baja **y vuelve a activarlo**.
   *
   * La clase base limpia `deletedAt` con un `updateMany` y ahi se queda, porque no puede
   * saber que en este agregado dar de baja implica ademas desactivar. Sin este paso el
   * producto reaparece en el catalogo pero sigue sin poder venderse, que es peor que no
   * recuperarlo: nadie lo nota hasta que alguien intenta cobrarlo.
   *
   * La reactivacion la decide el dominio —`markRestored`— y no un `data: { isActive: true }`
   * escrito aqui: si manana recuperar exigiera algo mas, el sitio donde anadirlo es la
   * entidad, y este adaptador seguiria valiendo sin tocarlo.
   */
  override async restore(id: string, actorId: string | null): Promise<Product> {
    const product = await super.restore(id, actorId);
    product.markRestored(this.clock.now(), actorId);
    return this.update(product);
  }

  /**
   * Productos en o por debajo del punto de pedido.
   *
   * La condición compara dos columnas de la misma fila, y se expresa con una referencia de
   * campo de Prisma en lugar de con SQL crudo. La diferencia no es de estilo: el SQL crudo
   * **no pasa por la extensión** que inyecta el `tenantId` y filtra los borrados (ADR-0003),
   * de modo que una consulta cruda aquí devolvería los productos de todos los salones salvo
   * que alguien se acordara de filtrarlo a mano cada vez.
   */
  async findBelowReorderPoint(): Promise<Product[]> {
    const rows = await withMappedErrors(this.entityName, () =>
      this.prisma.client.product.findMany({
        where: {
          isActive: true,
          trackStock: true,
          stockOnHand: { lte: this.reorderPointField() },
        },
        orderBy: [{ stockOnHand: 'asc' }, { name: 'asc' }],
        take: 200,
      }),
    );

    return rows.map((row) => this.toDomain(row));
  }

  protected buildWhere(filter: ProductFilter): Record<string, unknown> {
    return this.compose(
      this.textSearch(filter.search, ['name', 'sku', 'barcode', 'brand']),
      filter.categoryId ? { categoryId: filter.categoryId } : undefined,
      filter.isActive !== undefined ? { isActive: filter.isActive } : undefined,
      filter.isRetail !== undefined ? { isRetail: filter.isRetail } : undefined,
      filter.isInternal !== undefined ? { isInternal: filter.isInternal } : undefined,
      filter.tracksBatches !== undefined ? { tracksBatches: filter.tracksBatches } : undefined,
      this.stockFilter(filter.stock),
    );
  }

  /**
   * Traduce el semáforo de existencias a un `where`.
   *
   * El filtro se resuelve **en la base de datos**. La versión anterior de este módulo se
   * traía todos los productos y los filtraba en JavaScript con un `.filter()`, lo que hacía
   * que la pantalla de inventario fuese más lenta con cada alta y que la paginación diera
   * totales que no correspondían con lo que se veía.
   *
   * `LOW` incluye el punto de pedido: estar justo en el mínimo ya es motivo de reposición,
   * porque el mínimo es lo que hace falta para aguantar hasta que llegue el pedido.
   */
  private stockFilter(stock: ProductFilter['stock']): object | undefined {
    if (!stock) return undefined;

    if (stock === 'OUT') return { stockOnHand: { lte: QUANTITY_EPSILON } };

    if (stock === 'LOW') {
      return {
        AND: [
          { stockOnHand: { gt: QUANTITY_EPSILON } },
          { stockOnHand: { lte: this.reorderPointField() } },
        ],
      };
    }

    return { stockOnHand: { gt: this.reorderPointField() } };
  }

  /**
   * Referencia a la columna `reorderPoint` para compararla con otra columna.
   *
   * Prisma la tipa como `FieldRef`, que solo encaja en el `where` del propio modelo. Se
   * aísla en un método porque el acceso a `.fields` no sobrevive al tipado del cliente
   * extendido y hace falta un puente puntual; concentrarlo evita repetir la aserción en
   * cada sitio donde se compara con el punto de pedido.
   */
  private reorderPointField(): Prisma.DecimalFieldRefInput<'Product'> {
    const delegate = this.prisma.client.product as unknown as {
      fields: { reorderPoint: Prisma.DecimalFieldRefInput<'Product'> };
    };
    return delegate.fields.reorderPoint;
  }

  private toPersistence(product: Product) {
    return {
      categoryId: product.categoryId,
      barcode: product.barcode,
      name: product.name,
      description: product.description,
      brand: product.brand,
      price: product.price.toDecimalString(),
      costPrice: product.costPrice.toDecimalString(),
      currency: product.price.currency,
      taxRate: product.taxRate.value.toFixed(2),
      unit: product.unit,
      reorderPoint: product.reorderPoint.toFixed(3),
      reorderQuantity: product.reorderQuantity.toFixed(3),
      isRetail: product.isRetail,
      isInternal: product.isInternal,
      isActive: product.isActive,
      trackStock: product.trackStock,
      tracksBatches: product.tracksBatches,
      deletedAt: product.audit.deletedAt,
      deletedBy: product.audit.deletedBy,
    };
  }

  protected toDomain(row: ProductRow): Product {
    // `toFixed` sobre el `Decimal` de Prisma, nunca `Number`: pasar el importe por coma
    // flotante reintroduce exactamente el error que `Money` existe para evitar (ADR-0010).
    const currency = row.currency || this.currency;

    return Product.rehydrate(row.id, {
      tenantId: row.tenantId,
      categoryId: row.categoryId,
      sku: row.sku,
      barcode: row.barcode,
      name: row.name,
      description: row.description,
      brand: row.brand,
      price: Money.fromDecimal(row.price.toFixed(2), currency),
      costPrice: Money.fromDecimal(row.costPrice.toFixed(2), currency),
      taxRate: Percentage.create(Number(row.taxRate)),
      unit: row.unit,
      // Las cantidades sí son `number`: no son dinero, la columna tiene tres decimales y
      // el dominio redondea a esa misma precisión en cada operación.
      stockOnHand: Number(row.stockOnHand),
      reorderPoint: Number(row.reorderPoint),
      reorderQuantity: Number(row.reorderQuantity),
      isRetail: row.isRetail,
      isInternal: row.isInternal,
      isActive: row.isActive,
      trackStock: row.trackStock,
      tracksBatches: row.tracksBatches,
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

// ===========================================================================
// Lotes
// ===========================================================================

@Injectable()
export class PrismaBatchRepository
  extends PrismaRepositoryBase<Batch, BatchRow, BatchFilter, BatchSortField>
  implements BatchRepository
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

  protected readonly delegateName = 'productBatch';
  protected readonly entityName = 'Lote';

  protected readonly sortableFields: ReadonlyMap<BatchSortField, OrderByClause | OrderByClause[]> =
    new Map<BatchSortField, OrderByClause | OrderByClause[]>([
      // Orden FEFO: primero lo que vence. El desempate por recepción lo hace determinista.
      ['expiresAt', [{ expiresAt: true }, { receivedAt: true }]],
      ['receivedAt', { receivedAt: true }],
      ['batchNumber', { batchNumber: true }],
      ['remainingQuantity', { remainingQuantity: true }],
    ]);

  protected readonly defaultSort = [{ field: 'expiresAt' as const, direction: 'asc' as const }];

  async findByNumber(
    productId: string,
    batchNumber: string,
    options?: QueryOptions,
  ): Promise<Batch | null> {
    const row = await this.scoped(options, () =>
      withMappedErrors(this.entityName, () =>
        this.prisma.client.productBatch.findFirst({
          where: { productId, batchNumber: batchNumber.trim() },
        }),
      ),
    );
    return row ? this.toDomain(row) : null;
  }

  async findManyByIds(ids: readonly string[]): Promise<Batch[]> {
    if (ids.length === 0) return [];

    const rows = await withMappedErrors(this.entityName, () =>
      this.prisma.client.productBatch.findMany({ where: { id: { in: [...ids] } } }),
    );

    return rows.map((row) => this.toDomain(row));
  }

  /**
   * Lotes con existencias de un producto, en orden FEFO.
   *
   * El `ORDER BY` coincide con `product_batches_fefo_idx`, que es un índice parcial sobre
   * los lotes con cantidad: en un salón con unos meses de vida la mayoría están agotados y
   * no tiene sentido pasearlos en cada consulta.
   *
   * Devuelve también los caducados. Filtrarlos aquí parecería más limpio y sería un error:
   * `StockAllocationService` los necesita para distinguir «no hay» de «hay pero está
   * caducado», que son dos problemas distintos y con soluciones distintas (ADR-0012).
   */
  async findConsumable(productId: string): Promise<Batch[]> {
    const rows = await withMappedErrors(this.entityName, () =>
      this.prisma.client.productBatch.findMany({
        where: { productId, remainingQuantity: { gt: 0 } },
        orderBy: [{ expiresAt: 'asc' }, { receivedAt: 'asc' }],
      }),
    );
    return rows.map((row) => this.toDomain(row));
  }

  /**
   * Descuenta de un lote de forma atómica.
   *
   * Mismo mecanismo que `applyStockDelta`: la condición `remainingQuantity >= cantidad`
   * viaja dentro del `UPDATE`, de modo que dos consumos simultáneos del mismo lote no
   * pueden pasar los dos. El `CHECK` de la tabla sigue ahí como última red, pero llegar a
   * él devolvería un error de restricción en vez de un mensaje que se entienda.
   */
  async consume(batchId: string, quantity: number, actorId: string | null): Promise<number> {
    const rounded = round3(quantity);
    const now = this.clock.now();

    const result = await withMappedErrors(this.entityName, () =>
      this.prisma.client.productBatch.updateMany({
        where: { id: batchId, remainingQuantity: { gte: rounded } },
        data: {
          remainingQuantity: { decrement: rounded },
          updatedAt: now,
          updatedBy: actorId,
        },
      }),
    );

    if (result.count === 0) {
      const current = await this.prisma.client.productBatch.findFirst({
        where: { id: batchId },
        select: { batchNumber: true, remainingQuantity: true },
      });

      if (!current) throw new EntityNotFoundError(this.entityName, batchId);

      throw new BusinessRuleViolationError(
        'INSUFFICIENT_BATCH_QUANTITY',
        `El lote ${current.batchNumber} solo tiene ${current.remainingQuantity.toFixed(3)} unidades`,
        {
          batchId,
          available: Number(current.remainingQuantity),
          requested: rounded,
        },
      );
    }

    return this.remainingOf(batchId);
  }

  /** Devuelve producto al lote. El tope —lo recibido— lo garantiza el `CHECK` de la tabla. */
  async restock(batchId: string, quantity: number, actorId: string | null): Promise<number> {
    const rounded = round3(quantity);
    const batch = await this.findByIdOrFail(batchId);

    // La comprobación va aquí además de en el `CHECK` para poder decir *qué* lote y
    // *cuánto* entró; la restricción de la base solo diría que la fila no es válida.
    batch.restock(rounded, this.clock.now(), actorId);

    await withMappedErrors(this.entityName, () =>
      this.prisma.client.productBatch.updateMany({
        where: { id: batchId },
        data: {
          remainingQuantity: { increment: rounded },
          updatedAt: this.clock.now(),
          updatedBy: actorId,
        },
      }),
    );

    return this.remainingOf(batchId);
  }

  async create(batch: Batch): Promise<Batch> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.productBatch.create({
        data: {
          id: batch.id,
          tenantId: batch.tenantId,
          productId: batch.productId,
          batchNumber: batch.batchNumber,
          receivedAt: batch.receivedAt,
          ...this.toPersistence(batch),
          createdAt: batch.audit.createdAt,
          updatedAt: batch.audit.updatedAt,
          createdBy: batch.audit.createdBy,
          updatedBy: batch.audit.updatedBy,
        },
      }),
    );
    return this.toDomain(row);
  }

  async update(batch: Batch): Promise<Batch> {
    const result = await withMappedErrors(this.entityName, () =>
      this.prisma.client.productBatch.updateMany({
        where: { id: batch.id },
        data: {
          ...this.toPersistence(batch),
          updatedAt: batch.audit.updatedAt,
          updatedBy: batch.audit.updatedBy,
        },
      }),
    );

    if (result.count === 0) {
      throw new EntityNotFoundError(this.entityName, batch.id);
    }

    return this.findByIdOrFail(batch.id, { includeDeleted: batch.isDeleted });
  }

  async save(batch: Batch): Promise<Batch> {
    return this.update(batch);
  }

  async findExpiringWithin(days: number, now: Date): Promise<Batch[]> {
    const limit = new Date(now.getTime() + days * 86_400_000);

    const rows = await withMappedErrors(this.entityName, () =>
      this.prisma.client.productBatch.findMany({
        where: { remainingQuantity: { gt: 0 }, expiresAt: { not: null, lte: limit } },
        orderBy: [{ expiresAt: 'asc' }, { receivedAt: 'asc' }],
        take: 200,
      }),
    );

    return rows.map((row) => this.toDomain(row));
  }

  protected buildWhere(filter: BatchFilter): Record<string, unknown> {
    return this.compose(
      filter.productId ? { productId: filter.productId } : undefined,
      this.textSearch(filter.search, ['batchNumber', 'notes']),
      filter.onlyAvailable ? { remainingQuantity: { gt: 0 } } : undefined,
      filter.expiringBefore ? { expiresAt: { not: null, lte: filter.expiringBefore } } : undefined,
      // Sin `includeExpired`, un lote caducado no aparece en el listado. Es lo contrario de
      // lo que se quiere en el panel —hay que verlo para retirarlo—, así que solo se
      // excluye cuando quien consulta lo pide.
      filter.includeExpired === false
        ? { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }
        : undefined,
    );
  }

  private async remainingOf(batchId: string): Promise<number> {
    const row = await this.prisma.client.productBatch.findFirst({
      where: { id: batchId },
      select: { remainingQuantity: true },
    });
    if (!row) throw new EntityNotFoundError(this.entityName, batchId);
    return Number(row.remainingQuantity);
  }

  private toPersistence(batch: Batch) {
    return {
      expiresAt: batch.expiresAt,
      initialQuantity: batch.initialQuantity.toFixed(3),
      remainingQuantity: batch.remainingQuantity.toFixed(3),
      unitCost: batch.unitCost.toDecimalString(),
      currency: batch.unitCost.currency,
      supplierId: batch.supplierId,
      purchaseOrderId: batch.purchaseOrderId,
      notes: batch.notes,
      deletedAt: batch.audit.deletedAt,
      deletedBy: batch.audit.deletedBy,
    };
  }

  protected toDomain(row: BatchRow): Batch {
    return Batch.rehydrate(row.id, {
      tenantId: row.tenantId,
      productId: row.productId,
      batchNumber: row.batchNumber,
      expiresAt: row.expiresAt,
      receivedAt: row.receivedAt,
      initialQuantity: Number(row.initialQuantity),
      remainingQuantity: Number(row.remainingQuantity),
      unitCost: Money.fromDecimal(row.unitCost.toFixed(2), row.currency || this.currency),
      supplierId: row.supplierId,
      purchaseOrderId: row.purchaseOrderId,
      notes: row.notes,
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

// ===========================================================================
// Kardex
// ===========================================================================

/**
 * Ledger de movimientos.
 *
 * **No hereda de `PrismaRepositoryBase`**, y es a propósito: esa clase trae `softDelete`,
 * `restore` y `save`, que sobre un registro de solo anexión no significan nada. Heredarla
 * por comodidad dejaría tres métodos que compilan, que alguien puede llamar y que
 * romperían la garantía que el trigger `inventory_movements_append_only` defiende desde la
 * base de datos.
 */
@Injectable()
export class PrismaMovementRepository implements MovementRepository {
  private readonly currency: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.currency = config.get('DEFAULT_CURRENCY', { infer: true });
  }

  private readonly entityName = 'Movimiento de inventario';

  async append(movement: InventoryMovement): Promise<InventoryMovement> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.inventoryMovement.create({ data: this.toPersistence(movement) }),
    );
    return this.toDomain(row);
  }

  async appendMany(movements: readonly InventoryMovement[]): Promise<InventoryMovement[]> {
    if (movements.length === 0) return [];

    // `createMany` no pasa por la extensión que inyecta el `tenantId`, y por eso
    // `toPersistence` lo escribe explícitamente en cada fila.
    await withMappedErrors(this.entityName, () =>
      this.prisma.client.inventoryMovement.createMany({
        data: movements.map((movement) => this.toPersistence(movement)),
      }),
    );

    return [...movements];
  }

  async search(
    filter: MovementFilter,
    page: PageRequest<MovementSortField>,
  ): Promise<Page<InventoryMovement>> {
    const where = this.buildWhere(filter);
    const orderBy = (
      page.sort?.length ? page.sort : [{ field: 'occurredAt', direction: 'desc' }]
    ).map(({ field, direction }) => ({ [field]: direction }));

    const [total, rows] = await withMappedErrors(this.entityName, () =>
      Promise.all([
        this.prisma.client.inventoryMovement.count({ where }),
        this.prisma.client.inventoryMovement.findMany({
          where,
          orderBy,
          skip: (page.page - 1) * page.limit,
          take: page.limit,
        }),
      ]),
    );

    return buildPage(
      rows.map((row) => this.toDomain(row)),
      total,
      page,
    );
  }

  /**
   * Saldo del producto **según el ledger**, que es la fuente de verdad.
   *
   * Compararlo con `Product.stockOnHand` es lo que detecta que la caché ha divergido. Sin
   * este método la caché sería indistinguible de la verdad y una divergencia solo se
   * descubriría en el recuento físico, meses después y sin forma de saber cuándo empezó.
   */
  async balanceOf(productId: string): Promise<number> {
    const result = await withMappedErrors(this.entityName, () =>
      this.prisma.client.inventoryMovement.aggregate({
        where: { productId },
        _sum: { quantityDelta: true },
      }),
    );

    return round3(Number(result._sum.quantityDelta ?? 0));
  }

  private buildWhere(filter: MovementFilter): Record<string, unknown> {
    const conditions: object[] = [];

    if (filter.productId) conditions.push({ productId: filter.productId });
    if (filter.batchId) conditions.push({ batchId: filter.batchId });
    if (filter.type) conditions.push({ type: filter.type });
    if (filter.sourceType) conditions.push({ sourceType: filter.sourceType });
    if (filter.sourceId) conditions.push({ sourceId: filter.sourceId });
    if (filter.from || filter.to) {
      conditions.push({
        occurredAt: {
          ...(filter.from ? { gte: filter.from } : {}),
          ...(filter.to ? { lte: filter.to } : {}),
        },
      });
    }

    if (conditions.length === 0) return {};
    if (conditions.length === 1) return conditions[0] as Record<string, unknown>;
    return { AND: conditions };
  }

  private toPersistence(movement: InventoryMovement) {
    return {
      id: movement.id,
      tenantId: movement.tenantId,
      productId: movement.productId,
      type: movement.type,
      quantityDelta: movement.quantityDelta.toFixed(3),
      balanceAfter: movement.balanceAfter.toFixed(3),
      unitCost: movement.unitCost?.toDecimalString() ?? null,
      currency: movement.unitCost?.currency ?? this.currency,
      sourceType: movement.sourceType,
      sourceId: movement.sourceId,
      reason: movement.reason,
      notes: movement.notes,
      batchId: movement.batchId,
      purchaseOrderId: movement.purchaseOrderId,
      occurredAt: movement.occurredAt,
      createdBy: movement.createdBy,
    };
  }

  private toDomain(row: MovementRow): InventoryMovement {
    return InventoryMovement.rehydrate(row.id, {
      tenantId: row.tenantId,
      productId: row.productId,
      type: row.type,
      quantityDelta: Number(row.quantityDelta),
      balanceAfter: Number(row.balanceAfter),
      unitCost:
        row.unitCost === null
          ? null
          : Money.fromDecimal(row.unitCost.toFixed(2), row.currency || this.currency),
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      reason: row.reason,
      notes: row.notes,
      batchId: row.batchId,
      purchaseOrderId: row.purchaseOrderId,
      occurredAt: row.occurredAt,
      createdBy: row.createdBy,
    });
  }
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
