import { EntityNotFoundError } from '@shared/domain/errors';
import { buildPage, type Page, type PageRequest } from '@shared/domain/ports/repository.port';
import type { Batch } from '@salon/inventory/domain/batch.entity';
import type { InventoryMovement } from '@salon/inventory/domain/inventory-movement.entity';
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
} from '@salon/inventory/domain/inventory.repositories';
import type { Product } from '@salon/inventory/domain/product.entity';

/**
 * Dobles en memoria del inventario (ADR-0009).
 *
 * Implementan los puertos de verdad, no son mocks. Lo que hace que sirvan de algo es que
 * respetan **el mismo contrato** que los adaptadores de Prisma en los dos sitios donde ese
 * contrato es sutil:
 *
 * - `applyStockDelta` recibe una variación, nunca un valor final, y rechaza la que dejaría
 *   existencias negativas. El adaptador real lo resuelve con un `UPDATE ... WHERE
 *   "stockOnHand" >= :cantidad` para que comprobación y escritura ocurran bajo el mismo
 *   bloqueo de fila; aquí no hay concurrencia que simular, pero sí la misma firma y el
 *   mismo error.
 * - `update` **no escribe las existencias**. Es la otra mitad de lo anterior: si las
 *   escribiera, este doble taparía justo el fallo que el adaptador evita —un agregado leído
 *   antes de la variación deshaciéndola al guardarse— y el test pasaría mientras producción
 *   pierde una caja de producto.
 *
 * Un doble que se desvía del puerto deja de probar nada.
 */

/** Superficie de baja lógica que comparten los agregados de inventario. */
interface SoftDeletable {
  markDeleted(now: Date, actorId: string | null): void;
  markRestored(now: Date, actorId: string | null): void;
}

abstract class InMemoryStore<T extends { id: string }> {
  protected readonly items = new Map<string, T>();
  protected readonly deletedIds = new Set<string>();

  seed(...entities: T[]): this {
    for (const entity of entities) this.items.set(entity.id, entity);
    return this;
  }

  get all(): T[] {
    return [...this.items.values()].filter((entity) => !this.deletedIds.has(entity.id));
  }

  get allIncludingDeleted(): T[] {
    return [...this.items.values()];
  }

  protected markDeleted(id: string): void {
    this.deletedIds.add(id);
    (this.items.get(id) as unknown as SoftDeletable | undefined)?.markDeleted(new Date(), 'test');
  }

  protected markRestored(id: string): void {
    this.deletedIds.delete(id);
    (this.items.get(id) as unknown as SoftDeletable | undefined)?.markRestored(new Date(), 'test');
  }

  protected isSoftDeleted(id: string): boolean {
    return this.deletedIds.has(id);
  }

  clear(): void {
    this.items.clear();
    this.deletedIds.clear();
  }
}

// ---------------------------------------------------------------------------

export class InMemoryProductRepository extends InMemoryStore<Product> implements ProductRepository {
  async findById(id: string, options?: { includeDeleted?: boolean }): Promise<Product | null> {
    const product = this.items.get(id);
    if (!product) return null;
    return options?.includeDeleted === true || !this.isSoftDeleted(id) ? product : null;
  }

  async findByIdOrFail(id: string, options?: { includeDeleted?: boolean }): Promise<Product> {
    const product = await this.findById(id, options);
    if (!product) throw new EntityNotFoundError('Producto', id);
    return product;
  }

  async findBySku(sku: string, options?: { includeDeleted?: boolean }): Promise<Product | null> {
    const normalized = sku.trim().toUpperCase();
    const pool = options?.includeDeleted === true ? this.allIncludingDeleted : this.all;
    return pool.find((product) => product.sku === normalized) ?? null;
  }

  async findByBarcode(barcode: string): Promise<Product | null> {
    return this.all.find((product) => product.barcode === barcode.trim()) ?? null;
  }

  async findManyByIds(ids: readonly string[]): Promise<Product[]> {
    return ids
      .map((id) => this.items.get(id))
      .filter(
        (product): product is Product => product !== undefined && !this.isSoftDeleted(product.id),
      );
  }

  /** La regla la aplica el agregado, igual que en el adaptador real. */
  async applyStockDelta(productId: string, delta: number, actorId: string | null): Promise<number> {
    const product = await this.findByIdOrFail(productId);
    return product.applyDelta(delta, new Date(), actorId);
  }

  async exists(id: string): Promise<boolean> {
    return (await this.findById(id)) !== null;
  }

