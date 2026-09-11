import {
  BusinessRuleViolationError,
  DomainValidationError,
  EntityNotFoundError,
} from '../../../shared/domain/errors';
import { Entity, type AuditMetadata } from '../../../shared/domain/primitives';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import { Percentage } from '../../../shared/domain/value-objects/time-range.vo';
import { Quantity } from './quantity.vo';

/**
 * Pedido de compra (ADR-0017).
 *
 * El agregado es el pedido **entero**: cabecera y líneas. Las líneas no tienen vida propia
 * —no se consultan sueltas ni se editan por separado—, y un repositorio de líneas
 * permitiría escribir una sin recalcular el total, que es el camino más corto a un pedido
 * que no suma.
 *
 * Lo que este agregado **no** hace es escribir. Decide: si el pedido admite envío, si una
 * recepción cabe en lo pendiente, en qué estado queda al completarse. La escritura la hace
 * el repositorio con sentencias condicionales, porque entre decidir y escribir cabe otra
 * petición (ADR-0013). Repartir así las dos mitades es lo que permite tener reglas
 * probables sin base de datos y atomicidad real al mismo tiempo.
 */

export type PurchaseOrderStatusValue =
  'DRAFT' | 'SUBMITTED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED';

export interface PurchaseOrderLine {
  readonly id: string;
  readonly productId: string;
  readonly quantity: Quantity;
  readonly receivedQuantity: Quantity;
  readonly unitCost: Money;
  readonly taxRate: Percentage;
  /** `unitCost × quantity`. Base imponible de la línea. */
  readonly lineSubtotal: Money;
  /** `lineSubtotal + impuesto`. Es lo único que persiste el esquema. */
  readonly lineTotal: Money;
  readonly notes: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PurchaseOrderProps {
  readonly tenantId: string;
  readonly supplierId: string;
  readonly number: string;
  readonly status: PurchaseOrderStatusValue;
  readonly orderedAt: Date | null;
  readonly expectedAt: Date | null;
  readonly receivedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly cancellationReason: string | null;
  readonly supplierReference: string | null;
  readonly notes: string | null;
  readonly lines: readonly PurchaseOrderLine[];
  readonly subtotal: Money;
  readonly taxTotal: Money;
  readonly total: Money;
  readonly currency: string;
  readonly audit: AuditMetadata;
}

/** Estados desde los que todavía puede entrar mercancía. */
const RECEIVABLE_STATUSES: ReadonlySet<PurchaseOrderStatusValue> = new Set([
  'SUBMITTED',
  'PARTIALLY_RECEIVED',
]);

/** Estados desde los que la cancelación sigue teniendo sentido. */
const CANCELLABLE_STATUSES: ReadonlySet<PurchaseOrderStatusValue> = new Set([
  'DRAFT',
  'SUBMITTED',
  'PARTIALLY_RECEIVED',
]);

export class PurchaseOrder extends Entity {
  private constructor(
    id: string,
    private props: PurchaseOrderProps,
  ) {
    super(id);
  }

  /**
   * Abre un pedido en borrador.
   *
   * Los totales se calculan aquí, una vez, y se guardan: las líneas de un pedido no
   * cambian después de crearlo —solo lo hace su cantidad recibida—, así que recalcularlos
   * en cada lectura sería trabajo sin objeto y una oportunidad de que un pedido antiguo
   * empezara a mostrar cifras distintas de las que se enviaron al proveedor.
   */
  static open(params: {
    id: string;
    tenantId: string;
    supplierId: string;
    number: string;
    currency: string;
    lines: readonly PurchaseOrderLine[];
    expectedAt?: Date | null;
    supplierReference?: string | null;
    notes?: string | null;
    now: Date;
    actorId: string | null;
  }): PurchaseOrder {
    if (params.lines.length === 0) {
      throw new BusinessRuleViolationError(
        'PURCHASE_WITHOUT_LINES',
        'El pedido debe contener al menos una línea',
      );
    }

    const mismatched = params.lines.find((line) => line.lineTotal.currency !== params.currency);
    if (mismatched) {
      throw new DomainValidationError(
        `Una línea está en ${mismatched.lineTotal.currency} y el pedido en ${params.currency}`,
        'currency',
      );
    }

    return new PurchaseOrder(params.id, {
      tenantId: params.tenantId,
      supplierId: params.supplierId,
      number: requireText(params.number, 'number', 'El pedido necesita un número'),
      status: 'DRAFT',
      orderedAt: null,
      expectedAt: params.expectedAt ?? null,
      receivedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      supplierReference: params.supplierReference ?? null,
      notes: params.notes ?? null,
      lines: params.lines,
      ...totalsOf(params.lines, params.currency),
      currency: params.currency,
      audit: {
        createdAt: params.now,
        updatedAt: params.now,
        deletedAt: null,
        createdBy: params.actorId,
        updatedBy: params.actorId,
        deletedBy: null,
      },
    });
  }

