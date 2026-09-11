import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  AUDIT_RECORDER,
  CLOCK,
  ID_GENERATOR,
  type AuditRecorder,
  type Clock,
  type IdGenerator,
  type UseCase,
} from '../../../shared/application/ports';
import { BusinessRuleViolationError, EntityNotFoundError } from '../../../shared/domain/errors';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../shared/domain/ports/repository.port';
import type { Page, PageRequest } from '../../../shared/domain/ports/repository.port';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import { Percentage } from '../../../shared/domain/value-objects/time-range.vo';
import type { Env } from '../../../shared/infrastructure/config/env.schema';
import { ReceiveStockUseCase } from '../../inventory/application/inventory.use-cases';
import type { InventoryMovement } from '../../inventory/domain/inventory-movement.entity';
import {
  MOVEMENT_REPOSITORY,
  PRODUCT_REPOSITORY,
  type MovementRepository,
  type ProductRepository,
} from '../../inventory/domain/inventory.repositories';
import type { Product } from '../../inventory/domain/product.entity';
import {
  buildPurchaseOrderLine,
  PurchaseOrder,
  type PurchaseOrderLine,
} from '../domain/purchase-order.entity';
import {
  PURCHASE_ORDER_NUMBER_GENERATOR,
  PURCHASE_ORDER_REPOSITORY,
  SUPPLIER_REPOSITORY,
  type PurchaseOrderFilter,
  type PurchaseOrderNumberGenerator,
  type PurchaseOrderRepository,
  type PurchaseOrderSortField,
  type SupplierRepository,
} from '../domain/purchases.repositories';
import { Quantity } from '../domain/quantity.vo';
import type { Supplier } from '../domain/supplier.entity';

/**
 * Casos de uso de pedidos de compra (ADR-0017).
 *
 * Ninguno conoce Prisma. Lo que antes era un servicio de 371 líneas con `PrismaService`
 * inyectado queda repartido en una intención por clase, y las reglas —qué estado admite
 * qué, cuánto cabe en una línea, cómo se calcula un total— bajan al agregado, donde se
 * prueban sin base de datos.
 */

// ===========================================================================
// Composición de la vista
// ===========================================================================

/**
 * Pedido con lo que hace falta para presentarlo.
 *
 * El agregado guarda identificadores, no copias del proveedor ni del producto: son otros
 * agregados y tienen su propio ciclo de vida. Pero la respuesta que `apps/web` lleva
 * leyendo desde el principio los trae anidados, así que alguien tiene que reunirlos. Ese
 * alguien es esta fábrica, y lo hace con dos consultas por lote —no una por línea—, que es
 * la diferencia entre componer una vista y provocar un N+1.
 */
export interface PurchaseOrderView {
  readonly order: PurchaseOrder;
  readonly supplier: Supplier | null;
  readonly products: ReadonlyMap<string, Product>;
  readonly movements: readonly InventoryMovement[];
}

@Injectable()
export class PurchaseOrderViewFactory {
  constructor(
    @Inject(SUPPLIER_REPOSITORY) private readonly suppliers: SupplierRepository,
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository,
    @Inject(MOVEMENT_REPOSITORY) private readonly movements: MovementRepository,
  ) {}

  async forOne(order: PurchaseOrder, withMovements: boolean): Promise<PurchaseOrderView> {
    const [suppliers, products, movements] = await Promise.all([
      this.suppliers.findManyByIds([order.supplierId]),
      this.products.findManyByIds(uniqueProductIds([order])),
      withMovements ? this.loadMovements(order.id) : Promise.resolve([]),
    ]);

    return {
      order,
      supplier: suppliers[0] ?? null,
      products: indexById(products),
      movements,
    };
  }

  async forMany(orders: readonly PurchaseOrder[]): Promise<PurchaseOrderView[]> {
    if (orders.length === 0) return [];

    const [suppliers, products] = await Promise.all([
      this.suppliers.findManyByIds([...new Set(orders.map((order) => order.supplierId))]),
      this.products.findManyByIds(uniqueProductIds(orders)),
    ]);

    const supplierById = indexById(suppliers);
    const productById = indexById(products);

    return orders.map((order) => ({
      order,
      supplier: supplierById.get(order.supplierId) ?? null,
      products: productById,
      movements: [],
    }));
  }

