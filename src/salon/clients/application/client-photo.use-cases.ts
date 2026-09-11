import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  AUDIT_RECORDER,
  CLOCK,
  ID_GENERATOR,
  type AuditRecorder,
  type Clock,
  type IdGenerator,
  type UseCase,
} from '../../../shared/application/ports';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../../../shared/application/object-storage.port';
import { BusinessRuleViolationError } from '../../../shared/domain/errors';
import {
  detectImageSignature,
  readImageDimensions,
} from '../../../shared/domain/media/image-signature';
import type { Page, PageRequest } from '../../../shared/domain/ports/repository.port';
import type { Env } from '../../../shared/infrastructure/config/env.schema';
import {
  ClientPhoto,
  type ClientPhotoKindValue,
  type PhotoConsentSourceValue,
} from '../domain/client-photo.entity';
import {
  CLIENT_PHOTO_REPOSITORY,
  type ClientPhotoFilter,
  type ClientPhotoRepository,
  type ClientPhotoSortField,
} from '../domain/client-photo.repository';
import { CLIENT_REPOSITORY, type ClientRepository } from '../domain/client.repository';

// ===========================================================================
// Subida
// ===========================================================================

export interface UploadClientPhotoInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly content: Buffer;
  readonly originalName?: string | null;
  readonly kind?: ClientPhotoKindValue;
  readonly appointmentId?: string | null;
  readonly serviceId?: string | null;
  readonly caption?: string | null;
  readonly notes?: string | null;
  readonly takenAt?: Date | null;
  readonly consentGivenAt: Date;
  readonly consentSource?: PhotoConsentSourceValue;
  readonly allowsMarketing?: boolean;
  readonly actorId: string | null;
}

export interface UploadClientPhotoResult {
  readonly photo: ClientPhoto;
  /** `true` si el fichero ya estaba subido y se ha devuelto el existente. */
  readonly deduplicated: boolean;
}

/**
 * Sube una foto al historial de una clienta (ADR-0016).
 *
 * El orden de los pasos importa y no es el obvio:
 *
 * 1. **Identificar el fichero por sus bytes.** El tipo declarado no se usa para nada.
 * 2. **Comprobar duplicados por huella**, antes de escribir en el almacén.
 * 3. **Escribir el objeto.**
 * 4. **Escribir la fila.**
 *
 * Escribir primero el objeto y después la fila puede dejar un objeto huérfano si la base
 * falla; hacerlo al revés dejaría una fila apuntando a un fichero que no existe, que es
 * peor: la galería mostraría un hueco y nadie sabría por qué. Un huérfano solo ocupa
 * espacio y lo recoge la purga.
 */
@Injectable()
export class UploadClientPhotoUseCase implements UseCase<
  UploadClientPhotoInput,
  UploadClientPhotoResult
> {
  private readonly maxBytes: number;

  constructor(
    @Inject(CLIENT_PHOTO_REPOSITORY) private readonly photos: ClientPhotoRepository,
    @Inject(CLIENT_REPOSITORY) private readonly clients: ClientRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    config: ConfigService<Env, true>,
  ) {
    this.maxBytes = config.get('PHOTO_MAX_BYTES', { infer: true });
  }

  async execute(input: UploadClientPhotoInput): Promise<UploadClientPhotoResult> {
    const now = this.clock.now();

    if (input.content.length === 0) {
      throw new BusinessRuleViolationError('EMPTY_FILE', 'El fichero está vacío');
    }
    if (input.content.length > this.maxBytes) {
      throw new BusinessRuleViolationError(
        'FILE_TOO_LARGE',
        `La foto ocupa ${mb(input.content.length)} MB y el máximo son ${mb(this.maxBytes)} MB`,
        { sizeBytes: input.content.length, maxBytes: this.maxBytes },
      );
    }

    // El tipo se deduce del contenido. Un fichero que dice ser `image/jpeg` y empieza por
    // `<html>` se rechaza aquí, que es antes de tocar el almacén.
    const signature = detectImageSignature(input.content);
    if (!signature) {
      throw new BusinessRuleViolationError(
        'UNSUPPORTED_IMAGE_TYPE',
        'El fichero no es una imagen reconocible. Admitimos JPEG, PNG, WebP y HEIC.',
      );
    }

    // Que la clienta exista se comprueba antes de subir nada: si no existe, el objeto
    // quedaría huérfano en el almacén sin que nadie llegue a saberlo.
    const client = await this.clients.findByIdOrFail(input.clientId);

    const checksum = sha256(input.content);

    const existing = await this.photos.findByChecksum(client.id, checksum);
    if (existing && !existing.isDeleted) {
      return { photo: existing, deduplicated: true };
    }

    const photoId = this.ids.generate();
    const storageKey = buildStorageKey({
      tenantId: input.tenantId,
      clientId: client.id,
      photoId,
      extension: signature.extension,
      now,
    });

    const dimensions = readImageDimensions(input.content);

    const stored = await this.storage.put({
      key: storageKey,
      body: input.content,
      contentType: signature.mimeType,
      downloadName: input.originalName ?? `${photoId}.${signature.extension}`,
    });

    const photo = ClientPhoto.register({
      id: photoId,
      tenantId: input.tenantId,
      clientId: client.id,
      storageKey: stored.key,
      mimeType: signature.mimeType,
      sizeBytes: stored.sizeBytes,
      checksum: stored.checksum,
      kind: input.kind,
      appointmentId: input.appointmentId ?? null,
      serviceId: input.serviceId ?? null,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      originalName: input.originalName ?? null,
      caption: input.caption ?? null,
      notes: input.notes ?? null,
      takenAt: input.takenAt ?? null,
      consent: {
        givenAt: input.consentGivenAt,
        source: input.consentSource ?? 'IN_PERSON',
        allowsMarketing: input.allowsMarketing ?? false,
      },
      now,
      actorId: input.actorId,
    });

    const saved = await this.photos.create(photo);

    await this.audit.record({
      action: 'CREATE',
      entityType: 'ClientPhoto',
      entityId: saved.id,
      after: {
        clientId: saved.clientId,
        kind: saved.kind,
        sizeBytes: saved.sizeBytes,
        // El consentimiento se audita: es la prueba de que se pidió, y es la que hay que
        // poder enseñar si alguien reclama.
        consentGivenAt: saved.consent.givenAt.toISOString(),
        consentSource: saved.consent.source,
      },
    });

    return { photo: saved, deduplicated: false };
  }
}

