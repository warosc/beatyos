import { EntityNotFoundError } from '@shared/domain/errors';
import {
  buildPage,
  type PageRequest,
  type QueryOptions,
} from '@shared/domain/ports/repository.port';
import { PurchaseOrder } from '@salon/purchases/domain/purchase-order.entity';
import type {
  PurchaseOrderLine,
  PurchaseOrderStatusValue,
} from '@salon/purchases/domain/purchase-order.entity';
import type {
  PurchaseOrderFilter,
  PurchaseOrderNumberGenerator,
  PurchaseOrderRepository,
  PurchaseOrderSortField,
  SupplierFilter,
  SupplierRepository,
  SupplierSortField,
} from '@salon/purchases/domain/purchases.repositories';
import type { Quantity } from '@salon/purchases/domain/quantity.vo';
import type { Supplier } from '@salon/purchases/domain/supplier.entity';

/**
 * Dobles en memoria de compras (ADR-0009).
 *
 * Implementan los puertos de verdad. Lo que hace que sirvan de algo es que respetan el
 * contrato en el punto donde es sutil: **`receiveLine` es condicional**. Devuelve `false`
 * cuando la entrega ya no cabe, igual que el `UPDATE ... WHERE "receivedQuantity" <=
 * "quantity" − :q` del adaptador real. Un doble que aceptara siempre la escritura taparía
 * justo el fallo que esa condición existe para evitar, y el test pasaría mientras
 * producción deja recibir dos veces el mismo albarán.
 *
 * `beforeReceiveLine` es el gancho con el que un test coloca una entrega ajena entre la
 * lectura y la escritura. Es la única forma de reproducir una carrera sin base de datos, y
 * está aquí y no en el test para que la simulación ocurra exactamente donde el adaptador
 * real evalúa su condición.
 */

// ---------------------------------------------------------------------------

export class InMemorySupplierRepository implements SupplierRepository {
  private readonly items = new Map<string, Supplier>();

  seed(...suppliers: Supplier[]): this {
    for (const supplier of suppliers) this.items.set(supplier.id, supplier);
    return this;
  }

  get all(): Supplier[] {
    return [...this.items.values()];
  }

  findById(id: string, options?: QueryOptions): Promise<Supplier | null> {
    const supplier = this.items.get(id);
    if (!supplier) return Promise.resolve(null);
    if (supplier.isDeleted && !options?.includeDeleted) return Promise.resolve(null);
    return Promise.resolve(supplier);
  }

  async findByIdOrFail(id: string, options?: QueryOptions): Promise<Supplier> {
    const supplier = await this.findById(id, options);
    if (!supplier) throw new EntityNotFoundError('Proveedor', id);
    return supplier;
  }

  async exists(id: string, options?: QueryOptions): Promise<boolean> {
    return (await this.findById(id, options)) !== null;
  }

  search(filter: SupplierFilter, page: PageRequest<SupplierSortField>) {
    const term = filter.search?.trim().toLowerCase();
    const matches = this.all
      .filter((supplier) => !supplier.isDeleted)
      .filter((supplier) => (filter.status ? supplier.status === filter.status : true))
      .filter((supplier) =>
        term
          ? supplier.name.toLowerCase().includes(term) || supplier.code.toLowerCase().includes(term)
          : true,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    const start = (page.page - 1) * page.limit;
    return Promise.resolve(
      buildPage(matches.slice(start, start + page.limit), matches.length, page),
    );
  }

  findManyByIds(ids: readonly string[]): Promise<Supplier[]> {
    return Promise.resolve(ids.map((id) => this.items.get(id)).filter((s): s is Supplier => !!s));
  }

  create(supplier: Supplier): Promise<Supplier> {
    this.items.set(supplier.id, supplier);
    return Promise.resolve(supplier);
  }

  update(supplier: Supplier): Promise<Supplier> {
    if (!this.items.has(supplier.id)) throw new EntityNotFoundError('Proveedor', supplier.id);
    this.items.set(supplier.id, supplier);
    return Promise.resolve(supplier);
  }

  save(supplier: Supplier): Promise<Supplier> {
    return this.update(supplier);
  }

  async softDelete(id: string, actorId: string | null): Promise<void> {
    const supplier = await this.findByIdOrFail(id);
    supplier.markDeleted(new Date(), actorId);
  }

  async restore(id: string, actorId: string | null): Promise<Supplier> {
    const supplier = this.items.get(id);
    if (!supplier?.isDeleted) throw new EntityNotFoundError('Proveedor eliminado', id);
    // Igual que el adaptador real: pasa por la entidad, de modo que la reactivación siga
    // siendo una regla del dominio y no un detalle del `UPDATE`.
    supplier.markRestored(new Date(), actorId);
    return Promise.resolve(supplier);
  }
}

// ---------------------------------------------------------------------------

export class InMemoryPurchaseOrderRepository implements PurchaseOrderRepository {
  private readonly items = new Map<string, PurchaseOrder>();

  /** Gancho para colocar una entrega ajena entre la lectura y la escritura. */
  beforeReceiveLine?: (lineId: string) => void;

  seed(...orders: PurchaseOrder[]): this {
    for (const order of orders) this.items.set(order.id, order);
    return this;
  }

  /**
   * Devuelve una **copia**, igual que una consulta a la base.
   *
   * Es la diferencia que hace que este doble pruebe algo. Si devolviera la instancia
   * almacenada, el agregado que el caso de uso tiene en la mano y el que el repositorio
   * modifica serían el mismo objeto, y una entrega quedaría aplicada dos veces: una por
   * `receiveLine` y otra por el `applyReceipt` del caso de uso. Contra Prisma eso no puede
   * pasar porque lo escrito vive en PostgreSQL y lo leído es otra cosa.
   */
  findById(id: string): Promise<PurchaseOrder | null> {
    const stored = this.items.get(id);
    return Promise.resolve(stored ? snapshot(stored) : null);
  }

