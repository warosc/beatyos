import {
  BusinessRuleViolationError,
  DomainValidationError,
  InvalidStateTransitionError,
} from '../../../shared/domain/errors';
import { Entity, type AuditMetadata } from '../../../shared/domain/primitives';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import { Percentage } from '../../../shared/domain/value-objects/time-range.vo';

/**
 * Factura (ADR-0014).
 *
 * Es un **documento histórico**: una vez emitida no se modifica. Corregir una factura
 * equivocada se hace anulándola y emitiendo otra, igual que en cualquier contabilidad, y
 * por eso los datos fiscales del cliente se congelan al emitir en lugar de leerse de la
 * ficha —que puede haber cambiado de dirección tres veces desde entonces—.
 *
 * Toda la aritmética es en `Money`. No es purismo: la versión anterior calculaba el IVA con
 * `(subtotal * taxRate) / 100` sobre `number` y comparaba el total con lo cobrado usando
 * una tolerancia de un céntimo. Esa tolerancia es la confesión de que las cifras no
 * cuadraban, y en una caja el descuadre lo ve el usuario al final del día.
 */

export type InvoiceStatusValue =
  'DRAFT' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'VOID';

export type InvoiceLineKindValue = 'SERVICE' | 'PRODUCT' | 'DISCOUNT' | 'OTHER';

export interface InvoiceLine {
  readonly id: string;
  readonly kind: InvoiceLineKindValue;
  readonly serviceId: string | null;
  readonly productId: string | null;
  readonly stylistId: string | null;
  readonly description: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly discountAmount: Money;
  readonly taxRate: Percentage;
  readonly taxAmount: Money;
  /** `unitPrice × quantity − descuento`. Base imponible de la línea. */
  readonly lineSubtotal: Money;
  /** `lineSubtotal + taxAmount`. */
  readonly lineTotal: Money;
  readonly commissionRate: Percentage | null;
  readonly commissionAmount: Money;
  readonly sortOrder: number;
}

export interface InvoiceProps {
  readonly tenantId: string;
  readonly clientId: string | null;
  readonly appointmentId: string | null;
  readonly number: string;
  readonly status: InvoiceStatusValue;
  readonly issuedAt: Date | null;
  readonly dueAt: Date | null;
  readonly paidAt: Date | null;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly lines: readonly InvoiceLine[];
  readonly paidTotal: Money;
  readonly currency: string;
  readonly notes: string | null;
  readonly billingSnapshot: Record<string, unknown> | null;
  readonly audit: AuditMetadata;
}

/** Estados desde los que todavía se puede cobrar. */
const PAYABLE_STATUSES: ReadonlySet<InvoiceStatusValue> = new Set([
  'ISSUED',
  'PARTIALLY_PAID',
  'OVERDUE',
]);

export class Invoice extends Entity {
  private constructor(
    id: string,
    private props: InvoiceProps,
  ) {
    super(id);
  }

