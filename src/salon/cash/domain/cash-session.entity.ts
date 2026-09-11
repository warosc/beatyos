import {
  BusinessRuleViolationError,
  DomainValidationError,
  InvalidStateTransitionError,
} from '../../../shared/domain/errors';
import { Entity, type AuditMetadata } from '../../../shared/domain/primitives';
import { Money } from '../../../shared/domain/value-objects/money.vo';

/**
 * Sesión de caja: la jornada de un cajón de efectivo (ADR-0014).
 *
 * Se abre con un fondo, recoge los cobros en efectivo del día y se cierra contando lo que
 * hay. La cifra que importa es **la diferencia** entre lo contado y lo esperado, porque es
 * la que detecta un error de cambio, un cobro no registrado o una sustracción.
 *
 * Esa cifra se calcula **aquí y en un solo sitio**. La versión anterior la calculaba dos
 * veces —una al pintar la caja abierta y otra al cerrarla— con dos trozos de código
 * distintos, y basta con que uno de los dos olvide un tipo de movimiento para que el arqueo
 * cuadre en pantalla y no al cerrar, que es la peor combinación posible: el descuadre
 * aparece cuando ya no se puede investigar.
 */

export type CashSessionStatusValue = 'OPEN' | 'CLOSED';

export type CashMovementTypeValue =
  'CASH_IN' | 'CASH_OUT' | 'WITHDRAWAL' | 'EXPENSE' | 'CORRECTION';

export interface CashMovement {
  readonly id: string;
  readonly type: CashMovementTypeValue;
  /** Siempre positivo. El sentido lo da el tipo, no el signo. */
  readonly amount: Money;
  readonly concept: string;
  readonly reference: string | null;
  readonly notes: string | null;
  readonly occurredAt: Date;
  readonly createdBy: string | null;
}

/**
 * Sentido de cada tipo de movimiento.
 *
 * El importe se guarda siempre positivo y el sentido lo aporta el tipo. Guardarlo con signo
 * parecería más simple y abre la puerta a un `CASH_IN` negativo, que es una salida
 * disfrazada de entrada: el informe de caja la contaría como ingreso y el arqueo cuadraría
 * ocultando exactamente lo que debería destacar.
 *
 * `CORRECTION` es la excepción deliberada: existe para cuadrar un descuadre conocido y
 * puede ir en los dos sentidos, así que es el único que admite signo.
 */
const MOVEMENT_SIGN: Readonly<Record<CashMovementTypeValue, 1 | -1 | 0>> = {
  CASH_IN: 1,
  CASH_OUT: -1,
  WITHDRAWAL: -1,
  EXPENSE: -1,
  CORRECTION: 0,
};

export interface CashSessionProps {
  readonly tenantId: string;
  readonly openedById: string;
  readonly status: CashSessionStatusValue;
  readonly openedAt: Date;
  readonly openingFloat: Money;
  readonly closedAt: Date | null;
  readonly closedById: string | null;
  readonly countedAmount: Money | null;
  readonly expectedAmount: Money | null;
  readonly difference: Money | null;
  readonly currency: string;
  readonly notes: string | null;
  readonly movements: readonly CashMovement[];
  readonly audit: AuditMetadata;
}

export class CashSession extends Entity {
  private constructor(
    id: string,
    private props: CashSessionProps,
  ) {
    super(id);
  }

