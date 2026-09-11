import { BusinessRuleViolationError, DomainValidationError } from '../../../shared/domain/errors';
import { AggregateRoot, type AuditMetadata } from '../../../shared/domain/primitives';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import { Percentage } from '../../../shared/domain/value-objects/time-range.vo';

/**
 * Servicio del catálogo: un corte, un color, unas mechas.
 *
 * Dos conceptos suyos gobiernan la agenda y conviene no confundirlos:
 *
 * - **`durationMinutes`** es el tiempo que se dedica a la clienta. Es lo que se cobra.
 * - **`bufferMinutes`** es el margen posterior de limpieza y preparación. Bloquea agenda
 *   pero **no se factura**.
 *
 * El hueco que una cita ocupa en el calendario es la suma de ambos. Mezclarlos haría que
 * el salón cobrase el tiempo de barrer, o que encadenase citas sin margen y acumulase
 * retraso durante toda la tarde.
 */

/** Producto que el servicio consume al ejecutarse. Es el escandallo. */
export interface ServiceConsumable {
  readonly productId: string;
  /** Cantidad en la unidad del producto. Admite fracciones: 0,15 litros de tinte. */
  readonly quantity: number;
}

export interface ServiceProps {
  readonly tenantId: string;
  readonly categoryId: string | null;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly durationMinutes: number;
  readonly bufferMinutes: number;
  readonly price: Money;
  readonly taxRate: Percentage;
  /** Comisión propia del servicio. `null` deja que mande la del profesional. */
  readonly commissionRate: Percentage | null;
  readonly isActive: boolean;
  /** Reservable por la clienta desde fuera, frente a solo agendable por el salón. */
  readonly isBookableOnline: boolean;
  readonly color: string | null;
  readonly sortOrder: number;
  readonly consumables: readonly ServiceConsumable[];
  readonly audit: AuditMetadata;
}

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
const MAX_DURATION_MINUTES = 8 * 60;

/**
 * Tipo impositivo por defecto: el IVA de Guatemala.
 *
 * Es un **valor por defecto, no una constante del dominio**: cada servicio guarda el suyo,
 * porque el tipo puede cambiar por ley y los documentos ya emitidos deben conservar el que
 * se les aplicó. Cambiar esto solo afecta a lo que se cree a partir de ahora.
 *
 * Estuvo en 21 —el tipo español— por venir el diseño inicial de ese mercado. Cada servicio
 * que se creaba sin indicar tipo nacía con un impuesto que no le corresponde.
 */
const DEFAULT_TAX_RATE = 12;

export class Service extends AggregateRoot {
  private constructor(
    id: string,
    private props: ServiceProps,
  ) {
    super(id);
  }