  static rehydrate(id: string, props: PurchaseOrderProps): PurchaseOrder {
    return new PurchaseOrder(id, props);
  }

  // -- Acceso ---------------------------------------------------------------

  get tenantId(): string {
    return this.props.tenantId;
  }
  get supplierId(): string {
    return this.props.supplierId;
  }
  get number(): string {
    return this.props.number;
  }
  get status(): PurchaseOrderStatusValue {
    return this.props.status;
  }
  get orderedAt(): Date | null {
    return this.props.orderedAt;
  }
  get expectedAt(): Date | null {
    return this.props.expectedAt;
  }
  get receivedAt(): Date | null {
    return this.props.receivedAt;
  }
  get cancelledAt(): Date | null {
    return this.props.cancelledAt;
  }
  get cancellationReason(): string | null {
    return this.props.cancellationReason;
  }
  get supplierReference(): string | null {
    return this.props.supplierReference;
  }
  get notes(): string | null {
    return this.props.notes;
  }
  get lines(): readonly PurchaseOrderLine[] {
    return this.props.lines;
  }
  get subtotal(): Money {
    return this.props.subtotal;
  }
  get taxTotal(): Money {
    return this.props.taxTotal;
  }
  get total(): Money {
    return this.props.total;
  }
  get currency(): string {
    return this.props.currency;
  }
  get audit(): AuditMetadata {
    return this.props.audit;
  }
  get isDeleted(): boolean {
    return this.props.audit.deletedAt !== null;
  }

  /** `true` si no queda nada pendiente en ninguna línea. */
  get isFullyReceived(): boolean {
    return this.props.lines.every((line) =>
      line.receivedQuantity.greaterThanOrEqual(line.quantity),
    );
  }

  /** Estado en el que queda el pedido tras una entrega. */
  statusAfterReceipt(): PurchaseOrderStatusValue {
    return this.isFullyReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
  }

  // -- Decisiones -----------------------------------------------------------

  /**
   * Comprueba que el pedido admite ser enviado al proveedor.
   *
   * No cambia el estado: la transición la escribe el repositorio con un `UPDATE`
   * condicionado al estado de partida, de modo que dos envíos simultáneos no puedan
   * prosperar los dos. Aquí solo vive el criterio.
   */
  assertCanSubmit(): void {
    if (this.props.status !== 'DRAFT') {
      throw new BusinessRuleViolationError(
        'PURCHASE_NOT_DRAFT',
        'Solo se puede enviar un pedido en borrador',
      );
    }
  }

  assertCanCancel(): void {
    if (!CANCELLABLE_STATUSES.has(this.props.status)) {
      throw new BusinessRuleViolationError(
        'PURCHASE_CANNOT_CANCEL',
        'El pedido no admite cancelación en su estado actual',
      );
    }
  }

  assertReceivable(): void {
    if (!RECEIVABLE_STATUSES.has(this.props.status)) {
      throw new BusinessRuleViolationError(
        'PURCHASE_NOT_RECEIVABLE',
        'El pedido no está disponible para recepción',
      );
    }
  }

  /** Lo que queda por recibir de una línea. */
  pendingOf(line: PurchaseOrderLine): Quantity {
    return line.quantity.subtract(line.receivedQuantity);
  }