  async count(filter: ProductFilter): Promise<number> {
    return (await this.search(filter, { page: 1, limit: 1000 })).meta.total;
  }

  async search(filter: ProductFilter, page: PageRequest<ProductSortField>): Promise<Page<Product>> {
    let matches = this.all;

    if (filter.search) {
      const term = filter.search.toLowerCase();
      matches = matches.filter((product) =>
        `${product.name} ${product.sku} ${product.brand ?? ''} ${product.barcode ?? ''}`
          .toLowerCase()
          .includes(term),
      );
    }
    if (filter.categoryId) matches = matches.filter((p) => p.categoryId === filter.categoryId);
    if (filter.isActive !== undefined) {
      matches = matches.filter((p) => p.isActive === filter.isActive);
    }
    if (filter.isRetail !== undefined)
      matches = matches.filter((p) => p.isRetail === filter.isRetail);
    if (filter.isInternal !== undefined) {
      matches = matches.filter((p) => p.isInternal === filter.isInternal);
    }
    if (filter.tracksBatches !== undefined) {
      matches = matches.filter((p) => p.tracksBatches === filter.tracksBatches);
    }
    if (filter.stock) matches = matches.filter((p) => p.stockStatus === filter.stock);

    matches.sort((a, b) => a.name.localeCompare(b.name));

    const start = (page.page - 1) * page.limit;
    return buildPage(matches.slice(start, start + page.limit), matches.length, page);
  }

  async create(product: Product): Promise<Product> {
    this.items.set(product.id, product);
    return product;
  }

  async update(product: Product): Promise<Product> {
    if (!this.items.has(product.id)) throw new EntityNotFoundError('Producto', product.id);
    this.items.set(product.id, product);
    return product;
  }

  async save(product: Product): Promise<Product> {
    return this.update(product);
  }

  async softDelete(id: string): Promise<void> {
    if (!this.items.has(id) || this.isSoftDeleted(id)) {
      throw new EntityNotFoundError('Producto', id);
    }
    this.markDeleted(id);
  }

  async restore(id: string): Promise<Product> {
    const product = this.items.get(id);
    if (!product || !this.isSoftDeleted(id)) {
      throw new EntityNotFoundError('Producto eliminado', id);
    }
    this.markRestored(id);
    return product;
  }

  async findBelowReorderPoint(): Promise<Product[]> {
    return this.all
      .filter((p) => p.isActive && p.trackStock && p.stockOnHand <= p.reorderPoint)
      .sort((a, b) => a.stockOnHand - b.stockOnHand || a.name.localeCompare(b.name));
  }
}

// ---------------------------------------------------------------------------

export class InMemoryBatchRepository extends InMemoryStore<Batch> implements BatchRepository {
  async findById(id: string, options?: { includeDeleted?: boolean }): Promise<Batch | null> {
    const batch = this.items.get(id);
    if (!batch) return null;
    return options?.includeDeleted === true || !this.isSoftDeleted(id) ? batch : null;
  }

  async findByIdOrFail(id: string, options?: { includeDeleted?: boolean }): Promise<Batch> {
    const batch = await this.findById(id, options);
    if (!batch) throw new EntityNotFoundError('Lote', id);
    return batch;
  }

  async findByNumber(productId: string, batchNumber: string): Promise<Batch | null> {
    const normalized = batchNumber.trim();
    return this.all.find((b) => b.productId === productId && b.batchNumber === normalized) ?? null;
  }

  async findManyByIds(ids: readonly string[]): Promise<Batch[]> {
    return ids
      .map((id) => this.items.get(id))
      .filter((batch): batch is Batch => batch !== undefined && !this.isSoftDeleted(batch.id));
  }

  /**
   * Devuelve también los caducados.
   *
   * Filtrarlos aquí parecería más limpio y haría mentir al doble: el servicio de reparto
   * los necesita para distinguir «no hay» de «hay pero está caducado», que son dos
   * problemas distintos (ADR-0012).
   */
  async findConsumable(productId: string): Promise<Batch[]> {
    return this.all.filter((b) => b.productId === productId && !b.isDepleted);
  }

  async consume(batchId: string, quantity: number, actorId: string | null): Promise<number> {
    const batch = await this.findByIdOrFail(batchId);
    batch.consume(quantity, new Date(), actorId);
    return batch.remainingQuantity;
  }

