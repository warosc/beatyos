import { DomainValidationError } from '../../../shared/domain/errors';
import { Entity } from '../../../shared/domain/primitives';
import { Money } from '../../../shared/domain/value-objects/money.vo';

/**
 * Asiento del kardex (ADR-0011).
 *
 * Es la **fuente de verdad** de las existencias; `Product.stockOnHand` es solo su suma
 * materializada. El ledger es de solo anexión: un movimiento registrado no se modifica ni
 * se borra, y un trigger de PostgreSQL lo impide aunque alguien lo intente por SQL directo.
 *
 * Por eso esta entidad no tiene un solo método que mute nada. Corregir un movimiento
 * equivocado se hace registrando el contrario, igual que en cualquier contabilidad: el
 * error queda a la vista y la corrección también, que es justo lo que una auditoría espera
 * encontrar.
 */

export type MovementTypeValue =
  | 'PURCHASE_IN'
  | 'SALE_OUT'
  | 'SERVICE_CONSUMPTION'
  | 'ADJUSTMENT'
  | 'RETURN_IN'
  | 'WASTE_OUT'
  | 'INITIAL_STOCK';

export type MovementSourceTypeValue =
  'PURCHASE_ORDER' | 'INVOICE' | 'APPOINTMENT' | 'STOCK_COUNT' | 'MANUAL';

/**
 * Signo esperado de cada tipo de movimiento.
 *
 * `ADJUSTMENT` es el único de doble sentido: un recuento puede encontrar de más o de
 * menos. El resto tiene una dirección natural, y registrar una venta que *aumenta* las
 * existencias es siempre un error de signo en quien llama —normalmente un `-` de más— que
 * conviene parar aquí y no descubrir cuadrando el almacén a fin de mes.
 */
const EXPECTED_SIGN: Readonly<Record<MovementTypeValue, 'in' | 'out' | 'any'>> = {
  PURCHASE_IN: 'in',
  RETURN_IN: 'in',
  INITIAL_STOCK: 'in',
  SALE_OUT: 'out',
  SERVICE_CONSUMPTION: 'out',
  WASTE_OUT: 'out',
  ADJUSTMENT: 'any',
};

export interface InventoryMovementProps {
  readonly tenantId: string;
  readonly productId: string;
  readonly type: MovementTypeValue;
  /** Con signo: positivo entra, negativo sale. Nunca cero. */
  readonly quantityDelta: number;
  /** Existencias tras aplicar el movimiento. Permite auditar sin recalcular la serie. */
  readonly balanceAfter: number;
  /** Coste de la unidad en este movimiento. Real si viene de un lote (ADR-0012). */
  readonly unitCost: Money | null;
  readonly sourceType: MovementSourceTypeValue;
  readonly sourceId: string | null;
  readonly reason: string | null;
  readonly notes: string | null;
  readonly batchId: string | null;
  readonly purchaseOrderId: string | null;
  readonly occurredAt: Date;
  readonly createdBy: string | null;
}

export class InventoryMovement extends Entity {
  private constructor(
    id: string,
    private readonly props: InventoryMovementProps,
  ) {
    super(id);
  }

  static record(params: {
    id: string;
    tenantId: string;
    productId: string;
    type: MovementTypeValue;
    quantityDelta: number;
    balanceAfter: number;
    unitCost?: Money | null;
    sourceType?: MovementSourceTypeValue;
    sourceId?: string | null;
    reason?: string | null;
    notes?: string | null;
    batchId?: string | null;
    purchaseOrderId?: string | null;
    now: Date;
    actorId: string | null;
  }): InventoryMovement {
    const delta = round3(params.quantityDelta);

    if (!Number.isFinite(delta) || delta === 0) {
      throw new DomainValidationError(
        'Un movimiento de existencias no puede ser de cero unidades',
        'quantityDelta',
      );
    }

    const expected = EXPECTED_SIGN[params.type];
    if (expected === 'in' && delta < 0) {
      throw new DomainValidationError(
        `Un movimiento de tipo ${params.type} suma existencias y se recibió ${delta}`,
        'quantityDelta',
      );
    }
    if (expected === 'out' && delta > 0) {
      throw new DomainValidationError(
        `Un movimiento de tipo ${params.type} resta existencias y se recibió ${delta}`,
        'quantityDelta',
      );
    }

    if (params.balanceAfter < 0) {
      throw new DomainValidationError(
        'Un movimiento no puede dejar existencias negativas',
        'balanceAfter',
      );
    }
    if (params.unitCost?.isNegative()) {
      throw new DomainValidationError('El coste unitario no puede ser negativo', 'unitCost');
    }

    return new InventoryMovement(params.id, {
      tenantId: params.tenantId,
      productId: params.productId,
      type: params.type,
      quantityDelta: delta,
      balanceAfter: round3(params.balanceAfter),
      unitCost: params.unitCost ?? null,
      sourceType: params.sourceType ?? 'MANUAL',
      sourceId: params.sourceId ?? null,
      reason: params.reason?.trim() || null,
      notes: params.notes?.trim() || null,
      batchId: params.batchId ?? null,
      purchaseOrderId: params.purchaseOrderId ?? null,
      occurredAt: params.now,
      createdBy: params.actorId,
    });
  }

  static rehydrate(id: string, props: InventoryMovementProps): InventoryMovement {
    return new InventoryMovement(id, props);
  }

  // -- Acceso ---------------------------------------------------------------

  get tenantId(): string {
    return this.props.tenantId;
  }
  get productId(): string {
    return this.props.productId;
  }
  get type(): MovementTypeValue {
    return this.props.type;
  }
  get quantityDelta(): number {
    return this.props.quantityDelta;
  }
  get balanceAfter(): number {
    return this.props.balanceAfter;
  }
  get unitCost(): Money | null {
    return this.props.unitCost;
  }
  get sourceType(): MovementSourceTypeValue {
    return this.props.sourceType;
  }
  get sourceId(): string | null {
    return this.props.sourceId;
  }
  get reason(): string | null {
    return this.props.reason;
  }
  get notes(): string | null {
    return this.props.notes;
  }
  get batchId(): string | null {
    return this.props.batchId;
  }
  get purchaseOrderId(): string | null {
    return this.props.purchaseOrderId;
  }
  get occurredAt(): Date {
    return this.props.occurredAt;
  }
  get createdBy(): string | null {
    return this.props.createdBy;
  }

  get isInbound(): boolean {
    return this.props.quantityDelta > 0;
  }

  /** Valor del movimiento: cantidad por coste. `null` si no se conocía el coste. */
  get value(): Money | null {
    return this.props.unitCost?.multiply(Math.abs(this.props.quantityDelta)) ?? null;
  }
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