  /**
   * Valida una entrega contra lo pendiente y devuelve la línea afectada.
   *
   * La resta es exacta porque `Quantity` guarda milésimas enteras: con `number`,
   * `0,3 − 0,1` daba `0,19999999999999998` y una entrega de `0,2` —perfectamente
   * legítima— se rechazaba.
   */
  planReceipt(lineId: string, quantity: Quantity): PurchaseOrderLine {
    const line = this.props.lines.find((candidate) => candidate.id === lineId);
    if (!line) {
      throw new EntityNotFoundError('Línea de pedido', lineId);
    }

    if (!quantity.isPositive() || quantity.greaterThan(this.pendingOf(line))) {
      throw new BusinessRuleViolationError(
        'INVALID_RECEIPT_QUANTITY',
        `La cantidad recibida de ${lineId} supera el pendiente`,
      );
    }

    return line;
  }

  /**
   * Anota en memoria una entrega ya escrita.
   *
   * Lo llama el caso de uso tras confirmar la escritura atómica, para que el agregado
   * refleje el pedido tal como quedó y `isFullyReceived` responda sobre la realidad. No
   * persiste nada por su cuenta.
   */
  applyReceipt(lineId: string, quantity: Quantity, now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      lines: this.props.lines.map((line) =>
        line.id === lineId
          ? { ...line, receivedQuantity: line.receivedQuantity.add(quantity), updatedAt: now }
          : line,
      ),
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  markDeleted(now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      audit: {
        ...this.props.audit,
        deletedAt: now,
        deletedBy: actorId,
        updatedAt: now,
        updatedBy: actorId,
      },
    };
  }

  markRestored(now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      audit: {
        ...this.props.audit,
        deletedAt: null,
        deletedBy: null,
        updatedAt: now,
        updatedBy: actorId,
      },
    };
  }
}

// ---------------------------------------------------------------------------

/**
 * Calcula una línea de pedido.
 *
 * Es **la** regla aritmética del módulo y por eso está aquí y no en el caso de uso: el
 * pedido que se envía al proveedor, el total que se guarda y lo que después se concilia
 * con su factura tienen que salir del mismo sitio.
 *
 * El impuesto se aplica sobre la base de la línea, y el redondeo ocurre dentro de `Money`,
 * una sola vez. La versión anterior multiplicaba con `number` y persistía con `.toFixed(2)`:
 * cada línea arrastraba el error binario de `cantidad × coste` y el total podía separarse
 * por céntimos del que calculaba ventas para la misma mercancía (ADR-0010).
 */
export const buildPurchaseOrderLine = (params: {
  id: string;
  productId: string;
  quantity: Quantity;
  unitCost: Money;
  taxRate: Percentage;
  receivedQuantity?: Quantity;
  notes?: string | null;
  now: Date;
}): PurchaseOrderLine => {
  if (!params.quantity.isPositive()) {
    throw new DomainValidationError('La cantidad debe ser mayor que cero', 'quantity');
  }
  if (params.unitCost.isNegative()) {
    throw new DomainValidationError('El coste unitario no puede ser negativo', 'unitCost');
  }

  const lineSubtotal = params.unitCost.multiply(params.quantity.toNumber());

  return {
    id: params.id,
    productId: params.productId,
    quantity: params.quantity,
    receivedQuantity: params.receivedQuantity ?? Quantity.zero(),
    unitCost: params.unitCost,
    taxRate: params.taxRate,
    lineSubtotal,
    lineTotal: lineSubtotal.add(lineSubtotal.percentage(params.taxRate.value)),
    notes: params.notes ?? null,
    createdAt: params.now,
    updatedAt: params.now,
  };
};

/**
 * Totales del documento.
 *
 * El total sale de sumar los totales de línea y el impuesto de la diferencia con la base,
 * no de sumar los impuestos por separado. Con varios tipos impositivos las dos vías pueden
 * separarse un céntimo, y la que cuadra con lo que el proveedor factura línea a línea es
 * ésta.
 */
const totalsOf = (
  lines: readonly PurchaseOrderLine[],
  currency: string,
): { subtotal: Money; taxTotal: Money; total: Money } => {
  const subtotal = Money.sum(
    lines.map((line) => line.lineSubtotal),
    currency,
  );
  const total = Money.sum(
    lines.map((line) => line.lineTotal),
    currency,
  );
  return { subtotal, taxTotal: total.subtract(subtotal), total };
};

const requireText = (value: string, field: string, message: string): string => {
  const text = value?.trim();
  if (!text) throw new DomainValidationError(message, field);
  return text;
};