  findByIdForUpdate(id: string): Promise<PurchaseOrder | null> {
    return this.findById(id);
  }

  async findByIdOrFail(id: string): Promise<PurchaseOrder> {
    const order = await this.findById(id);
    if (!order) throw new EntityNotFoundError('Pedido de compra', id);
    return order;
  }

  search(filter: PurchaseOrderFilter, page: PageRequest<PurchaseOrderSortField>) {
    const matches = [...this.items.values()]
      .filter((order) => (filter.status ? order.status === filter.status : true))
      .map((order) => snapshot(order));
    const start = (page.page - 1) * page.limit;
    return Promise.resolve(
      buildPage(matches.slice(start, start + page.limit), matches.length, page),
    );
  }

  create(order: PurchaseOrder): Promise<PurchaseOrder> {
    this.items.set(order.id, snapshot(order));
    return Promise.resolve(snapshot(order));
  }

  markSubmitted(id: string, at: Date, actorId: string | null): Promise<boolean> {
    return this.transition(id, ['DRAFT'], 'SUBMITTED', at, actorId);
  }

  markCancelled(id: string, _reason: string, at: Date, actorId: string | null): Promise<boolean> {
    return this.transition(
      id,
      ['DRAFT', 'SUBMITTED', 'PARTIALLY_RECEIVED'],
      'CANCELLED',
      at,
      actorId,
    );
  }

  receiveLine(line: PurchaseOrderLine, quantity: Quantity, at: Date): Promise<boolean> {
    this.beforeReceiveLine?.(line.id);

    const order = this.orderOf(line.id);
    const stored = order?.lines.find((candidate) => candidate.id === line.id);
    if (!order || !stored) return Promise.resolve(false);

    // La condición del `UPDATE` real: lo recibido más la entrega no puede superar lo pedido.
    if (stored.receivedQuantity.add(quantity).greaterThan(stored.quantity)) {
      return Promise.resolve(false);
    }

    order.applyReceipt(line.id, quantity, at, null);
    return Promise.resolve(true);
  }

  settleReceipt(
    id: string,
    status: PurchaseOrderStatusValue,
    receivedAt: Date | null,
    at: Date,
    actorId: string | null,
  ): Promise<void> {
    const order = this.items.get(id);
    if (!order) throw new EntityNotFoundError('Pedido de compra', id);
    this.items.set(id, snapshot(order, { status, receivedAt, at, actorId }));
    return Promise.resolve();
  }

  private async transition(
    id: string,
    from: readonly PurchaseOrderStatusValue[],
    to: PurchaseOrderStatusValue,
    at: Date,
    actorId: string | null,
  ): Promise<boolean> {
    const order = this.items.get(id);
    if (!order || !from.includes(order.status)) return false;
    this.items.set(id, snapshot(order, { status: to, receivedAt: null, at, actorId }));
    return true;
  }

  private orderOf(lineId: string): PurchaseOrder | undefined {
    return [...this.items.values()].find((order) => order.lines.some((line) => line.id === lineId));
  }
}

/**
 * Reconstruye el pedido con otro estado.
 *
 * El agregado no expone un cambio de estado a propósito: la transición la escribe el
 * repositorio con una sentencia condicionada al estado de partida, y darle al agregado un
 * `setStatus` invitaría a saltarse esa condición. El doble hace lo que hace la base.
 */
const snapshot = (
  order: PurchaseOrder,
  change?: {
    status: PurchaseOrderStatusValue;
    receivedAt: Date | null;
    at: Date;
    actorId: string | null;
  },
): PurchaseOrder => {
  if (!change) {
    return PurchaseOrder.rehydrate(order.id, {
      tenantId: order.tenantId,
      supplierId: order.supplierId,
      number: order.number,
      status: order.status,
      orderedAt: order.orderedAt,
      expectedAt: order.expectedAt,
      receivedAt: order.receivedAt,
      cancelledAt: order.cancelledAt,
      cancellationReason: order.cancellationReason,
      supplierReference: order.supplierReference,
      notes: order.notes,
      lines: order.lines.map((line) => ({ ...line })),
      subtotal: order.subtotal,
      taxTotal: order.taxTotal,
      total: order.total,
      currency: order.currency,
      audit: { ...order.audit },
    });
  }

  return PurchaseOrder.rehydrate(order.id, {
    tenantId: order.tenantId,
    supplierId: order.supplierId,
    number: order.number,
    status: change.status,
    orderedAt: change.status === 'SUBMITTED' ? change.at : order.orderedAt,
    expectedAt: order.expectedAt,
    receivedAt: change.receivedAt,
    cancelledAt: change.status === 'CANCELLED' ? change.at : order.cancelledAt,
    cancellationReason: order.cancellationReason,
    supplierReference: order.supplierReference,
    notes: order.notes,
    lines: order.lines.map((line) => ({ ...line })),
    subtotal: order.subtotal,
    taxTotal: order.taxTotal,
    total: order.total,
    currency: order.currency,
    audit: { ...order.audit, updatedAt: change.at, updatedBy: change.actorId },
  });
};

// ---------------------------------------------------------------------------

export class SequentialPurchaseOrderNumberGenerator implements PurchaseOrderNumberGenerator {
  private counter = 0;

  next(year: number): Promise<string> {
    this.counter += 1;
    return Promise.resolve(`OC-${year}-${String(this.counter).padStart(6, '0')}`);
  }
}
