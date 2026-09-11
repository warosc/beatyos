import type {
  Page,
  PageRequest,
  QueryOptions,
  SearchableRepository,
} from '../../../shared/domain/ports/repository.port';
import type { Batch } from './batch.entity';
import type {
  InventoryMovement,
  MovementSourceTypeValue,
  MovementTypeValue,
} from './inventory-movement.entity';
import type { Product, StockStatus } from './product.entity';

// ---------------------------------------------------------------------------
// Productos
// ---------------------------------------------------------------------------

export interface ProductFilter {
  readonly search?: string;
  readonly categoryId?: string;
  readonly isActive?: boolean;
  readonly isRetail?: boolean;
  readonly isInternal?: boolean;
  readonly tracksBatches?: boolean;
  /** Semáforo de existencias. Se resuelve en la base comparando con el punto de pedido. */
  readonly stock?: StockStatus;
}

export type ProductSortField = 'name' | 'sku' | 'price' | 'stockOnHand' | 'createdAt';

export interface ProductRepository extends SearchableRepository<
  Product,
  ProductFilter,
  ProductSortField
> {
  findByIdOrFail(id: string, options?: QueryOptions): Promise<Product>;

  findBySku(sku: string, options?: QueryOptions): Promise<Product | null>;

  findByBarcode(barcode: string, options?: QueryOptions): Promise<Product | null>;

  /** Carga varios de golpe. Lo necesita el escandallo de un servicio y el punto de venta. */
  findManyByIds(ids: readonly string[]): Promise<Product[]>;

  /**
   * Aplica una variación de existencias de forma **atómica** y devuelve el saldo.
   *
   * Este método existe por una razón concreta y no por simetría con el resto. El patrón
   * habitual —leer el producto, sumar, guardar— pierde escrituras: dos recepciones
   * simultáneas leen el mismo stock de partida y la segunda pisa a la primera, de modo que
   * una caja entera desaparece sin que nadie pueda explicarlo.
   *
   * La implementación debe traducirlo a un `UPDATE ... SET "stockOnHand" = "stockOnHand" +
   * :delta WHERE ...` condicionado a que el resultado no sea negativo, y decidir por el
   * número de filas afectadas: cero significa que no había existencias suficientes **en el
   * momento de escribir**, que es el único momento que cuenta.
   *
   * Lanza `BusinessRuleViolationError('INSUFFICIENT_STOCK')` si la variación dejaría las
   * existencias en negativo.
   */
  applyStockDelta(productId: string, delta: number, actorId: string | null): Promise<number>;

  create(product: Product): Promise<Product>;

  /**
   * Guarda el producto **sin tocar sus existencias**.
   *
   * La exclusión es deliberada y es la otra mitad de `applyStockDelta`. Un caso de uso lee
   * el producto, hace la variación atómica y después guarda el coste medio recalculado; si
   * este método escribiera también `stockOnHand`, escribiría el valor que el agregado leyó
   * *antes* de la variación y desharía en silencio lo que la operación atómica acababa de
   * garantizar. Las existencias solo se mueven por `applyStockDelta`, nunca por aquí.
   */
  update(product: Product): Promise<Product>;

  /** Productos por debajo del punto de pedido. Alimenta el panel de reposición. */
  findBelowReorderPoint(): Promise<Product[]>;
}

export const PRODUCT_REPOSITORY = Symbol('ProductRepository');

// ---------------------------------------------------------------------------
// Lotes
// ---------------------------------------------------------------------------

export interface BatchFilter {
  readonly productId?: string;
  readonly search?: string;
  /** Solo lotes con existencias. Es lo que quiere ver casi siempre quien consulta. */
  readonly onlyAvailable?: boolean;
  readonly expiringBefore?: Date;
  readonly includeExpired?: boolean;
}

export type BatchSortField = 'expiresAt' | 'receivedAt' | 'batchNumber' | 'remainingQuantity';

export interface BatchRepository extends SearchableRepository<Batch, BatchFilter, BatchSortField> {
  findByIdOrFail(id: string, options?: QueryOptions): Promise<Batch>;

  findByNumber(
    productId: string,
    batchNumber: string,
    options?: QueryOptions,
  ): Promise<Batch | null>;

  /** Carga varios de golpe. Evita el N+1 al resolver los lotes de una página de kardex. */
  findManyByIds(ids: readonly string[]): Promise<Batch[]>;

  /**
   * Lotes de un producto con existencias, **en orden FEFO**.
   *
   * El orden lo da la base de datos porque hay un índice hecho para eso
   * (`product_batches_fefo_idx`, con `NULLS LAST`). El dominio vuelve a ordenarlos con
   * `StockAllocationService.sortByFefo` antes de repartir: no es desconfianza del índice,
   * es que el criterio de consumo pertenece al dominio y no puede depender de que un
   * adaptador conserve un `ORDER BY`.
   */
  findConsumable(productId: string): Promise<Batch[]>;

  /**
   * Descuenta de un lote de forma atómica y devuelve lo que queda.
   *
   * Mismo motivo que `applyStockDelta`: entre calcular el reparto FEFO y escribirlo cabe
   * otra petición que consuma del mismo lote. Aquí el `CHECK` de la base
   * (`remainingQuantity >= 0`) es la última barrera, pero llegar a él significa devolver
   * un error de restricción; este método lo convierte en un fallo con sentido.
   */
  consume(batchId: string, quantity: number, actorId: string | null): Promise<number>;

  /** Devuelve cantidad a un lote. No puede superar lo que entró. */
  restock(batchId: string, quantity: number, actorId: string | null): Promise<number>;

  create(batch: Batch): Promise<Batch>;
  update(batch: Batch): Promise<Batch>;

  /** Lotes que caducan dentro del plazo, ordenados por urgencia. */
  findExpiringWithin(days: number, now: Date): Promise<Batch[]>;
}

export const BATCH_REPOSITORY = Symbol('BatchRepository');

// ---------------------------------------------------------------------------
// Kardex
// ---------------------------------------------------------------------------

export interface MovementFilter {
  readonly productId?: string;
  readonly batchId?: string;
  readonly type?: MovementTypeValue;
  readonly sourceType?: MovementSourceTypeValue;
  readonly sourceId?: string;
  readonly from?: Date;
  readonly to?: Date;
}

export type MovementSortField = 'occurredAt' | 'quantityDelta';

/**
 * Ledger de movimientos: **solo se anexa**.
 *
 * El puerto no declara `update`, `softDelete` ni `restore`, y esa ausencia es la decisión.
 * Un repositorio que no ofrece modificar es un repositorio que no se puede usar para
 * modificar, y la garantía deja de depender de que nadie llame al método equivocado. El
 * trigger de PostgreSQL cubre lo que entre por fuera de la aplicación.
 */
export interface MovementRepository {
  append(movement: InventoryMovement): Promise<InventoryMovement>;

  /** Anexa varios en una sola escritura: un consumo FEFO genera uno por lote. */
  appendMany(movements: readonly InventoryMovement[]): Promise<InventoryMovement[]>;

  search(
    filter: MovementFilter,
    page: PageRequest<MovementSortField>,
  ): Promise<Page<InventoryMovement>>;

  /**
   * Suma de las variaciones de un producto: el stock **según el ledger**.
   *
   * Es lo que permite comprobar que la caché de `Product.stockOnHand` no ha divergido.
   * Sin este método la caché sería indistinguible de la verdad, y una divergencia solo se
   * descubriría con un recuento físico.
   */
  balanceOf(productId: string): Promise<number>;
}

export const MOVEMENT_REPOSITORY = Symbol('MovementRepository');
