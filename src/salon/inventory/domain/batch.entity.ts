import { BusinessRuleViolationError, DomainValidationError } from '../../../shared/domain/errors';
import { Entity, type AuditMetadata } from '../../../shared/domain/primitives';
import type { CalendarDay } from '../../../shared/domain/time/zoned-time';
import { Money } from '../../../shared/domain/value-objects/money.vo';

/**
 * Lote de producto (ADR-0012).
 *
 * Es la unidad de trazabilidad: cuando una clienta tiene una reacción a un tinte, la
 * pregunta que hay que responder no es «qué producto» sino **«qué lote»**, y el
 * Reglamento (CE) 1223/2009 obliga a poder contestarla.
 *
 * Guarda además el coste **real** de esa entrada. Con lotes no hace falta promediar: se
 * sabe exactamente lo que costó lo que se está consumiendo, y el margen del servicio deja
 * de ser una estimación.
 */

export interface BatchProps {
  readonly tenantId: string;
  readonly productId: string;
  /** Número impreso en el envase. Es el que figura en una reclamación. */
  readonly batchNumber: string;
  /** `null` en productos que se trazan por lote pero no caducan. */
  readonly expiresAt: Date | null;
  readonly receivedAt: Date;
  /** Cantidad recibida. No cambia: es el histórico de la entrada. */
  readonly initialQuantity: number;
  readonly remainingQuantity: number;
  readonly unitCost: Money;
  readonly supplierId: string | null;
  readonly purchaseOrderId: string | null;
  readonly notes: string | null;
  readonly audit: AuditMetadata;
}

/** Tolerancia de comparación: las cantidades tienen tres decimales en la base. */
const QUANTITY_EPSILON = 0.0005;

export class Batch extends Entity {
  private constructor(
    id: string,
    private props: BatchProps,
  ) {
    super(id);
  }