  /**
   * Emite la factura directamente, sin pasar por borrador.
   *
   * Es lo que ocurre en el mostrador: no hay un paso previo de revisión, se cobra y se
   * emite. El borrador tiene sentido para presupuestos y facturación a empresa, que es otro
   * flujo; forzar aquí un `DRAFT` intermedio solo añadiría un estado por el que nadie pasa.
   */
  static issue(params: {
    id: string;
    tenantId: string;
    number: string;
    lines: readonly InvoiceLine[];
    currency: string;
    clientId?: string | null;
    appointmentId?: string | null;
    dueAt?: Date | null;
    notes?: string | null;
    billingSnapshot?: Record<string, unknown> | null;
    now: Date;
    actorId: string | null;
  }): Invoice {
    if (params.lines.length === 0) {
      throw new DomainValidationError('Una factura necesita al menos una línea', 'lines');
    }

    const mismatched = params.lines.find((line) => line.lineTotal.currency !== params.currency);
    if (mismatched) {
      // Mezclar monedas en un mismo documento produce un total que no significa nada.
      // Convertir por nuestra cuenta sería peor: aplicaría un tipo de cambio que nadie ha
      // elegido, en un momento que nadie ha decidido.
      throw new DomainValidationError(
        `La línea «${mismatched.description}» está en ${mismatched.lineTotal.currency} y la factura en ${params.currency}`,
        'currency',
      );
    }

    return new Invoice(params.id, {
      tenantId: params.tenantId,
      clientId: params.clientId ?? null,
      appointmentId: params.appointmentId ?? null,
      number: requireText(params.number, 'number', 'El número de factura es obligatorio'),
      status: 'ISSUED',
      issuedAt: params.now,
      dueAt: params.dueAt ?? null,
      paidAt: null,
      voidedAt: null,
      voidReason: null,
      lines: [...params.lines].sort((a, b) => a.sortOrder - b.sortOrder),
      paidTotal: Money.zero(params.currency),
      currency: params.currency,
      notes: params.notes?.trim() || null,
      billingSnapshot: params.billingSnapshot ?? null,
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

  static rehydrate(id: string, props: InvoiceProps): Invoice {
    return new Invoice(id, props);
  }

  // -- Acceso ---------------------------------------------------------------

  get tenantId(): string {
    return this.props.tenantId;
  }
  get clientId(): string | null {
    return this.props.clientId;
  }
  get appointmentId(): string | null {
    return this.props.appointmentId;
  }
  get number(): string {
    return this.props.number;
  }
  get status(): InvoiceStatusValue {
    return this.props.status;
  }
  get issuedAt(): Date | null {
    return this.props.issuedAt;
  }
  get dueAt(): Date | null {
    return this.props.dueAt;
  }
  get paidAt(): Date | null {
    return this.props.paidAt;
  }
  get voidedAt(): Date | null {
    return this.props.voidedAt;
  }
  get voidReason(): string | null {
    return this.props.voidReason;
  }
  get lines(): readonly InvoiceLine[] {
    return this.props.lines;
  }
  get currency(): string {
    return this.props.currency;
  }
  get notes(): string | null {
    return this.props.notes;
  }
  get billingSnapshot(): Record<string, unknown> | null {
    return this.props.billingSnapshot;
  }
  get audit(): AuditMetadata {
    return this.props.audit;
  }
  get isDeleted(): boolean {
    return this.props.audit.deletedAt !== null;
  }

  /** Base imponible: la suma de las líneas antes de impuestos. */
  get subtotal(): Money {
    return Money.sum(
      this.props.lines.map((line) => line.lineSubtotal),
      this.props.currency,
    );
  }

  get discountTotal(): Money {
    return Money.sum(
      this.props.lines.map((line) => line.discountAmount),
      this.props.currency,
    );
  }

  get taxTotal(): Money {
    return Money.sum(
      this.props.lines.map((line) => line.taxAmount),
      this.props.currency,
    );
  }

  /**
   * Total del documento.
   *
   * Se calcula sumando los totales de línea, **no** `subtotal + taxTotal`. La diferencia
   * aparece con varios tipos de IVA: redondear el impuesto una vez sobre la base agregada
   * puede dar un céntimo distinto que redondearlo línea a línea, y lo que el cliente ve
   * desglosado en el papel son las líneas. Que el total case con la suma de lo impreso es
   * lo que evita la factura que el cliente rechaza.
   */
  get total(): Money {
    return Money.sum(
      this.props.lines.map((line) => line.lineTotal),
      this.props.currency,
    );
  }

  get paidTotal(): Money {
    return this.props.paidTotal;
  }

  get balanceDue(): Money {
    return this.total.subtract(this.props.paidTotal);
  }

  /** Comisiones devengadas por los profesionales en esta factura. */
  get commissionTotal(): Money {
    return Money.sum(
      this.props.lines.map((line) => line.commissionAmount),
      this.props.currency,
    );
  }

  get isPaid(): boolean {
    return this.props.status === 'PAID';
  }

  get isVoid(): boolean {
    return this.props.status === 'VOID';
  }

  /** Líneas de producto, que son las que mueven existencias. */
  get productLines(): readonly InvoiceLine[] {
    return this.props.lines.filter((line) => line.kind === 'PRODUCT' && line.productId !== null);
  }

  // -- Comportamiento -------------------------------------------------------

  /**
   * Registra un cobro y recalcula el estado.
   *
   * Rechaza el sobrepago en lugar de aceptarlo y dejar un saldo negativo. Un cobro de más
   * es casi siempre un error de tecleo, y admitirlo convierte la factura en un vale a favor
   * del cliente que nadie ha decidido emitir.
   */
  registerPayment(amount: Money, now: Date, actorId: string | null): void {
    if (!PAYABLE_STATUSES.has(this.props.status)) {
      throw new InvalidStateTransitionError('Factura', this.props.status, 'cobrada');
    }
    if (!amount.isPositive()) {
      throw new DomainValidationError('El importe cobrado debe ser mayor que cero', 'amount');
    }
    if (amount.currency !== this.props.currency) {
      throw new DomainValidationError(
        `El cobro está en ${amount.currency} y la factura en ${this.props.currency}`,
        'currency',
      );
    }

    const paidTotal = this.props.paidTotal.add(amount);

    if (paidTotal.greaterThan(this.total)) {
      throw new BusinessRuleViolationError(
        'OVERPAYMENT',
        `El cobro excede lo pendiente: quedan ${this.balanceDue.toString()} y se intentan cobrar ${amount.toString()}`,
        {
          invoiceId: this.id,
          balanceDue: this.balanceDue.toDecimalString(),
          attempted: amount.toDecimalString(),
        },
      );
    }

    const settled = paidTotal.equals(this.total);

    this.props = {
      ...this.props,
      paidTotal,
      status: settled ? 'PAID' : 'PARTIALLY_PAID',
      paidAt: settled ? now : this.props.paidAt,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /**
   * Anula la factura.
   *
   * Una factura con cobros **no se anula**: primero se devuelve el dinero. Anularla dejando
   * los cobros en pie descuadraría la caja del día, y el arqueo de esa noche no cerraría
   * sin que nadie supiera por qué.
   */
  void(reason: string, now: Date, actorId: string | null): void {
    if (this.props.status === 'VOID') {
      throw new InvalidStateTransitionError('Factura', 'VOID', 'VOID');
    }
    if (this.props.paidTotal.isPositive()) {
      throw new BusinessRuleViolationError(
        'INVOICE_HAS_PAYMENTS',
        `La factura ${this.props.number} tiene ${this.props.paidTotal.toString()} cobrados. Devuelva el importe antes de anularla.`,
        { invoiceId: this.id, paidTotal: this.props.paidTotal.toDecimalString() },
      );
    }

    this.props = {
      ...this.props,
      status: 'VOID',
      voidedAt: now,
      voidReason: requireText(reason, 'reason', 'La anulación necesita un motivo'),
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /** Marca la factura como vencida. La dispara un proceso programado, no una petición. */
  markOverdue(now: Date): void {
    if (this.props.status !== 'ISSUED' && this.props.status !== 'PARTIALLY_PAID') return;
    if (!this.props.dueAt || this.props.dueAt.getTime() > now.getTime()) return;

    this.props = {
      ...this.props,
      status: 'OVERDUE',
      audit: { ...this.props.audit, updatedAt: now },
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
 * Calcula una línea de factura.
 *
 * Vive aquí y no en el caso de uso porque es **la** regla aritmética del módulo, y tenerla
 * en un solo sitio es lo que garantiza que el ticket, la factura y el informe de comisiones
 * digan lo mismo.
 *
 * El orden importa: primero el descuento sobre la base, después el impuesto sobre la base
 * ya descontada. Aplicar el IVA antes del descuento haría pagar impuesto sobre dinero que
 * el cliente no desembolsa.
 */
export const buildInvoiceLine = (params: {
  id: string;
  kind: InvoiceLineKindValue;
  description: string;
  quantity: number;
  unitPrice: Money;
  taxRate: Percentage;
  discountAmount?: Money;
  commissionRate?: Percentage | null;
  serviceId?: string | null;
  productId?: string | null;
  stylistId?: string | null;
  sortOrder?: number;
}): InvoiceLine => {
  if (!(params.quantity > 0)) {
    throw new DomainValidationError('La cantidad debe ser mayor que cero', 'quantity');
  }
  if (params.unitPrice.isNegative()) {
    throw new DomainValidationError('El precio unitario no puede ser negativo', 'unitPrice');
  }

  const currency = params.unitPrice.currency;
  const gross = params.unitPrice.multiply(params.quantity);
  const discountAmount = params.discountAmount ?? Money.zero(currency);

  if (discountAmount.isNegative()) {
    throw new DomainValidationError('El descuento no puede ser negativo', 'discountAmount');
  }
  if (discountAmount.greaterThan(gross)) {
    throw new BusinessRuleViolationError(
      'DISCOUNT_EXCEEDS_LINE',
      `El descuento de ${discountAmount.toString()} supera el importe de la línea (${gross.toString()})`,
      { discount: discountAmount.toDecimalString(), gross: gross.toDecimalString() },
    );
  }

  const lineSubtotal = gross.subtract(discountAmount);
  const taxAmount = lineSubtotal.percentage(params.taxRate.value);

  return {
    id: params.id,
    kind: params.kind,
    serviceId: params.serviceId ?? null,
    productId: params.productId ?? null,
    stylistId: params.stylistId ?? null,
    description: requireText(params.description, 'description', 'La línea necesita descripción'),
    quantity: params.quantity,
    unitPrice: params.unitPrice,
    discountAmount,
    taxRate: params.taxRate,
    taxAmount,
    lineSubtotal,
    lineTotal: lineSubtotal.add(taxAmount),
    commissionRate: params.commissionRate ?? null,
    // La comisión se calcula sobre la base imponible, nunca sobre el total con impuesto:
    // el IVA no es ingreso del salón, es dinero que se recauda para Hacienda, y pagar
    // comisión sobre él sería pagar por recaudar.
    commissionAmount: params.commissionRate
      ? lineSubtotal.percentage(params.commissionRate.value)
      : Money.zero(currency),
    sortOrder: params.sortOrder ?? 0,
  };
};

const requireText = (value: string, field: string, message: string): string => {
  const text = value?.trim();
  if (!text) throw new DomainValidationError(message, field);
  return text;
};
