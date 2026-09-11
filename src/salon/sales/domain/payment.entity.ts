import { BusinessRuleViolationError, DomainValidationError } from '../../../shared/domain/errors';
import { Entity } from '../../../shared/domain/primitives';
import { Money } from '../../../shared/domain/value-objects/money.vo';

/**
 * Cobro asociado a una factura (ADR-0014).
 *
 * Un cobro registrado **no se edita**: corregir uno equivocado se hace devolviéndolo, igual
 * que en el ledger de inventario y por el mismo motivo. Lo que ocurrió con el dinero es un
 * hecho, y un hecho no se reescribe.
 */

export type PaymentMethodValue =
  'CASH' | 'CARD' | 'TRANSFER' | 'BIZUM' | 'GIFT_CARD' | 'VOUCHER' | 'OTHER';

export type PaymentStatusValue =
  'PENDING' | 'COMPLETED' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';

export interface PaymentProps {
  readonly tenantId: string;
  readonly invoiceId: string;
  /** Sesión de caja a la que se imputa. Obligatorio en efectivo, nulo en el resto. */
  readonly sessionId: string | null;
  readonly method: PaymentMethodValue;
  readonly status: PaymentStatusValue;
  readonly amount: Money;
  readonly receivedAt: Date;
  readonly reference: string | null;
  readonly externalId: string | null;
  readonly notes: string | null;
  readonly refundedAt: Date | null;
  readonly refundedAmount: Money;
  readonly refundReason: string | null;
  readonly createdBy: string | null;
}

export class Payment extends Entity {
  private constructor(
    id: string,
    private props: PaymentProps,
  ) {
    super(id);
  }

  static receive(params: {
    id: string;
    tenantId: string;
    invoiceId: string;
    method: PaymentMethodValue;
    amount: Money;
    sessionId?: string | null;
    reference?: string | null;
    externalId?: string | null;
    notes?: string | null;
    now: Date;
    actorId: string | null;
  }): Payment {
    if (!params.amount.isPositive()) {
      throw new DomainValidationError('El importe cobrado debe ser mayor que cero', 'amount');
    }

    // El efectivo tiene que caer en una caja abierta. Sin sesión, el dinero entra en el
    // sistema y no aparece en ningún arqueo: el descuadre de esa noche sería inexplicable
    // porque el cobro existe y el cajón no sabe nada de él.
    if (params.method === 'CASH' && !params.sessionId) {
      throw new BusinessRuleViolationError(
        'CASH_REQUIRES_OPEN_SESSION',
        'Un cobro en efectivo necesita una caja abierta a la que imputarse',
        { invoiceId: params.invoiceId },
      );
    }

    return new Payment(params.id, {
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      sessionId: params.sessionId ?? null,
      method: params.method,
      status: 'COMPLETED',
      amount: params.amount,
      receivedAt: params.now,
      reference: params.reference?.trim() || null,
      externalId: params.externalId?.trim() || null,
      notes: params.notes?.trim() || null,
      refundedAt: null,
      refundedAmount: Money.zero(params.amount.currency),
      refundReason: null,
      createdBy: params.actorId,
    });
  }

  static rehydrate(id: string, props: PaymentProps): Payment {
    return new Payment(id, props);
  }

  // -- Acceso ---------------------------------------------------------------

  get tenantId(): string {
    return this.props.tenantId;
  }
  get invoiceId(): string {
    return this.props.invoiceId;
  }
  get sessionId(): string | null {
    return this.props.sessionId;
  }
  get method(): PaymentMethodValue {
    return this.props.method;
  }
  get status(): PaymentStatusValue {
    return this.props.status;
  }
  get amount(): Money {
    return this.props.amount;
  }
  get receivedAt(): Date {
    return this.props.receivedAt;
  }
  get reference(): string | null {
    return this.props.reference;
  }
  get externalId(): string | null {
    return this.props.externalId;
  }
  get notes(): string | null {
    return this.props.notes;
  }
  get refundedAt(): Date | null {
    return this.props.refundedAt;
  }
  get refundedAmount(): Money {
    return this.props.refundedAmount;
  }
  get refundReason(): string | null {
    return this.props.refundReason;
  }
  get createdBy(): string | null {
    return this.props.createdBy;
  }

  get isCash(): boolean {
    return this.props.method === 'CASH';
  }

  /** Lo que queda tras las devoluciones. Es lo que cuenta para el arqueo. */
  get netAmount(): Money {
    return this.props.amount.subtract(this.props.refundedAmount);
  }

  /**
   * Devuelve parte o todo el cobro.
   *
   * Admite devoluciones parciales porque son corrientes —el cliente devuelve uno de los tres
   * productos— y porque forzar la devolución total obligaría a rehacer el cobro por la
   * diferencia, que es más pasos y más sitios donde equivocarse.
   */
  refund(amount: Money, reason: string, now: Date): void {
    if (this.props.status === 'REFUNDED') {
      throw new BusinessRuleViolationError(
        'PAYMENT_ALREADY_REFUNDED',
        'Este cobro ya se ha devuelto por completo',
        { paymentId: this.id },
      );
    }
    if (!amount.isPositive()) {
      throw new DomainValidationError('El importe a devolver debe ser mayor que cero', 'amount');
    }

    const refundedAmount = this.props.refundedAmount.add(amount);

    if (refundedAmount.greaterThan(this.props.amount)) {
      throw new BusinessRuleViolationError(
        'REFUND_EXCEEDS_PAYMENT',
        `No se pueden devolver ${refundedAmount.toString()} de un cobro de ${this.props.amount.toString()}`,
        {
          paymentId: this.id,
          amount: this.props.amount.toDecimalString(),
          attempted: refundedAmount.toDecimalString(),
        },
      );
    }

    const motivo = reason?.trim();
    if (!motivo) {
      throw new DomainValidationError('La devolución necesita un motivo', 'reason');
    }

    this.props = {
      ...this.props,
      refundedAmount,
      refundedAt: now,
      refundReason: motivo,
      status: refundedAmount.equals(this.props.amount) ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
    };
  }
}
