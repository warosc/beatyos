import { BusinessRuleViolationError, DomainValidationError } from '../../../shared/domain/errors';
import { Entity, type AuditMetadata } from '../../../shared/domain/primitives';

/**
 * Foto del historial de una clienta (ADR-0016).
 *
 * El fichero vive en el almacén de objetos; esta entidad guarda la referencia y, sobre todo,
 * **el significado**: de quién es, de qué servicio, y con qué permiso se conserva.
 *
 * La imagen de una persona es un dato personal. Eso tiene dos consecuencias que están
 * escritas en el código y no en un documento aparte: no se guarda nada sin consentimiento
 * registrado, y borrarla tiene que poder llegar a borrar el fichero de verdad —no solo
 * ocultarlo—, porque el derecho de supresión no se satisface con una columna `deletedAt`.
 */

export type ClientPhotoKindValue = 'BEFORE' | 'AFTER' | 'REFERENCE' | 'FORMULA' | 'OTHER';

export type PhotoConsentSourceValue = 'IN_PERSON' | 'ONLINE' | 'VERBAL';

export interface PhotoConsent {
  readonly givenAt: Date;
  readonly source: PhotoConsentSourceValue;
  /** Autoriza además publicarla. Es una decisión distinta de la de guardarla. */
  readonly allowsMarketing: boolean;
}

export interface ClientPhotoProps {
  readonly tenantId: string;
  readonly clientId: string;
  readonly appointmentId: string | null;
  readonly serviceId: string | null;
  readonly kind: ClientPhotoKindValue;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly originalName: string | null;
  readonly caption: string | null;
  readonly notes: string | null;
  readonly takenAt: Date;
  readonly consent: PhotoConsent;
  readonly purgedAt: Date | null;
  readonly audit: AuditMetadata;
}

/**
 * Formatos admitidos.
 *
 * Es una **lista blanca**, no una lista negra. Con una lista negra habría que acertar a
 * enumerar todo lo peligroso —SVG con script dentro, HTML disfrazado, PDF con JavaScript— y
 * bastaría con olvidar uno. Con lista blanca, lo que no está previsto se rechaza.
 *
 * SVG queda fuera a propósito aunque sea una imagen: admite `<script>` y se ejecuta al
 * abrirlo en el navegador. Un salón no necesita subir vectores.
 */