// ===========================================================================
// Consulta
// ===========================================================================

export interface PhotoWithUrl {
  readonly photo: ClientPhoto;
  /** URL temporal. `null` si el fichero ya se purgó. */
  readonly url: string | null;
  readonly expiresAt: Date;
}

/**
 * Galería de una clienta, con las URL ya firmadas.
 *
 * Se firman todas de una vez en lugar de exponer un endpoint por foto: una galería de veinte
 * imágenes serían veinte peticiones más, cada una con su comprobación de permisos, para
 * pintar una sola pantalla.
 *
 * Firmar es una operación local —no llama al almacén—, así que hacerlo en lote no cuesta más
 * que hacerlo de una en una.
 */
@Injectable()
export class SearchClientPhotosUseCase implements UseCase<
  { filter: ClientPhotoFilter; page: PageRequest<ClientPhotoSortField> },
  Page<PhotoWithUrl>
> {
  private readonly ttlSeconds: number;

  constructor(
    @Inject(CLIENT_PHOTO_REPOSITORY) private readonly photos: ClientPhotoRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(CLOCK) private readonly clock: Clock,
    config: ConfigService<Env, true>,
  ) {
    this.ttlSeconds = config.get('PHOTO_URL_TTL_SECONDS', { infer: true });
  }

  async execute(input: {
    filter: ClientPhotoFilter;
    page: PageRequest<ClientPhotoSortField>;
  }): Promise<Page<PhotoWithUrl>> {
    const page = await this.photos.search(input.filter, input.page);
    const expiresAt = new Date(this.clock.now().getTime() + this.ttlSeconds * 1000);

    const data = await Promise.all(
      page.data.map(async (photo) => ({
        photo,
        // Una foto purgada no tiene fichero: firmar su URL daría un enlace que devuelve 404
        // sin explicar por qué. `null` deja que la interfaz muestre lo que corresponda.
        url: photo.isViewable
          ? await this.storage.presignedGetUrl(photo.storageKey, this.ttlSeconds)
          : null,
        expiresAt,
      })),
    );

    return { data, meta: page.meta };
  }
}

// ===========================================================================
// Modificación
// ===========================================================================

export interface DescribeClientPhotoInput {
  readonly photoId: string;
  readonly kind?: ClientPhotoKindValue;
  readonly caption?: string | null;
  readonly notes?: string | null;
  readonly appointmentId?: string | null;
  readonly serviceId?: string | null;
  readonly allowsMarketing?: boolean;
  readonly actorId: string | null;
}