  static open(params: {
    id: string;
    tenantId: string;
    openedById: string;
    openingFloat: Money;
    notes?: string | null;
    now: Date;
    actorId: string | null;
  }): CashSession {
    if (params.openingFloat.isNegative()) {
      throw new DomainValidationError('El fondo de caja no puede ser negativo', 'openingFloat');
    }

    return new CashSession(params.id, {
      tenantId: params.tenantId,
      openedById: params.openedById,
      status: 'OPEN',
      openedAt: params.now,
      openingFloat: params.openingFloat,
      closedAt: null,
      closedById: null,
      countedAmount: null,
      expectedAmount: null,
      difference: null,
      currency: params.openingFloat.currency,
      notes: params.notes?.trim() || null,
      movements: [],
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

  static rehydrate(id: string, props: CashSessionProps): CashSession {
    return new CashSession(id, props);
  }

  // -- Acceso ---------------------------------------------------------------

  get tenantId(): string {
    return this.props.tenantId;
  }
  get openedById(): string {
    return this.props.openedById;
  }
  get status(): CashSessionStatusValue {
    return this.props.status;
  }
  get openedAt(): Date {
    return this.props.openedAt;
  }
  get openingFloat(): Money {
    return this.props.openingFloat;
  }
  get closedAt(): Date | null {
    return this.props.closedAt;
  }
  get closedById(): string | null {
    return this.props.closedById;
  }
  get countedAmount(): Money | null {
    return this.props.countedAmount;
  }
  get difference(): Money | null {
    return this.props.difference;
  }
  /**
   * Cifra esperada **congelada** al cerrar. `null` mientras la caja siga abierta.
   *
   * Se expone aparte de `expectedAmount()` para que quien persiste la sesión no tenga que
   * inventarse unos cobros que no conoce solo para leer un valor que ya está decidido.
   */
  get settledExpectedAmount(): Money | null {
    return this.props.expectedAmount;
  }
  get currency(): string {
    return this.props.currency;
  }
  get notes(): string | null {
    return this.props.notes;
  }
  get movements(): readonly CashMovement[] {
    return this.props.movements;
  }
  get audit(): AuditMetadata {
    return this.props.audit;
  }
  get isOpen(): boolean {
    return this.props.status === 'OPEN';
  }
  get isDeleted(): boolean {
    return this.props.audit.deletedAt !== null;
  }

  /** Neto de los movimientos manuales: entradas menos salidas. */
  get netMovements(): Money {
    return this.props.movements.reduce((total, movement) => {
      const sign = MOVEMENT_SIGN[movement.type];
      // `CORRECTION` va con el signo que traiga el importe; el resto lo impone su tipo.
      if (sign === 0) return total.add(movement.amount);
      return sign === 1 ? total.add(movement.amount) : total.subtract(movement.amount);
    }, Money.zero(this.props.currency));
  }

  /**
   * Efectivo que debería haber en el cajón.
   *
   * Fondo de apertura, más lo cobrado en efectivo, más el neto de los movimientos manuales.
   * `cashSales` viene de fuera porque los cobros pertenecen a las facturas y no a la caja:
   * meterlos en este agregado obligaría a cargar todas las facturas del día para poder
   * abrir la pantalla.
   */
  expectedAmount(cashSales: Money): Money {
    if (cashSales.currency !== this.props.currency) {
      throw new DomainValidationError(
        `Los cobros están en ${cashSales.currency} y la caja opera en ${this.props.currency}`,
        'currency',
      );
    }
    // En una sesión ya cerrada manda la cifra congelada: recalcularla daría un número
    // distinto si alguien anota algo después, y el arqueo dejaría de ser un hecho histórico.
    return (
      this.props.expectedAmount ?? this.props.openingFloat.add(cashSales).add(this.netMovements)
    );
  }

  // -- Comportamiento -------------------------------------------------------

  /**
   * Anota una entrada o salida manual de efectivo.
   *
   * El concepto es obligatorio a propósito: un movimiento de caja sin explicación es
   * indistinguible de un descuadre, y el motivo de que exista este registro es precisamente
   * poder distinguirlos.
   */
  recordMovement(params: {
    id: string;
    type: CashMovementTypeValue;
    amount: Money;
    concept: string;
    reference?: string | null;
    notes?: string | null;
    now: Date;
    actorId: string | null;
  }): CashMovement {
    if (!this.isOpen) {
      throw new InvalidStateTransitionError('Caja', this.props.status, 'con movimientos');
    }
    if (params.amount.currency !== this.props.currency) {
      throw new DomainValidationError(
        `El movimiento está en ${params.amount.currency} y la caja opera en ${this.props.currency}`,
        'currency',
      );
    }
    if (params.amount.isZero()) {
      throw new DomainValidationError('Un movimiento de caja no puede ser de cero', 'amount');
    }
    if (params.amount.isNegative() && params.type !== 'CORRECTION') {
      throw new DomainValidationError(
        `Un movimiento de tipo ${params.type} lleva importe positivo; el sentido lo da el tipo`,
        'amount',
      );
    }

    const concept = params.concept?.trim();
    if (!concept) {
      throw new DomainValidationError('El movimiento de caja necesita un concepto', 'concept');
    }

    // Sacar más de lo que hay en el cajón es físicamente imposible: o el importe está mal
    // o falta registrar una entrada. En cualquier caso hay que pararlo, no anotarlo.
    if (MOVEMENT_SIGN[params.type] === -1) {
      const available = this.props.openingFloat.add(this.netMovements);
      if (params.amount.greaterThan(available)) {
        throw new BusinessRuleViolationError(
          'INSUFFICIENT_CASH',
          `No se pueden sacar ${params.amount.toString()}: el fondo y los movimientos suman ${available.toString()}`,
          {
            sessionId: this.id,
            available: available.toDecimalString(),
            requested: params.amount.toDecimalString(),
          },
        );
      }
    }

    const movement: CashMovement = {
      id: params.id,
      type: params.type,
      amount: params.amount,
      concept,
      reference: params.reference?.trim() || null,
      notes: params.notes?.trim() || null,
      occurredAt: params.now,
      createdBy: params.actorId,
    };

    this.props = {
      ...this.props,
      movements: [...this.props.movements, movement],
      audit: { ...this.props.audit, updatedAt: params.now, updatedBy: params.actorId },
    };

    return movement;
  }

  /**
   * Cierra la caja contando el efectivo.
   *
   * Congela lo esperado y la diferencia. No rechaza un descuadre —el dinero que hay es el
   * que hay— pero lo deja registrado: el arqueo sirve para **medir** la discrepancia, no
   * para negarla, y una caja que solo se deja cerrar cuando cuadra acaba cuadrando siempre
   * porque alguien ajusta el recuento.
   */
  close(params: {
    countedAmount: Money;
    cashSales: Money;
    notes?: string | null;
    now: Date;
    actorId: string | null;
  }): void {
    if (!this.isOpen) {
      throw new InvalidStateTransitionError('Caja', this.props.status, 'CLOSED');
    }
    if (params.countedAmount.isNegative()) {
      throw new DomainValidationError('El recuento no puede ser negativo', 'countedAmount');
    }
    if (params.countedAmount.currency !== this.props.currency) {
      throw new DomainValidationError(
        `El recuento está en ${params.countedAmount.currency} y la caja opera en ${this.props.currency}`,
        'currency',
      );
    }

    const expectedAmount = this.expectedAmount(params.cashSales);

    this.props = {
      ...this.props,
      status: 'CLOSED',
      closedAt: params.now,
      closedById: params.actorId,
      countedAmount: params.countedAmount,
      expectedAmount,
      difference: params.countedAmount.subtract(expectedAmount),
      notes: params.notes?.trim() || this.props.notes,
      audit: { ...this.props.audit, updatedAt: params.now, updatedBy: params.actorId },
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
