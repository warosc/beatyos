import { BusinessRuleViolationError, DomainValidationError } from '../../../shared/domain/errors';
import { AggregateRoot, type AuditMetadata } from '../../../shared/domain/primitives';
import { Email, PersonName, Phone } from '../../../shared/domain/value-objects/contact.vo';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import { Birthday } from './birthday.vo';

/**
 * Clienta del salón.
 *
 * Es el agregado con más carga legal del sistema: concentra datos personales, datos de
 * salud (alergias, sensibilidades a productos químicos) y consentimiento comercial. Casi
 * todas sus reglas existen por el RGPD, no por conveniencia de producto.
 */

export type ClientStatusValue = 'ACTIVE' | 'INACTIVE' | 'BLOCKED';
export type GenderValue = 'FEMALE' | 'MALE' | 'OTHER' | 'UNDISCLOSED';

export interface ClientProps {
  readonly tenantId: string;
  readonly name: PersonName;
  readonly email: Email | null;
  readonly phone: Phone | null;
  /** Día y mes, sin año: el salón la felicita, no necesita saber su edad. */
  readonly birthday: Birthday | null;
  readonly gender: GenderValue | null;
  readonly notes: string | null;
  /**
   * Alergias y sensibilidades.
   *
   * No es un campo de notas más: aplicar un tinte a quien tiene alergia a la
   * parafenilendiamina provoca una reacción grave. Por eso tiene columna propia, se
   * muestra destacado en la ficha y **no** se borra al anonimizar sin más —ver `anonymize`.
   */
  readonly allergies: string | null;
  readonly addressLine: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  readonly status: ClientStatusValue;
  readonly marketingConsent: boolean;
  readonly marketingConsentAt: Date | null;
  readonly loyaltyPoints: number;
  readonly totalVisits: number;
  readonly totalSpent: Money;
  readonly lastVisitAt: Date | null;
  readonly audit: AuditMetadata;
}

export class Client extends AggregateRoot {
  private constructor(
    id: string,
    private props: ClientProps,
  ) {
    super(id);
  }