  async restock(batchId: string, quantity: number, actorId: string | null): Promise<number> {
    const batch = await this.findByIdOrFail(batchId);
    batch.restock(quantity, new Date(), actorId);
    return batch.remainingQuantity;
  }

  async exists(id: string): Promise<boolean> {
    return (await this.findById(id)) !== null;
  }

  async count(filter: BatchFilter): Promise<number> {
    return (await this.search(filter, { page: 1, limit: 1000 })).meta.total;
  }

  async search(filter: BatchFilter, page: PageRequest<BatchSortField>): Promise<Page<Batch>> {
    let matches = this.all;

    if (filter.productId) matches = matches.filter((b) => b.productId === filter.productId);
    if (filter.search) {
      const term = filter.search.toLowerCase();
      matches = matches.filter((b) => b.batchNumber.toLowerCase().includes(term));
    }
    if (filter.onlyAvailable) matches = matches.filter((b) => !b.isDepleted);
    if (filter.expiringBefore) {
      matches = matches.filter(
        (b) => b.expiresAt !== null && b.expiresAt <= filter.expiringBefore!,
      );
    }

    matches.sort(
      (a, b) =>
        (a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY) -
          (b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY) ||
        a.receivedAt.getTime() - b.receivedAt.getTime(),
    );

    const start = (page.page - 1) * page.limit;
    return buildPage(matches.slice(start, start + page.limit), matches.length, page);
  }

  async create(batch: Batch): Promise<Batch> {
    this.items.set(batch.id, batch);
    return batch;
  }

  async update(batch: Batch): Promise<Batch> {
    if (!this.items.has(batch.id)) throw new EntityNotFoundError('Lote', batch.id);
    this.items.set(batch.id, batch);
    return batch;
  }

  async save(batch: Batch): Promise<Batch> {
    return this.update(batch);
  }

  async softDelete(id: string): Promise<void> {
    if (!this.items.has(id) || this.isSoftDeleted(id)) throw new EntityNotFoundError('Lote', id);
    this.markDeleted(id);
  }

  async restore(id: string): Promise<Batch> {
    const batch = this.items.get(id);
    if (!batch || !this.isSoftDeleted(id)) throw new EntityNotFoundError('Lote eliminado', id);
    this.markRestored(id);
    return batch;
  }

  async findExpiringWithin(days: number, now: Date): Promise<Batch[]> {
    return this.all
      .filter((b) => !b.isDepleted && b.expiresWithin(days, now))
      .sort(
        (a, b) =>
          (a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY) -
          (b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY),
      );
  }
}

// ---------------------------------------------------------------------------

/**
 * Ledger en memoria.
 *
 * No hereda de `InMemoryStore` a propósito: esa clase trae baja lógica y restauración, y un
 * registro de solo anexión no las tiene. El doble expone la misma superficie que el puerto,
 * ni un método más.
 */
export class InMemoryMovementRepository implements MovementRepository {
  readonly entries: InventoryMovement[] = [];

  async append(movement: InventoryMovement): Promise<InventoryMovement> {
    this.entries.push(movement);
    return movement;
  }

  async appendMany(movements: readonly InventoryMovement[]): Promise<InventoryMovement[]> {
    this.entries.push(...movements);
    return [...movements];
  }

  async search(
    filter: MovementFilter,
    page: PageRequest<MovementSortField>,
  ): Promise<Page<InventoryMovement>> {
    let matches = [...this.entries];

    if (filter.productId) matches = matches.filter((m) => m.productId === filter.productId);
    if (filter.batchId) matches = matches.filter((m) => m.batchId === filter.batchId);
    if (filter.type) matches = matches.filter((m) => m.type === filter.type);
    if (filter.sourceType) matches = matches.filter((m) => m.sourceType === filter.sourceType);
    if (filter.sourceId) matches = matches.filter((m) => m.sourceId === filter.sourceId);
    if (filter.from) matches = matches.filter((m) => m.occurredAt >= filter.from!);
    if (filter.to) matches = matches.filter((m) => m.occurredAt <= filter.to!);

    matches.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

    const start = (page.page - 1) * page.limit;
    return buildPage(matches.slice(start, start + page.limit), matches.length, page);
  }

  async balanceOf(productId: string): Promise<number> {
    const total = this.entries
      .filter((movement) => movement.productId === productId)
      .reduce((sum, movement) => sum + movement.quantityDelta, 0);
    return Math.round(total * 1000) / 1000;
  }

  clear(): void {
    this.entries.length = 0;
  }
}