  /**
   * Movimientos originados por el pedido.
   *
   * Se consultan por `sourceType`/`sourceId`, que es como los graba `ReceiveStockUseCase` y
   * para lo que existe el índice `[tenantId, sourceType, sourceId]`. El tope de 200 es
   * holgado para un pedido real —un asiento por línea y entrega, más los tramos por lote—
   * y evita que un documento patológico se traiga el kardex entero.
   */
  private async loadMovements(orderId: string): Promise<InventoryMovement[]> {
    const page = await this.movements.search(
      { sourceType: 'PURCHASE_ORDER', sourceId: orderId },
      { page: 1, limit: 200, sort: [{ field: 'occurredAt', direction: 'asc' }] },
    );
    return [...page.data];
  }
}

const uniqueProductIds = (orders: readonly PurchaseOrder[]): string[] => [
  ...new Set(orders.flatMap((order) => order.lines.map((line) => line.productId))),
];

const indexById = <T extends { id: string }>(items: readonly T[]): Map<string, T> =>
  new Map(items.map((item) => [item.id, item]));

// ===========================================================================
// Alta
// ===========================================================================

export interface CreatePurchaseOrderLineInput {
  readonly productId: string;
  readonly quantity: number;
  readonly unitCost: number;
  readonly taxRate?: number;
  readonly notes?: string;
}

export interface CreatePurchaseOrderInput {
  readonly tenantId: string;
  readonly supplierId: string;
  readonly expectedAt?: string;
  readonly supplierReference?: string;
  readonly notes?: string;
  readonly lines: readonly CreatePurchaseOrderLineInput[];
  readonly actorId: string | null;
}

@Injectable()
export class CreatePurchaseOrderUseCase implements UseCase<
  CreatePurchaseOrderInput,
  PurchaseOrderView
> {
  private readonly currency: string;

  constructor(
    @Inject(PURCHASE_ORDER_REPOSITORY) private readonly orders: PurchaseOrderRepository,
    @Inject(SUPPLIER_REPOSITORY) private readonly suppliers: SupplierRepository,
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository,
    @Inject(PURCHASE_ORDER_NUMBER_GENERATOR) private readonly numbers: PurchaseOrderNumberGenerator,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    private readonly views: PurchaseOrderViewFactory,
    config: ConfigService<Env, true>,
  ) {
    this.currency = config.get('DEFAULT_CURRENCY', { infer: true });
  }

  async execute(input: CreatePurchaseOrderInput): Promise<PurchaseOrderView> {
    if (input.lines.length === 0) {
      throw new BusinessRuleViolationError(
        'PURCHASE_WITHOUT_LINES',
        'El pedido debe contener al menos una línea',
      );
    }

    const order = await this.uow.execute(async () => {
      const supplier = await this.suppliers.findById(input.supplierId);
      if (!supplier?.canReceiveOrders) {
        // Mismo error para «no existe» y «está de baja»: fuera del alcance del solicitante
        // todo es «no existe», y distinguirlos confirmaría qué proveedores hay (ADR-0008).
        throw new EntityNotFoundError('Proveedor activo', input.supplierId);
      }

      const productIds = [...new Set(input.lines.map((line) => line.productId))];
      const products = await this.products.findManyByIds(productIds);
      if (products.length !== productIds.length) {
        throw new EntityNotFoundError('Producto', 'uno o más identificadores');
      }

      const now = this.clock.now();
      const taxRateOf = new Map(products.map((product) => [product.id, product.taxRate]));

      const lines = input.lines.map((line) =>
        buildPurchaseOrderLine({
          id: this.ids.generate(),
          productId: line.productId,
          quantity: Quantity.fromDecimal(line.quantity),
          unitCost: Money.fromDecimal(line.unitCost, this.currency),
          // El tipo por defecto de una línea es el del producto que se compra, no una
          // constante: escribir un 12 aquí ataba el módulo al IVA guatemalteco y se
          // desviaba en cuanto un producto declaraba otro.
          taxRate:
            line.taxRate === undefined
              ? (taxRateOf.get(line.productId) ?? Percentage.zero())
              : Percentage.create(line.taxRate),
          notes: line.notes,
          now,
        }),
      );

      const draft = PurchaseOrder.open({
        id: this.ids.generate(),
        tenantId: input.tenantId,
        supplierId: input.supplierId,
        number: await this.numbers.next(now.getFullYear()),
        currency: this.currency,
        lines,
        expectedAt: input.expectedAt ? new Date(input.expectedAt) : null,
        supplierReference: input.supplierReference,
        notes: input.notes,
        now,
        actorId: input.actorId,
      });

      const created = await this.orders.create(draft);
      await this.audit.record({
        action: 'CREATE',
        entityType: 'PurchaseOrder',
        entityId: created.id,
      });
      return created;
    });

    return this.views.forOne(order, false);
  }
}