@Injectable()
export class DescribeClientPhotoUseCase implements UseCase<DescribeClientPhotoInput, ClientPhoto> {
  constructor(
    @Inject(CLIENT_PHOTO_REPOSITORY) private readonly photos: ClientPhotoRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: DescribeClientPhotoInput): Promise<ClientPhoto> {
    const photo = await this.photos.findByIdOrFail(input.photoId);
    const now = this.clock.now();
    const before = { kind: photo.kind, allowsMarketing: photo.consent.allowsMarketing };

    photo.describe(
      {
        kind: input.kind,
        caption: input.caption,
        notes: input.notes,
        appointmentId: input.appointmentId,
        serviceId: input.serviceId,
      },
      now,
      input.actorId,
    );

    if (input.allowsMarketing !== undefined) {
      photo.setMarketingConsent(input.allowsMarketing, now, input.actorId);
    }

    const saved = await this.photos.update(photo);

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'ClientPhoto',
      entityId: saved.id,
      before,
      after: { kind: saved.kind, allowsMarketing: saved.consent.allowsMarketing },
    });

    return saved;
  }
}

// ===========================================================================
// Baja y purga
// ===========================================================================

@Injectable()
export class DeleteClientPhotoUseCase implements UseCase<
  { photoId: string; actorId: string | null },
  void
> {
  constructor(
    @Inject(CLIENT_PHOTO_REPOSITORY) private readonly photos: ClientPhotoRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: { photoId: string; actorId: string | null }): Promise<void> {
    const photo = await this.photos.findByIdOrFail(input.photoId);

    photo.markDeleted(this.clock.now(), input.actorId);
    await this.photos.update(photo);

    await this.audit.record({
      action: 'DELETE',
      entityType: 'ClientPhoto',
      entityId: photo.id,
      before: { clientId: photo.clientId, kind: photo.kind },
    });
  }
}

export interface PurgeResult {
  readonly purged: number;
  readonly failed: number;
}

/**
 * Borra del almacén los ficheros de las fotos dadas de baja hace tiempo.
 *
 * Es lo que convierte el borrado lógico en un borrado real, y sin esto el derecho de
 * supresión quedaría a medias: la foto desaparecería de la interfaz y seguiría en el disco.
 *
 * Va en dos tiempos —baja hoy, purga pasados unos días— porque borrar un fichero no tiene
 * vuelta atrás y una baja por error tiene que poder deshacerse.
 *
 * Un fallo al borrar un objeto **no detiene el resto**. Si el almacén rechaza uno, los demás
 * deben purgarse igualmente; el que falle seguirá pendiente y se reintentará en la siguiente
 * pasada, que es exactamente lo que se quiere de un proceso que se ejecuta a diario.
 */
@Injectable()
export class PurgeDeletedPhotosUseCase implements UseCase<
  { olderThanDays?: number; limit?: number },
  PurgeResult
> {
  constructor(
    @Inject(CLIENT_PHOTO_REPOSITORY) private readonly photos: ClientPhotoRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: { olderThanDays?: number; limit?: number }): Promise<PurgeResult> {
    const now = this.clock.now();
    const candidates = await this.photos.findPurgeable(
      input.olderThanDays ?? 30,
      now,
      input.limit ?? 100,
    );

    let purged = 0;
    let failed = 0;

    for (const photo of candidates) {
      try {
        await this.storage.remove(photo.storageKey);
        photo.markPurged(now, null);
        await this.photos.update(photo);
        purged += 1;

        await this.audit.record({
          action: 'DELETE',
          entityType: 'ClientPhoto',
          entityId: photo.id,
          metadata: { purged: true, storageKey: photo.storageKey },
        });
      } catch {
        // Se anota y se sigue: el objeto queda pendiente y la próxima pasada lo reintenta.
        failed += 1;
      }
    }

    return { purged, failed };
  }
}

// ===========================================================================

const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

/**
 * Construye la ruta del objeto.
 *
 * Tres decisiones deliberadas:
 *
 * - **El prefijo empieza por el inquilino.** Permite dar permisos por prefijo en el almacén,
 *   listar lo que ocupa un salón y borrarlo entero si se da de baja.
 * - **La partición por año y mes** evita el directorio con cien mil objetos, que en S3 no es
 *   un problema pero sí lo es en cualquier herramienta que intente listarlo.
 * - **El nombre lo pone el sistema**, a partir del identificador y de la extensión deducida
 *   del contenido. Nada de lo que envía el cliente entra en la ruta: un nombre como
 *   `../../otro-salon/foto.jpg` escaparía del prefijo, y la forma de impedirlo es no darle
 *   la oportunidad en lugar de intentar limpiarlo.
 */
export const buildStorageKey = (params: {
  tenantId: string;
  clientId: string;
  photoId: string;
  extension: string;
  now: Date;
}): string => {
  const year = params.now.getUTCFullYear();
  const month = String(params.now.getUTCMonth() + 1).padStart(2, '0');

  return `tenants/${params.tenantId}/clients/${params.clientId}/${year}/${month}/${params.photoId}.${params.extension}`;
};