  static create(params: {
    id: string;
    tenantId: string;
    code: string;
    name: string;
    durationMinutes: number;
    price: Money;
    categoryId?: string | null;
    description?: string | null;
    bufferMinutes?: number;
    taxRate?: Percentage;
    commissionRate?: Percentage | null;
    isBookableOnline?: boolean;
    color?: string | null;
    sortOrder?: number;
    now: Date;
    actorId: string | null;
  }): Service {
    const code = Service.normalizeCode(params.code);
    Service.assertValidDuration(params.durationMinutes);
    Service.assertValidBuffer(params.bufferMinutes ?? 0);

    if (params.price.isNegative()) {
      throw new DomainValidationError('El precio no puede ser negativo', 'price');
    }
    if (!params.name?.trim()) {
      throw new DomainValidationError('El nombre del servicio es obligatorio', 'name');
    }

    return new Service(params.id, {
      tenantId: params.tenantId,
      categoryId: params.categoryId ?? null,
      code,
      name: params.name.trim(),
      description: params.description ?? null,
      durationMinutes: params.durationMinutes,
      bufferMinutes: params.bufferMinutes ?? 0,
      price: params.price,
      taxRate: params.taxRate ?? Percentage.create(DEFAULT_TAX_RATE),
      commissionRate: params.commissionRate ?? null,
      isActive: true,
      isBookableOnline: params.isBookableOnline ?? true,
      color: params.color ?? null,
      sortOrder: params.sortOrder ?? 0,
      consumables: [],
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

  static rehydrate(id: string, props: ServiceProps): Service {
    return new Service(id, props);
  }

  // -- Acceso ---------------------------------------------------------------

  get tenantId(): string {
    return this.props.tenantId;
  }
  get categoryId(): string | null {
    return this.props.categoryId;
  }
  get code(): string {
    return this.props.code;
  }
  get name(): string {
    return this.props.name;
  }
  get description(): string | null {
    return this.props.description;
  }
  get durationMinutes(): number {
    return this.props.durationMinutes;
  }
  get bufferMinutes(): number {
    return this.props.bufferMinutes;
  }
  get price(): Money {
    return this.props.price;
  }
  get taxRate(): Percentage {
    return this.props.taxRate;
  }
  get commissionRate(): Percentage | null {
    return this.props.commissionRate;
  }
  get isActive(): boolean {
    return this.props.isActive;
  }
  get isBookableOnline(): boolean {
    return this.props.isBookableOnline;
  }
  get color(): string | null {
    return this.props.color;
  }
  get sortOrder(): number {
    return this.props.sortOrder;
  }
  get consumables(): readonly ServiceConsumable[] {
    return this.props.consumables;
  }
  get audit(): AuditMetadata {
    return this.props.audit;
  }
  get isDeleted(): boolean {
    return this.props.audit.deletedAt !== null;
  }

  /**
   * Sella la baja lógica (ADR-0004).
   *
   * No borra: marca. El repositorio persiste el sello, pero la decisión pertenece al
   * dominio —es él quien sabe qué significa que algo esté dado de baja— y tenerla aquí
   * permite que los dobles en memoria de los tests reproduzcan el comportamiento real.
   */
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

  /** Deshace la baja lógica. */
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

  /**
   * Minutos que la cita ocupa en el calendario: atención **más** margen de limpieza.
   *
   * Es el número que usa la agenda. Confundirlo con `durationMinutes` produce el clásico
   * salón que va acumulando diez minutos de retraso por cita hasta que a las siete de la
   * tarde lleva una hora perdida.
   */
  get blockedMinutes(): number {
    return this.props.durationMinutes + this.props.bufferMinutes;
  }

  /** Impuesto correspondiente al precio. */
  get taxAmount(): Money {
    return this.props.price.percentage(this.props.taxRate.value);
  }

  /** Precio con impuestos incluidos, que es el que ve la clienta en el escaparate. */
  get priceWithTax(): Money {
    return this.props.price.add(this.taxAmount);
  }

  /** `true` si se puede agendar. Un servicio retirado no admite citas nuevas. */
  isBookable(): boolean {
    return this.props.isActive && !this.isDeleted;
  }

  // -- Comportamiento -------------------------------------------------------

  updateDetails(
    changes: {
      name?: string;
      description?: string | null;
      categoryId?: string | null;
      durationMinutes?: number;
      bufferMinutes?: number;
      taxRate?: Percentage;
      commissionRate?: Percentage | null;
      isBookableOnline?: boolean;
      color?: string | null;
      sortOrder?: number;
    },
    now: Date,
    actorId: string | null,
  ): void {
    if (changes.durationMinutes !== undefined) {
      Service.assertValidDuration(changes.durationMinutes);
    }
    if (changes.bufferMinutes !== undefined) {
      Service.assertValidBuffer(changes.bufferMinutes);
    }
    if (changes.name !== undefined && !changes.name.trim()) {
      throw new DomainValidationError('El nombre del servicio es obligatorio', 'name');
    }

    this.props = {
      ...this.props,
      name: changes.name?.trim() ?? this.props.name,
      description: changes.description !== undefined ? changes.description : this.props.description,
      categoryId: changes.categoryId !== undefined ? changes.categoryId : this.props.categoryId,
      durationMinutes: changes.durationMinutes ?? this.props.durationMinutes,
      bufferMinutes: changes.bufferMinutes ?? this.props.bufferMinutes,
      taxRate: changes.taxRate ?? this.props.taxRate,
      commissionRate:
        changes.commissionRate !== undefined ? changes.commissionRate : this.props.commissionRate,
      isBookableOnline: changes.isBookableOnline ?? this.props.isBookableOnline,
      color: changes.color !== undefined ? changes.color : this.props.color,
      sortOrder: changes.sortOrder ?? this.props.sortOrder,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /**
   * Cambia la tarifa.
   *
   * Es una operación con nombre propio, y no un campo más de `updateDetails`, porque un
   * cambio de precio tiene consecuencias que un cambio de descripción no tiene: se audita
   * aparte y **no afecta a las citas ya agendadas**, que congelaron su precio al reservarse.
   */
  changePrice(price: Money, now: Date, actorId: string | null): void {
    if (price.isNegative()) {
      throw new DomainValidationError('El precio no puede ser negativo', 'price');
    }
    if (price.currency !== this.props.price.currency) {
      throw new BusinessRuleViolationError(
        'SERVICE_CURRENCY_MISMATCH',
        `El servicio se tarifa en ${this.props.price.currency} y no puede pasar a ${price.currency}`,
      );
    }

    this.props = {
      ...this.props,
      price,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  activate(now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      isActive: true,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /**
   * Retira el servicio del catálogo.
   *
   * No es un borrado: las citas ya agendadas y las facturas emitidas lo siguen
   * referenciando, y deben poder consultarse. Solo deja de ofrecerse.
   */
  deactivate(now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      isActive: false,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /**
   * Define el escandallo: qué productos consume el servicio al ejecutarse.
   *
   * Alimenta dos cosas distintas: los movimientos de inventario de tipo
   * `SERVICE_CONSUMPTION` al completar la cita, y el margen real del servicio, que sin
   * esto se calcularía como si el tinte fuese gratis.
   */
  replaceConsumables(
    consumables: readonly ServiceConsumable[],
    now: Date,
    actorId: string | null,
  ): void {
    const seen = new Set<string>();

    for (const item of consumables) {
      if (seen.has(item.productId)) {
        throw new DomainValidationError(
          'Un producto no puede aparecer dos veces en el escandallo',
          'consumables',
        );
      }
      seen.add(item.productId);

      if (!(item.quantity > 0)) {
        throw new DomainValidationError(
          'La cantidad consumida debe ser mayor que cero',
          'quantity',
        );
      }
    }

    this.props = {
      ...this.props,
      consumables: [...consumables],
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  // -- Validaciones ---------------------------------------------------------

  private static normalizeCode(code: string): string {
    const normalized = code?.trim().toUpperCase();

    if (!normalized || !CODE_PATTERN.test(normalized)) {
      throw new DomainValidationError(
        `Código de servicio no válido: "${code}". Se esperan de 2 a 20 caracteres en mayúsculas, dígitos o guiones.`,
        'code',
      );
    }
    return normalized;
  }

  private static assertValidDuration(minutes: number): void {
    if (!Number.isInteger(minutes) || minutes <= 0) {
      throw new DomainValidationError(
        'La duración debe ser un número entero de minutos mayor que cero',
        'durationMinutes',
      );
    }
    if (minutes > MAX_DURATION_MINUTES) {
      // Un servicio de más de ocho horas no existe en un salón: es casi siempre un error
      // de tecleo —minutos donde se querían escribir horas— y detectarlo aquí evita que
      // bloquee la agenda de una profesional durante días.
      throw new DomainValidationError(
        `La duración no puede superar ${MAX_DURATION_MINUTES} minutos (8 horas)`,
        'durationMinutes',
      );
    }
  }

  private static assertValidBuffer(minutes: number): void {
    if (!Number.isInteger(minutes) || minutes < 0) {
      throw new DomainValidationError(
        'El margen de limpieza debe ser un número entero de minutos no negativo',
        'bufferMinutes',
      );
    }
    if (minutes > 120) {
      throw new DomainValidationError(
        'El margen de limpieza no puede superar 120 minutos',
        'bufferMinutes',
      );
    }
  }
}