export const ALLOWED_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class ClientPhoto extends Entity {
  private constructor(
    id: string,
    private props: ClientPhotoProps,
  ) {
    super(id);
  }

  static register(params: {
    id: string;
    tenantId: string;
    clientId: string;
    storageKey: string;
    mimeType: string;
    sizeBytes: number;
    checksum: string;
    consent: PhotoConsent;
    kind?: ClientPhotoKindValue;
    appointmentId?: string | null;
    serviceId?: string | null;
    width?: number | null;
    height?: number | null;
    originalName?: string | null;
    caption?: string | null;
    notes?: string | null;
    takenAt?: Date | null;
    now: Date;
    actorId: string | null;
  }): ClientPhoto {
    if (!ALLOWED_IMAGE_TYPES.has(params.mimeType)) {
      throw new BusinessRuleViolationError(
        'UNSUPPORTED_IMAGE_TYPE',
        `No se admiten ficheros de tipo ${params.mimeType}. Suba una foto en JPEG, PNG, WebP o HEIC.`,
        { mimeType: params.mimeType },
      );
    }
    if (!Number.isInteger(params.sizeBytes) || params.sizeBytes <= 0) {
      throw new DomainValidationError('El fichero está vacío', 'sizeBytes');
    }
    // Se normaliza **antes** de validar. El hexadecimal es el mismo en mayusculas o en
    // minusculas, pero la deduplicacion busca por igualdad exacta: aceptar las dos formas y
    // guardar solo una es lo que evita que la misma foto entre dos veces segun quien la suba.
    const checksum = params.checksum?.trim().toLowerCase() ?? '';
    if (!SHA256_PATTERN.test(checksum)) {
      throw new DomainValidationError(
        'La huella del fichero debe ser un SHA-256 en hexadecimal',
        'checksum',
      );
    }

    const storageKey = params.storageKey?.trim();
    if (!storageKey) {
      throw new DomainValidationError('La ruta en el almacén es obligatoria', 'storageKey');
    }

    // Sin consentimiento no se guarda. La comprobación vive aquí y no en el controlador
    // porque es una regla del negocio —y de la ley—, no una validación de formulario: si
    // mañana entra otra vía de subida, tiene que chocar con la misma pared.
    if (!params.consent?.givenAt) {
      throw new BusinessRuleViolationError(
        'PHOTO_CONSENT_REQUIRED',
        'No se puede guardar la imagen de una clienta sin su consentimiento',
        { clientId: params.clientId },
      );
    }
    if (params.consent.givenAt.getTime() > params.now.getTime()) {
      throw new DomainValidationError(
        'El consentimiento no puede tener fecha futura',
        'consentGivenAt',
      );
    }

    const takenAt = params.takenAt ?? params.now;
    if (takenAt.getTime() > params.now.getTime()) {
      // Una foto tomada en el futuro desordena el historial y es siempre un error de reloj
      // o de zona horaria en el dispositivo que la subió.
      throw new DomainValidationError('La foto no puede ser posterior a hoy', 'takenAt');
    }

    return new ClientPhoto(params.id, {
      tenantId: params.tenantId,
      clientId: params.clientId,
      appointmentId: params.appointmentId ?? null,
      serviceId: params.serviceId ?? null,
      kind: params.kind ?? 'OTHER',
      storageKey,
      mimeType: params.mimeType,
      sizeBytes: params.sizeBytes,
      checksum,
      width: params.width ?? null,
      height: params.height ?? null,
      // El nombre original solo se guarda para mostrarlo. **Nunca** se usa para construir la
      // ruta del objeto: un nombre como `../../otro-salon/foto.jpg` escaparía del prefijo
      // del inquilino, y basta con no darle esa oportunidad.
      originalName: params.originalName?.trim().slice(0, 255) || null,
      caption: params.caption?.trim() || null,
      notes: params.notes?.trim() || null,
      takenAt,
      consent: params.consent,
      purgedAt: null,
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

  static rehydrate(id: string, props: ClientPhotoProps): ClientPhoto {
    return new ClientPhoto(id, props);
  }

  // -- Acceso ---------------------------------------------------------------

  get tenantId(): string {
    return this.props.tenantId;
  }
  get clientId(): string {
    return this.props.clientId;
  }
  get appointmentId(): string | null {
    return this.props.appointmentId;
  }
  get serviceId(): string | null {
    return this.props.serviceId;
  }
  get kind(): ClientPhotoKindValue {
    return this.props.kind;
  }
  get storageKey(): string {
    return this.props.storageKey;
  }
  get mimeType(): string {
    return this.props.mimeType;
  }
  get sizeBytes(): number {
    return this.props.sizeBytes;
  }
  get checksum(): string {
    return this.props.checksum;
  }
  get width(): number | null {
    return this.props.width;
  }
  get height(): number | null {
    return this.props.height;
  }
  get originalName(): string | null {
    return this.props.originalName;
  }
  get caption(): string | null {
    return this.props.caption;
  }
  get notes(): string | null {
    return this.props.notes;
  }
  get takenAt(): Date {
    return this.props.takenAt;
  }
  get consent(): PhotoConsent {
    return this.props.consent;
  }
  get purgedAt(): Date | null {
    return this.props.purgedAt;
  }
  get audit(): AuditMetadata {
    return this.props.audit;
  }
  get isDeleted(): boolean {
    return this.props.audit.deletedAt !== null;
  }

  /** `true` si el fichero ya no existe en el almacén. */
  get isPurged(): boolean {
    return this.props.purgedAt !== null;
  }

  /**
   * `true` si se puede pedir una URL para verla.
   *
   * Una foto purgada está en la base pero no en el almacén: firmar una URL para ella daría
   * un enlace que devuelve 404 sin explicar por qué.
   */
  get isViewable(): boolean {
    return !this.isPurged;
  }

  /** `true` si se puede publicar. Guardar y publicar son dos permisos distintos. */
  get isPublishable(): boolean {
    return this.props.consent.allowsMarketing && !this.isDeleted && !this.isPurged;
  }

  // -- Comportamiento -------------------------------------------------------

  /** Corrige los datos descriptivos. El fichero en sí no se puede sustituir. */
  describe(
    changes: {
      kind?: ClientPhotoKindValue;
      caption?: string | null;
      notes?: string | null;
      appointmentId?: string | null;
      serviceId?: string | null;
      takenAt?: Date;
    },
    now: Date,
    actorId: string | null,
  ): void {
    if (this.isDeleted) {
      throw new BusinessRuleViolationError(
        'PHOTO_DELETED',
        'No se puede modificar una foto dada de baja',
        { photoId: this.id },
      );
    }
    if (changes.takenAt && changes.takenAt.getTime() > now.getTime()) {
      throw new DomainValidationError('La foto no puede ser posterior a hoy', 'takenAt');
    }

    this.props = {
      ...this.props,
      kind: changes.kind ?? this.props.kind,
      caption: changes.caption === undefined ? this.props.caption : changes.caption?.trim() || null,
      notes: changes.notes === undefined ? this.props.notes : changes.notes?.trim() || null,
      appointmentId:
        changes.appointmentId === undefined ? this.props.appointmentId : changes.appointmentId,
      serviceId: changes.serviceId === undefined ? this.props.serviceId : changes.serviceId,
      takenAt: changes.takenAt ?? this.props.takenAt,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }

  /**
   * Cambia el permiso de publicación.
   *
   * Se puede retirar en cualquier momento, incluso años después: un consentimiento es
   * revocable por definición, y una interfaz que solo permita concederlo sería una que no
   * respeta lo que dice pedir.
   */
  setMarketingConsent(allows: boolean, now: Date, actorId: string | null): void {
    this.props = {
      ...this.props,
      consent: { ...this.props.consent, allowsMarketing: allows },
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
    // Una foto purgada no se puede recuperar: el fichero ya no está. Dejar que la fila
    // volviera a estar activa daría una galería con huecos que nadie sabría explicar.
    if (this.isPurged) {
      throw new BusinessRuleViolationError(
        'PHOTO_ALREADY_PURGED',
        'Esta foto se eliminó definitivamente y su fichero ya no existe',
        { photoId: this.id, purgedAt: this.props.purgedAt?.toISOString() },
      );
    }

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
   * Deja constancia de que el fichero se ha borrado del almacén.
   *
   * Es el paso que convierte «ya no se ve» en «ya no existe». Exige la baja lógica previa
   * porque purgar una foto activa dejaría la galería mostrando un enlace roto, y porque el
   * borrado de un dato personal debe ser una decisión en dos tiempos y no un clic.
   */
  markPurged(now: Date, actorId: string | null): void {
    if (!this.isDeleted) {
      throw new BusinessRuleViolationError(
        'PHOTO_NOT_DELETED',
        'Antes de eliminar el fichero hay que dar de baja la foto',
        { photoId: this.id },
      );
    }
    if (this.isPurged) return;

    this.props = {
      ...this.props,
      purgedAt: now,
      audit: { ...this.props.audit, updatedAt: now, updatedBy: actorId },
    };
  }
}