  static create(params: {
    id: string;
    tenantId: string;
    name: PersonName;
    email?: Email | null;
    phone?: Phone | null;
    birthday?: Birthday | null;
    gender?: GenderValue | null;
    notes?: string | null;
    allergies?: string | null;
    addressLine?: string | null;
    city?: string | null;
    postalCode?: string | null;
    marketingConsent?: boolean;
    currency: string;
    now: Date;
    actorId: string | null;
  }): Client {
    // Sin correo ni teléfono no hay forma de avisar de un cambio de cita, que es el uso
    // más frecuente de la ficha. Se exige al menos uno.
    if (!params.email && !params.phone) {
      throw new DomainValidationError(
        'Indique al menos un correo electrónico o un teléfono de contacto',
        'contact',
      );
    }

    const consentGranted = params.marketingConsent === true;

    return new Client(params.id, {
      tenantId: params.tenantId,
      name: params.name,
      email: params.email ?? null,
      phone: params.phone ?? null,
      birthday: params.birthday ?? null,
      gender: params.gender ?? null,
      notes: params.notes ?? null,
      allergies: params.allergies ?? null,
      addressLine: params.addressLine ?? null,
      city: params.city ?? null,
      postalCode: params.postalCode ?? null,
      status: 'ACTIVE',
      marketingConsent: consentGranted,
      // La fecha del consentimiento es la prueba de que se obtuvo, y sin fecha el
      // consentimiento no es demostrable ante una inspección. Se sella aquí, junto al
      // propio consentimiento, para que sea imposible tener uno sin la otra.
      marketingConsentAt: consentGranted ? params.now : null,
      loyaltyPoints: 0,
      totalVisits: 0,
      totalSpent: Money.zero(params.currency),
      lastVisitAt: null,
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

  static rehydrate(id: string, props: ClientProps): Client {
    return new Client(id, props);
  }

  // -- Acceso ---------------------------------------------------------------

  get tenantId(): string {
    return this.props.tenantId;
  }
  get name(): PersonName {
    return this.props.name;
  }
  get email(): Email | null {
    return this.props.email;
  }
  get phone(): Phone | null {
    return this.props.phone;
  }
  get birthday(): Birthday | null {
    return this.props.birthday;
  }
  get gender(): GenderValue | null {
    return this.props.gender;
  }
  get notes(): string | null {
    return this.props.notes;
  }
  get allergies(): string | null {
    return this.props.allergies;
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
  get status(): ClientStatusValue {
    return this.props.status;
  }
  get marketingConsent(): boolean {
    return this.props.marketingConsent;
  }
  get marketingConsentAt(): Date | null {
    return this.props.marketingConsentAt;
  }
  get loyaltyPoints(): number {
    return this.props.loyaltyPoints;
  }
  get totalVisits(): number {
    return this.props.totalVisits;
  }
  get totalSpent(): Money {
    return this.props.totalSpent;
  }
  get lastVisitAt(): Date | null {
    return this.props.lastVisitAt;
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

  /** `true` si cumple años dentro de los próximos `days` días. Alimenta las campañas. */
  hasBirthdayWithin(days: number, reference: Date): boolean {
    if (!this.props.birthday) return false;

    // Si ya pasó este año, cuenta el del año que viene: en diciembre hay que poder
    // preparar las felicitaciones de enero.
    const next = this.props.birthday.nextOccurrence(reference);
    const today = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
    const diffDays = Math.round((next.getTime() - today.getTime()) / 86_400_000);
    return diffDays >= 0 && diffDays <= days;
  }

  // -- Comportamiento -------------------------------------------------------

  updateDetails(
    changes: {
      name?: PersonName;
      email?: Email | null;
      phone?: Phone | null;
      birthday?: Birthday | null;
      gender?: GenderValue | null;
      notes?: string | null;
      allergies?: string | null;
      addressLine?: string | null;
      city?: string | null;
      postalCode?: string | null;
    },
    now: Date,
    actorId: string | null,
  ): void {
    const email = changes.email !== undefined ? changes.email : this.props.email;
    const phone = changes.phone !== undefined ? changes.phone : this.props.phone;

    // La invariante del alta también rige en la modificación: no se puede dejar una
    // ficha sin ninguna vía de contacto vaciando los dos campos por separado.
    if (!email && !phone) {
      throw new DomainValidationError(
        'La ficha debe conservar al menos un correo electrónico o un teléfono',
        'contact',
      );
    }

    this.props = {
      ...this.props,
      name: changes.name ?? this.props.name,
      email,
      phone,
      birthday: changes.birthday !== undefined ? changes.birthday : this.props.birthday,
      gender: changes.gender !== undefined ? changes.gender : this.props.gender,
      notes: changes.notes !== undefined ? changes.notes : this.props.notes,
      allergies: changes.allergies !== undefined ? changes.allergies : this.props.allergies,
      addressLine: changes.addressLine !== undefined ? changes.addressLine : this.props.addressLine,
      city: changes.city !== undefined ? changes.city : this.props.city,
      postalCode: changes.postalCode !== undefined ? changes.postalCode : this.props.postalCode,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /**
   * Otorga o retira el consentimiento comercial.
   *
   * Retirarlo borra la fecha: conservar "consintió el 3 de marzo" junto a "no consiente"
   * invita a que alguien lo interprete como permiso vigente. El histórico de la decisión
   * queda en `AuditLog`, que es donde corresponde.
   */
  setMarketingConsent(granted: boolean, now: Date, actorId: string | null): void {
    if (granted === this.props.marketingConsent) return;

    this.props = {
      ...this.props,
      marketingConsent: granted,
      marketingConsentAt: granted ? now : null,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  block(reason: string, now: Date, actorId: string | null): void {
    if (this.props.status === 'BLOCKED') {
      throw new BusinessRuleViolationError(
        'CLIENT_ALREADY_BLOCKED',
        'La clienta ya está bloqueada',
      );
    }

    this.props = {
      ...this.props,
      status: 'BLOCKED',
      notes: [this.props.notes, `[Bloqueada ${now.toISOString().slice(0, 10)}] ${reason}`]
        .filter(Boolean)
        .join('\n'),
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  unblock(now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      status: 'ACTIVE',
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /**
   * Registra una visita facturada.
   *
   * Mantiene las métricas desnormalizadas que alimentan los listados y la segmentación.
   * Lo invoca el módulo de facturación al emitir, no la agenda al completar una cita:
   * una cita completada sin factura no es una visita a efectos de gasto.
   */
  registerVisit(amount: Money, now: Date): void {
    if (amount.isNegative()) {
      throw new DomainValidationError('El importe de una visita no puede ser negativo', 'amount');
    }

    this.props = {
      ...this.props,
      totalVisits: this.props.totalVisits + 1,
      totalSpent: this.props.totalSpent.add(amount),
      lastVisitAt: now,
      audit: { ...this.props.audit, updatedAt: now },
    };
  }

  /**
   * Deshace la visita de una venta anulada (ADR-0020).
   *
   * No baja de cero aunque los datos vengan de antes de que existieran estas métricas.
   * `lastVisitAt` no retrocede: la fecha anterior no se guarda, y una fecha inventada sería
   * peor que una que se queda un poco adelantada.
   */
  revertVisit(amount: Money, now: Date): void {
    if (amount.isNegative()) {
      throw new DomainValidationError('El importe de una visita no puede ser negativo', 'amount');
    }

    const spent = this.props.totalSpent.subtract(amount);
    this.props = {
      ...this.props,
      totalVisits: Math.max(0, this.props.totalVisits - 1),
      totalSpent: spent.isNegative() ? Money.zero(spent.currency) : spent,
      audit: { ...this.props.audit, updatedAt: now },
    };
  }

  addLoyaltyPoints(points: number, now: Date): void {
    if (!Number.isInteger(points)) {
      throw new DomainValidationError('Los puntos deben ser un número entero', 'points');
    }
    if (this.props.loyaltyPoints + points < 0) {
      throw new BusinessRuleViolationError(
        'INSUFFICIENT_LOYALTY_POINTS',
        'La clienta no tiene puntos suficientes',
        { available: this.props.loyaltyPoints, requested: Math.abs(points) },
      );
    }

    this.props = {
      ...this.props,
      loyaltyPoints: this.props.loyaltyPoints + points,
      audit: { ...this.props.audit, updatedAt: now },
    };
  }

  /**
   * Anonimización por derecho de supresión del RGPD (ADR-0004).
   *
   * No es un borrado. Las facturas emitidas deben conservarse durante años por obligación
   * fiscal, y suprimir la fila dejaría documentos contables apuntando al vacío. Lo que se
   * hace es **destruir los datos personales conservando la fila**: la clienta pasa a ser
   * un identificador seudónimo del que ya no se puede saber quién fue.
   *
   * Es **irreversible por diseño**: sobrescribe en lugar de marcar. Una anonimización que
   * se pudiera deshacer no cumpliría el derecho que dice satisfacer.
   *
   * Las alergias también se borran. Es doloroso —es información de seguridad— pero es
   * dato de salud, la categoría más protegida del reglamento, y no hay base legal para
   * conservarlo una vez ejercido el derecho.
   */
  anonymize(now: Date, actorId: string | null): void {
    if (this.props.name.firstName === 'Anónimo') {
      throw new BusinessRuleViolationError(
        'CLIENT_ALREADY_ANONYMIZED',
        'La ficha ya está anonimizada',
      );
    }

    const pseudonym = `Cliente ${this.id.slice(-6).toUpperCase()}`;

    this.props = {
      ...this.props,
      name: PersonName.create('Anónimo', pseudonym),
      email: null,
      phone: null,
      birthday: null,
      gender: null,
      notes: null,
      allergies: null,
      addressLine: null,
      city: null,
      postalCode: null,
      status: 'INACTIVE',
      marketingConsent: false,
      marketingConsentAt: null,
      // Las métricas agregadas se conservan: no identifican a nadie y su pérdida
      // falsearía los informes históricos del salón.
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }
}