  static receive(params: {
    id: string;
    tenantId: string;
    productId: string;
    batchNumber: string;
    quantity: number;
    unitCost: Money;
    expiresAt?: Date | null;
    supplierId?: string | null;
    purchaseOrderId?: string | null;
    notes?: string | null;
    now: Date;
    actorId: string | null;
  }): Batch {
    const batchNumber = params.batchNumber?.trim();

    if (!batchNumber) {
      throw new DomainValidationError('El número de lote es obligatorio', 'batchNumber');
    }
    if (!(params.quantity > 0)) {
      throw new DomainValidationError('La cantidad recibida debe ser mayor que cero', 'quantity');
    }
    if (params.unitCost.isNegative()) {
      throw new DomainValidationError('El coste unitario no puede ser negativo', 'unitCost');
    }

    // Recibir mercancía ya caducada es siempre un error: o la fecha está mal tecleada, o
    // el proveedor ha enviado producto inservible. En cualquiera de los dos casos hay que
    // pararlo en el muelle, no descubrirlo cuando alguien intente usarlo.
    if (params.expiresAt && params.expiresAt.getTime() <= params.now.getTime()) {
      throw new BusinessRuleViolationError(
        'BATCH_ALREADY_EXPIRED',
        `El lote ${batchNumber} ya está caducado y no se puede dar de alta`,
        { expiresAt: params.expiresAt.toISOString() },
      );
    }

    return new Batch(params.id, {
      tenantId: params.tenantId,
      productId: params.productId,
      batchNumber,
      expiresAt: params.expiresAt ?? null,
      receivedAt: params.now,
      initialQuantity: params.quantity,
      remainingQuantity: params.quantity,
      unitCost: params.unitCost,
      supplierId: params.supplierId ?? null,
      purchaseOrderId: params.purchaseOrderId ?? null,
      notes: params.notes ?? null,
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

  static rehydrate(id: string, props: BatchProps): Batch {
    return new Batch(id, props);
  }

  // -- Acceso ---------------------------------------------------------------

  get tenantId(): string {
    return this.props.tenantId;
  }
  get productId(): string {
    return this.props.productId;
  }
  get batchNumber(): string {
    return this.props.batchNumber;
  }
  get expiresAt(): Date | null {
    return this.props.expiresAt;
  }
  get receivedAt(): Date {
    return this.props.receivedAt;
  }
  get initialQuantity(): number {
    return this.props.initialQuantity;
  }
  get remainingQuantity(): number {
    return this.props.remainingQuantity;
  }
  get unitCost(): Money {
    return this.props.unitCost;
  }
  get supplierId(): string | null {
    return this.props.supplierId;
  }
  get purchaseOrderId(): string | null {
    return this.props.purchaseOrderId;
  }
  get notes(): string | null {
    return this.props.notes;
  }
  get audit(): AuditMetadata {
    return this.props.audit;
  }
  get isDeleted(): boolean {
    return this.props.audit.deletedAt !== null;
  }

  /** Cantidad ya consumida. Útil en el informe de rotación. */
  get consumedQuantity(): number {
    return this.props.initialQuantity - this.props.remainingQuantity;
  }

  get isDepleted(): boolean {
    return this.props.remainingQuantity <= QUANTITY_EPSILON;
  }

  /** Valor de las existencias que quedan de este lote. */
  get remainingValue(): Money {
    return this.props.unitCost.multiply(this.props.remainingQuantity);
  }

  isExpired(now: Date): boolean {
    return this.props.expiresAt !== null && this.props.expiresAt.getTime() <= now.getTime();
  }

  /** Días que faltan para caducar. `null` si el lote no caduca. */
  daysUntilExpiry(now: Date): number | null {
    if (!this.props.expiresAt) return null;
    return Math.ceil((this.props.expiresAt.getTime() - now.getTime()) / 86_400_000);
  }

  /** `true` si caduca dentro del plazo indicado. Alimenta el panel de avisos. */
  expiresWithin(days: number, now: Date): boolean {
    const remaining = this.daysUntilExpiry(now);
    return remaining !== null && remaining <= days;
  }

  /** Disponible para consumir: queda producto, no ha caducado y no está de baja. */
  isAvailable(now: Date): boolean {
    return !this.isDepleted && !this.isExpired(now) && !this.isDeleted;
  }

  // -- Comportamiento -------------------------------------------------------

  /**
   * Descuenta cantidad del lote.
   *
   * La comprobación de existencias vive aquí **y** en la base de datos. No es
   * redundancia: entre esta comprobación y el `UPDATE` cabe otra petición, y solo el
   * `CHECK` de PostgreSQL cierra esa ventana. Lo que aporta esta capa es un error que la
   * encargada entiende en lugar de una violación de restricción.
   */
  consume(quantity: number, now: Date, actorId: string | null): void {
    if (!(quantity > 0)) {
      throw new DomainValidationError('La cantidad a consumir debe ser mayor que cero', 'quantity');
    }

    if (quantity > this.props.remainingQuantity + QUANTITY_EPSILON) {
      throw new BusinessRuleViolationError(
        'INSUFFICIENT_BATCH_QUANTITY',
        `El lote ${this.props.batchNumber} solo tiene ${this.props.remainingQuantity} unidades`,
        { batchId: this.id, requested: quantity, available: this.props.remainingQuantity },
      );
    }

    this.props = {
      ...this.props,
      remainingQuantity: round3(this.props.remainingQuantity - quantity),
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /**
   * Devuelve cantidad al lote.
   *
   * Ocurre al anular una venta o al corregir un consumo mal registrado. Nunca puede
   * superar lo que entró: devolver más de lo recibido significa que el error está en otro
   * sitio, y taparlo aquí lo escondería.
   */
  restock(quantity: number, now: Date, actorId: string | null): void {
    if (!(quantity > 0)) {
      throw new DomainValidationError('La cantidad a devolver debe ser mayor que cero', 'quantity');
    }

    const next = round3(this.props.remainingQuantity + quantity);

    if (next > this.props.initialQuantity + QUANTITY_EPSILON) {
      throw new BusinessRuleViolationError(
        'BATCH_OVERFLOW',
        `No se puede devolver más producto del que entró en el lote ${this.props.batchNumber}`,
        {
          batchId: this.id,
          initialQuantity: this.props.initialQuantity,
          attempted: next,
        },
      );
    }

    this.props = {
      ...this.props,
      remainingQuantity: next,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /**
   * Amplía el lote con una entrega posterior del mismo lote.
   *
   * Ocurre a menudo: el proveedor manda el mismo lote partido en dos palés, o en dos días.
   * Son las mismas unidades de fabricación y comparten número, caducidad y coste, así que
   * son **el mismo lote**: crear un segundo registro chocaría contra el índice único y, si
   * no lo hiciera, partiría la trazabilidad de una reclamación en dos filas.
   *
   * Sube la cantidad inicial además de la restante, porque lo que llega ahora no se ha
   * consumido. Sin eso, `initialQuantity` dejaría de ser el histórico de lo recibido y el
   * tope de `restock` se quedaría corto.
   */
  receiveMore(quantity: number, now: Date, actorId: string | null): void {
    if (!(quantity > 0)) {
      throw new DomainValidationError('La cantidad recibida debe ser mayor que cero', 'quantity');
    }
    if (this.isDeleted) {
      throw new BusinessRuleViolationError(
        'BATCH_DELETED',
        `El lote ${this.props.batchNumber} está dado de baja y no admite entradas`,
        { batchId: this.id },
      );
    }

    this.props = {
      ...this.props,
      initialQuantity: round3(this.props.initialQuantity + quantity),
      remainingQuantity: round3(this.props.remainingQuantity + quantity),
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /**
   * Corrige la cantidad restante tras un recuento físico.
   *
   * Es la única vía legítima para que la cifra suba o baje sin un consumo: lo que hay en
   * la estantería manda sobre lo que dice el sistema. La diferencia se registra como un
   * movimiento `ADJUSTMENT` en el ledger, nunca en silencio.
   */
  adjustTo(countedQuantity: number, now: Date, actorId: string | null): number {
    if (countedQuantity < 0) {
      throw new DomainValidationError('El recuento no puede ser negativo', 'countedQuantity');
    }
    if (countedQuantity > this.props.initialQuantity + QUANTITY_EPSILON) {
      throw new BusinessRuleViolationError(
        'BATCH_OVERFLOW',
        `El recuento supera la cantidad recibida en el lote ${this.props.batchNumber}`,
        { initialQuantity: this.props.initialQuantity, counted: countedQuantity },
      );
    }

    const delta = round3(countedQuantity - this.props.remainingQuantity);

    this.props = {
      ...this.props,
      remainingQuantity: round3(countedQuantity),
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };

    return delta;
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

  /** Día de caducidad, para pintarlo sin arrastrar la hora. */
  expiryDay(): CalendarDay | null {
    if (!this.props.expiresAt) return null;
    return {
      year: this.props.expiresAt.getUTCFullYear(),
      month: this.props.expiresAt.getUTCMonth() + 1,
      day: this.props.expiresAt.getUTCDate(),
    };
  }
}

/**
 * Redondea a tres decimales, que es la precisión de la columna.
 *
 * Restar `0.15` de `20` en coma flotante da `19.849999999999998`. Sin redondear, esa cola
 * se acumula consumo tras consumo hasta que el recuento físico no cuadra con el sistema
 * por milésimas que nadie sabe explicar.
 */
const round3 = (value: number): number => Math.round(value * 1000) / 1000;
