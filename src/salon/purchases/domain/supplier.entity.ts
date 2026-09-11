import { DomainValidationError } from '../../../shared/domain/errors';
import { Entity, type AuditMetadata } from '../../../shared/domain/primitives';

/**
 * Proveedor.
 *
 * Entidad deliberadamente sobria: un proveedor es una ficha de contacto con condiciones de
 * pago, y casi todas sus reglas las sostiene el esquema (unicidad de `code` por salón,
 * `paymentTermDays` entre 0 y 365). Lo que sí pertenece aquí es el **estado**, porque de él
 * depende una regla de otro agregado: no se puede pedir a un proveedor dado de baja.
 *
 * `country` y `paymentTermDays` admiten `null` a propósito, y no es un descuido de tipado.
 * Significan «no se ha dicho nada, decida el esquema»: sus valores por defecto —GT y 30
 * días— están declarados en la base, y repetirlos aquí crearía una segunda fuente de verdad
 * que se olvidaría de actualizar el día que el valor cambie.
 */

export type SupplierStatusValue = 'ACTIVE' | 'INACTIVE';

export interface SupplierProps {
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly legalName: string | null;
  readonly taxId: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly contactName: string | null;
  readonly addressLine: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  /** `null` = sin especificar; lo rellena el valor por defecto del esquema. */
  readonly country: string | null;
  /** `null` = sin especificar; lo rellena el valor por defecto del esquema. */
  readonly paymentTermDays: number | null;
  readonly notes: string | null;
  readonly status: SupplierStatusValue;
  readonly audit: AuditMetadata;
}

export interface SupplierContactChanges {
  readonly name?: string;
  readonly legalName?: string | null;
  readonly taxId?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly contactName?: string | null;
  readonly addressLine?: string | null;
  readonly city?: string | null;
  readonly postalCode?: string | null;
  readonly paymentTermDays?: number;
  readonly notes?: string | null;
  readonly status?: SupplierStatusValue;
}

export class Supplier extends Entity {
  private constructor(
    id: string,
    private props: SupplierProps,
  ) {
    super(id);
  }

  static create(params: {
    id: string;
    tenantId: string;
    code: string;
    name: string;
    legalName?: string | null;
    taxId?: string | null;
    email?: string | null;
    phone?: string | null;
    contactName?: string | null;
    addressLine?: string | null;
    city?: string | null;
    postalCode?: string | null;
    country?: string | null;
    paymentTermDays?: number | null;
    notes?: string | null;
    now: Date;
    actorId: string | null;
  }): Supplier {
    return new Supplier(params.id, {
      tenantId: params.tenantId,
      code: requireText(params.code, 'code', 'El proveedor necesita un código'),
      name: requireText(params.name, 'name', 'El proveedor necesita un nombre'),
      legalName: params.legalName ?? null,
      taxId: params.taxId ?? null,
      email: params.email ?? null,
      phone: params.phone ?? null,
      contactName: params.contactName ?? null,
      addressLine: params.addressLine ?? null,
      city: params.city ?? null,
      postalCode: params.postalCode ?? null,
      country: params.country ?? null,
      paymentTermDays: assertPaymentTerm(params.paymentTermDays ?? null),
      notes: params.notes ?? null,
      status: 'ACTIVE',
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

  static rehydrate(id: string, props: SupplierProps): Supplier {
    return new Supplier(id, props);
  }

  // -- Acceso ---------------------------------------------------------------

  get tenantId(): string {
    return this.props.tenantId;
  }
  get code(): string {
    return this.props.code;
  }
  get name(): string {
    return this.props.name;
  }
  get legalName(): string | null {
    return this.props.legalName;
  }
  get taxId(): string | null {
    return this.props.taxId;
  }
  get email(): string | null {
    return this.props.email;
  }
  get phone(): string | null {
    return this.props.phone;
  }
  get contactName(): string | null {
    return this.props.contactName;
  }
  get addressLine(): string | null {
    return this.props.addressLine;
  }
  get city(): string | null {
    return this.props.city;
  }
  get postalCode(): string | null {
    return this.props.postalCode;
  }
  get country(): string | null {
    return this.props.country;
  }
  get paymentTermDays(): number | null {
    return this.props.paymentTermDays;
  }
  get notes(): string | null {
    return this.props.notes;
  }
  get status(): SupplierStatusValue {
    return this.props.status;
  }
  get audit(): AuditMetadata {
    return this.props.audit;
  }
  get isDeleted(): boolean {
    return this.props.audit.deletedAt !== null;
  }

  /**
   * `true` si se le puede pedir mercancía.
   *
   * Lo consulta `CreatePurchaseOrderUseCase`. Vive aquí y no allí porque es una afirmación
   * sobre el proveedor, y así una segunda vía de alta —una importación, un job— choca con
   * la misma pared en lugar de tener que acordarse de repetir la comprobación.
   */
  get canReceiveOrders(): boolean {
    return this.props.status === 'ACTIVE' && !this.isDeleted;
  }

  // -- Comportamiento -------------------------------------------------------

  /** El código no se cambia: identifica al proveedor en los albaranes ya emitidos. */
  applyChanges(changes: SupplierContactChanges, now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      name:
        changes.name === undefined
          ? this.props.name
          : requireText(changes.name, 'name', 'El proveedor necesita un nombre'),
      legalName: pick(changes.legalName, this.props.legalName),
      taxId: pick(changes.taxId, this.props.taxId),
      email: pick(changes.email, this.props.email),
      phone: pick(changes.phone, this.props.phone),
      contactName: pick(changes.contactName, this.props.contactName),
      addressLine: pick(changes.addressLine, this.props.addressLine),
      city: pick(changes.city, this.props.city),
      postalCode: pick(changes.postalCode, this.props.postalCode),
      paymentTermDays:
        changes.paymentTermDays === undefined
          ? this.props.paymentTermDays
          : assertPaymentTerm(changes.paymentTermDays),
      notes: pick(changes.notes, this.props.notes),
      status: changes.status ?? this.props.status,
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

  /**
   * Deshace la baja y **reactiva** al proveedor.
   *
   * Recuperar una ficha que reaparece en el listado pero a la que no se puede pedir nada
   * es peor que no recuperarla, porque nadie lo nota hasta que alguien intenta hacer un
   * pedido. Es el mismo fallo que el ADR-0013 encontró al restaurar un producto.
   */
  markRestored(now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      status: 'ACTIVE',
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

const requireText = (value: string, field: string, message: string): string => {
  const text = value?.trim();
  if (!text) throw new DomainValidationError(message, field);
  return text;
};

const assertPaymentTerm = (value: number | null): number | null => {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > 365) {
    throw new DomainValidationError(
      'El plazo de pago debe ser un número entero de días entre 0 y 365',
      'paymentTermDays',
    );
  }
  return value;
};

/** `undefined` significa «no tocar»; `null`, «borrar el valor». */
const pick = <T>(incoming: T | null | undefined, current: T | null): T | null =>
  incoming === undefined ? current : incoming;