// ===========================================================================
// Consultas
// ===========================================================================

@Injectable()
export class ListPurchaseOrdersUseCase implements UseCase<
  { filter: PurchaseOrderFilter; page: PageRequest<PurchaseOrderSortField> },
  Page<PurchaseOrderView>
> {
  constructor(
    @Inject(PURCHASE_ORDER_REPOSITORY) private readonly orders: PurchaseOrderRepository,
    private readonly views: PurchaseOrderViewFactory,
  ) {}

  async execute(input: {
    filter: PurchaseOrderFilter;
    page: PageRequest<PurchaseOrderSortField>;
  }): Promise<Page<PurchaseOrderView>> {
    const result = await this.orders.search(input.filter, input.page);
    return { data: await this.views.forMany(result.data), meta: result.meta };
  }
}

@Injectable()
export class GetPurchaseOrderUseCase implements UseCase<{ orderId: string }, PurchaseOrderView> {
  constructor(
    @Inject(PURCHASE_ORDER_REPOSITORY) private readonly orders: PurchaseOrderRepository,
    private readonly views: PurchaseOrderViewFactory,
  ) {}

  async execute(input: { orderId: string }): Promise<PurchaseOrderView> {
    return this.views.forOne(await this.orders.findByIdOrFail(input.orderId), true);
  }
}

// ===========================================================================
// Transiciones
// ===========================================================================

@Injectable()
export class SubmitPurchaseOrderUseCase implements UseCase<
  { orderId: string; actorId: string | null },
  PurchaseOrderView
> {
  constructor(
    @Inject(PURCHASE_ORDER_REPOSITORY) private readonly orders: PurchaseOrderRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly views: PurchaseOrderViewFactory,
  ) {}

  async execute(input: { orderId: string; actorId: string | null }): Promise<PurchaseOrderView> {
    const order = await this.orders.findById(input.orderId);
    // Un pedido que no existe y uno que ya no está en borrador dan el mismo error, que es
    // lo que la API viene devolviendo. Distinguirlos sería un cambio de contrato.
    if (!order) {
      throw new BusinessRuleViolationError(
        'PURCHASE_NOT_DRAFT',
        'Solo se puede enviar un pedido en borrador',
      );
    }

    order.assertCanSubmit();

    const submitted = await this.orders.markSubmitted(order.id, this.clock.now(), input.actorId);
    if (!submitted) {
      // Entre la lectura y la escritura otro lo envió o lo canceló. El `UPDATE` estaba
      // condicionado al estado de partida, así que no ha llegado a aplicarse.
      throw new BusinessRuleViolationError(
        'PURCHASE_NOT_DRAFT',
        'Solo se puede enviar un pedido en borrador',
      );
    }

    return this.views.forOne(await this.orders.findByIdOrFail(order.id), true);
  }
}

// ---------------------------------------------------------------------------

@Injectable()
export class CancelPurchaseOrderUseCase implements UseCase<
  { orderId: string; reason: string; actorId: string | null },
  PurchaseOrderView
> {
  constructor(
    @Inject(PURCHASE_ORDER_REPOSITORY) private readonly orders: PurchaseOrderRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    private readonly views: PurchaseOrderViewFactory,
  ) {}

  async execute(input: {
    orderId: string;
    reason: string;
    actorId: string | null;
  }): Promise<PurchaseOrderView> {
    const order = await this.uow.execute(async () => {
      const locked = await this.orders.findByIdForUpdate(input.orderId);
      if (!locked) return null;

      locked.assertCanCancel();
      const applied = await this.orders.markCancelled(
        locked.id,
        input.reason,
        this.clock.now(),
        input.actorId,
      );
      return applied ? this.orders.findByIdOrFail(locked.id) : null;
    });
    if (!order) {
      throw new BusinessRuleViolationError(
        'PURCHASE_CANNOT_CANCEL',
        'El pedido no admite cancelación en su estado actual',
      );
    }

    return this.views.forOne(order, true);
  }
}

// ===========================================================================
// Recepción
// ===========================================================================

export interface ReceiptLineInput {
  readonly lineId: string;
  readonly quantity: number;
  readonly batchNumber?: string;
  readonly expiresAt?: string;
}

