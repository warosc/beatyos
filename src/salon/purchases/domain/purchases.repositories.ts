import type {
  Page,
  PageRequest,
  QueryOptions,
  Repository,
} from '../../../shared/domain/ports/repository.port';
import type {
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderStatusValue,
} from './purchase-order.entity';
import type { Quantity } from './quantity.vo';
import type { Supplier, SupplierStatusValue } from './supplier.entity';

/**
 * Puertos de persistencia de compras (ADR-0017).
 *
 * Los define el dominio y los implementa la infraestructura. Ninguno menciona Prisma,
 * `tenantId` ni transacciones: el salón lo aporta el contexto de petición y lo aplica la
 * extensión (ADR-0003), y la unidad de trabajo entra por `UNIT_OF_WORK`.
 *
 * Los métodos de transición devuelven `boolean` en lugar de `void`, y esa firma es la
 * decisión más importante de este fichero. Significa «se escribió, o no se escribió porque
 * cuando llegué ya no se cumplía la condición»: es lo que permite que la comprobación y la
 * escritura ocurran bajo el mismo bloqueo de fila en vez de dejar una ventana entre las dos
 * (ADR-0013).
 */

// ---------------------------------------------------------------------------
// Proveedores
// ---------------------------------------------------------------------------

export interface SupplierFilter {
  /** Texto libre sobre nombre y código. */
  readonly search?: string;
  readonly status?: SupplierStatusValue;
}

export type SupplierSortField = 'name' | 'code' | 'createdAt';

export interface SupplierRepository extends Repository<Supplier> {
  findByIdOrFail(id: string, options?: QueryOptions): Promise<Supplier>;

  search(filter: SupplierFilter, page: PageRequest<SupplierSortField>): Promise<Page<Supplier>>;

  /** Carga varios de golpe. Evita el N+1 al componer el listado de pedidos. */
  findManyByIds(ids: readonly string[]): Promise<Supplier[]>;

  create(supplier: Supplier): Promise<Supplier>;
  update(supplier: Supplier): Promise<Supplier>;
}

export const SUPPLIER_REPOSITORY = Symbol('SupplierRepository');

// ---------------------------------------------------------------------------
// Pedidos de compra
// ---------------------------------------------------------------------------

export interface PurchaseOrderFilter {
  readonly status?: PurchaseOrderStatusValue;
}

export type PurchaseOrderSortField = 'createdAt' | 'number' | 'status' | 'expectedAt';

export interface PurchaseOrderRepository {
  findById(id: string): Promise<PurchaseOrder | null>;

  /**
   * Carga la orden y bloquea su cabecera hasta que termine la unidad de trabajo activa.
   * Serializa las transiciones que también modifican líneas o inventario, para que el
   * estado agregado se calcule sobre una fotografía estable.
   */
  findByIdForUpdate(id: string): Promise<PurchaseOrder | null>;

  findByIdOrFail(id: string): Promise<PurchaseOrder>;

  search(
    filter: PurchaseOrderFilter,
    page: PageRequest<PurchaseOrderSortField>,
  ): Promise<Page<PurchaseOrder>>;

  /** Crea la cabecera con sus líneas en una sola escritura. */
  create(order: PurchaseOrder): Promise<PurchaseOrder>;

  /**
   * Envía el pedido al proveedor si sigue en borrador.
   *
   * `false` cuando otro lo envió o lo canceló primero. Condicionar el `UPDATE` al estado
   * de partida evita que dos envíos simultáneos prosperen los dos y dejen `orderedAt`
   * escrito dos veces con marcas distintas.
   */
  markSubmitted(id: string, at: Date, actorId: string | null): Promise<boolean>;

  /** Cancela si el estado actual todavía lo admite. `false` si ya no. */
  markCancelled(id: string, reason: string, at: Date, actorId: string | null): Promise<boolean>;

  /**
   * Suma a lo recibido de una línea **solo si cabe en lo pedido**.
   *
   * `UPDATE ... SET "receivedQuantity" = "receivedQuantity" + :q
   *    WHERE "id" = :id AND "receivedQuantity" <= "quantity" - :q`.
   *
   * `false` significa «no cabía en el momento de escribir», que es el único momento que
   * cuenta. Sin esta condición, dos personas descargando el mismo albarán leen ambas cero
   * recibido, ambas superan la validación y ambas suman: el `CHECK` de la base para el
   * sobre-recibo, pero al precio de un error de restricción sin traducir (ADR-0013).
   *
   * Recibe la línea entera y no solo su identificador porque el umbral de la condición es
   * `quantity − :q`, y la cantidad pedida de una línea no cambia nunca: leerla del agregado
   * es exacto y ahorra una consulta. Lo único que se mueve es `receivedQuantity`, y de eso
   * se ocupa la propia sentencia.
   */
  receiveLine(line: PurchaseOrderLine, quantity: Quantity, at: Date): Promise<boolean>;

  /** Fija el estado resultante de una entrega y, si se completó, la fecha de recepción. */
  settleReceipt(
    id: string,
    status: PurchaseOrderStatusValue,
    receivedAt: Date | null,
    at: Date,
    actorId: string | null,
  ): Promise<void>;
}

export const PURCHASE_ORDER_REPOSITORY = Symbol('PurchaseOrderRepository');

// ---------------------------------------------------------------------------
// Numeración
// ---------------------------------------------------------------------------

/**
 * Numerador de pedidos de compra.
 *
 * Puerto propio y no el `DocumentNumberGenerator` de ventas, pese a que aquél ya admite
 * `PURCHASE_ORDER` en su unión de tipos. El motivo es que los dos guardan el prefijo con
 * convenios distintos: ventas almacena `"F-2026-"` y concatena, y compras almacena `"OC"` y
 * compone `OC-2026-000001`. Unificarlos hoy cambiaría el número visible de todos los
 * pedidos futuros de las series ya abiertas, que es exactamente el tipo de cambio que una
 * refactorización arquitectónica no debe introducir. Queda anotado en el ADR-0017 como
 * candidato a unificación con su migración de datos.
 *
 * La garantía sí es la misma: la serie es consecutiva y sin huecos dentro del ejercicio,
 * porque el contador se reserva con un `upsert` con `increment` dentro de la transacción
 * que crea el pedido. Si el pedido no llega a existir, el contador vuelve atrás con ella.
 */
export interface PurchaseOrderNumberGenerator {
  next(year: number): Promise<string>;
}

export const PURCHASE_ORDER_NUMBER_GENERATOR = Symbol('PurchaseOrderNumberGenerator');