export interface ReceivePurchaseOrderInput {
  readonly orderId: string;
  readonly tenantId: string;
  readonly lines: readonly ReceiptLineInput[];
  readonly actorId: string | null;
}

/**
 * Recepción de mercancía.
 *
 * Delega **todo** el inventario en `ReceiveStockUseCase`: reparto por lotes, coste medio,
 * asiento del kardex y descuento atómico. Copiar aquí cualquiera de esas cuatro cosas
 * sería tener un segundo motor de existencias que diverge del primero, que es justo lo que
 * el ADR-0013 acabó de arreglar en ventas.
 *
 * Lo propio de este caso de uso es la cantidad pendiente, y ahí está el cambio de fondo
 * respecto a la versión anterior: la comprobación ya no ocurre en JavaScript sobre un valor
 * leído al abrir la transacción, sino dentro del `UPDATE` condicional del repositorio. Dos
 * personas descargando el mismo albarán dejaban pasar las dos entregas y el `CHECK` de la
 * base paraba la segunda con un error de restricción sin traducir; ahora la segunda recibe
 * el 422 que explica lo que ha pasado.
 */
@Injectable()
export class ReceivePurchaseOrderUseCase implements UseCase<
  ReceivePurchaseOrderInput,
  PurchaseOrderView
> {
  constructor(
    @Inject(PURCHASE_ORDER_REPOSITORY) private readonly orders: PurchaseOrderRepository,
    private readonly receiveStock: ReceiveStockUseCase,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    private readonly views: PurchaseOrderViewFactory,
  ) {}

  async execute(input: ReceivePurchaseOrderInput): Promise<PurchaseOrderView> {
    if (input.lines.length === 0) {
      throw new BusinessRuleViolationError('EMPTY_RECEIPT', 'Indique al menos una línea recibida');
    }

    const received = await this.uow.execute(async () => {
      const order = await this.orders.findByIdForUpdate(input.orderId);
      if (!order) {
        throw new BusinessRuleViolationError(
          'PURCHASE_NOT_RECEIVABLE',
          'El pedido no está disponible para recepción',
        );
      }

      order.assertReceivable();

      const now = this.clock.now();

      for (const receipt of input.lines) {
        const quantity = Quantity.fromDecimal(receipt.quantity);
        const line = order.planReceipt(receipt.lineId, quantity);

        await this.receiveIntoInventory({ order, line, receipt, quantity, input, now });

        const applied = await this.orders.receiveLine(line, quantity, now);
        if (!applied) {
          // La condición del `UPDATE` no se cumplió al escribir: otra entrega se adelantó.
          // Al lanzar aquí, la transacción revierte también la entrada de inventario que
          // se acaba de hacer, de modo que no queda stock sin pedido que lo justifique.
          throw new BusinessRuleViolationError(
            'INVALID_RECEIPT_QUANTITY',
            `La cantidad recibida de ${line.id} supera el pendiente`,
          );
        }

        order.applyReceipt(line.id, quantity, now, input.actorId);
      }

      // Se relee para decidir el estado: otra entrega confirmada puede haber completado
      // líneas distintas de las de esta petición.
      const refreshed = await this.orders.findByIdOrFail(order.id);
      const status = refreshed.statusAfterReceipt();

      await this.orders.settleReceipt(
        order.id,
        status,
        status === 'RECEIVED' ? now : null,
        now,
        input.actorId,
      );

      await this.audit.record({
        action: 'UPDATE',
        entityType: 'PurchaseOrder',
        entityId: order.id,
        metadata: { receipt: true },
      });

      return this.orders.findByIdOrFail(order.id);
    });

    return this.views.forOne(received, true);
  }

  private receiveIntoInventory(params: {
    order: PurchaseOrder;
    line: PurchaseOrderLine;
    receipt: ReceiptLineInput;
    quantity: Quantity;
    input: ReceivePurchaseOrderInput;
    now: Date;
  }): Promise<unknown> {
    const { order, line, receipt, quantity, input } = params;

    return this.receiveStock.execute({
      tenantId: input.tenantId,
      productId: line.productId,
      quantity: quantity.toNumber(),
      unitCost: line.unitCost.toDecimalString(),
      currency: line.unitCost.currency,
      supplierId: order.supplierId,
      purchaseOrderId: order.id,
      batchNumber: receipt.batchNumber,
      expiresAt: receipt.expiresAt ? new Date(receipt.expiresAt) : undefined,
      reason: `Recepción ${order.number}`,
      actorId: input.actorId,
    });
  }
}
