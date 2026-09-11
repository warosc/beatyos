import { Inject, Injectable } from '@nestjs/common';
import type { ClientPhoto as PhotoRow } from '@prisma/client';

import { CLOCK, type Clock } from '../../../../shared/application/ports';
import { EntityNotFoundError } from '../../../../shared/domain/errors';
import { withMappedErrors } from '../../../../shared/infrastructure/persistence/prisma/prisma-error.mapper';
import {
  PrismaRepositoryBase,
  type OrderByClause,
} from '../../../../shared/infrastructure/persistence/prisma/prisma-repository.base';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import { ClientPhoto } from '../../domain/client-photo.entity';
import type {
  ClientPhotoFilter,
  ClientPhotoRepository,
  ClientPhotoSortField,
} from '../../domain/client-photo.repository';

@Injectable()
export class PrismaClientPhotoRepository
  extends PrismaRepositoryBase<ClientPhoto, PhotoRow, ClientPhotoFilter, ClientPhotoSortField>
  implements ClientPhotoRepository
{
  constructor(prisma: PrismaService, @Inject(CLOCK) clock: Clock) {
    super(prisma, clock);
  }

  protected readonly delegateName = 'clientPhoto';
  protected readonly entityName = 'Foto';

  protected readonly sortableFields: ReadonlyMap<
    ClientPhotoSortField,
    OrderByClause | OrderByClause[]
  > = new Map<ClientPhotoSortField, OrderByClause | OrderByClause[]>([
    // El desempate por creación hace la galería estable: varias fotos del mismo servicio
    // comparten `takenAt` al segundo y sin desempate cambiarían de orden en cada carga.
    ['takenAt', [{ takenAt: true }, { createdAt: true }]],
    ['createdAt', { createdAt: true }],
  ]);

  protected readonly defaultSort = [{ field: 'takenAt' as const, direction: 'desc' as const }];

  async findByChecksum(clientId: string, checksum: string): Promise<ClientPhoto | null> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.clientPhoto.findFirst({
        where: { clientId, checksum: checksum.toLowerCase() },
      }),
    );
    return row ? this.toDomain(row) : null;
  }

  async create(photo: ClientPhoto): Promise<ClientPhoto> {
    const row = await withMappedErrors(this.entityName, () =>
      this.prisma.client.clientPhoto.create({
        data: {
          id: photo.id,
          tenantId: photo.tenantId,
          clientId: photo.clientId,
          storageKey: photo.storageKey,
          mimeType: photo.mimeType,
          sizeBytes: photo.sizeBytes,
          checksum: photo.checksum,
          ...this.toPersistence(photo),
          createdAt: photo.audit.createdAt,
          updatedAt: photo.audit.updatedAt,
          createdBy: photo.audit.createdBy,
          updatedBy: photo.audit.updatedBy,
        },
      }),
    );
    return this.toDomain(row);
  }

  /**
   * Guarda los datos descriptivos y el estado. **No toca el fichero ni su huella.**
   *
   * La referencia al objeto es inmutable una vez creada: sustituir el fichero de una foto
   * dejaría el `checksum` mintiendo sobre su contenido y rompería la deduplicación, que se
   * apoya justo en esa huella.
   */
  async update(photo: ClientPhoto): Promise<ClientPhoto> {
    // El ambito de borrados se declara **explicitamente** cuando la foto ya esta de baja.
    //
    // La extension de Prisma impide por defecto que un `updateMany` alcance una fila
    // borrada, y hace bien: modificar lo que ya se dio de baja seria resucitar datos por la
    // puerta de atras (ADR-0004). Pero la purga es justo eso —marcar como purgada una foto
    // que ya esta de baja— y sin este ambito la actualizacion no encontraba ninguna fila,
    // asi que el fichero se borraba del almacen y la base seguia diciendo que existia.
    //
    // Lo que hace correcto levantarlo aqui es que la operacion no revive nada: la fila
    // sigue borrada antes y despues, y lo unico que cambia es `purgedAt`.
    const result = await this.scoped({ includeDeleted: photo.isDeleted }, () =>
      withMappedErrors(this.entityName, () =>
        this.prisma.client.clientPhoto.updateMany({
          where: { id: photo.id },
          data: {
            ...this.toPersistence(photo),
            updatedAt: photo.audit.updatedAt,
            updatedBy: photo.audit.updatedBy,
          },
        }),
      ),
    );

    if (result.count === 0) {
      throw new EntityNotFoundError(this.entityName, photo.id);
    }

    return this.findByIdOrFail(photo.id, { includeDeleted: photo.isDeleted });
  }

  async save(photo: ClientPhoto): Promise<ClientPhoto> {
    return this.update(photo);
  }

  /**
   * Fotos dadas de baja hace tiempo cuyo fichero sigue en el almacén.
   *
   * Consulta **entre las borradas**, que es donde viven por definición: sin
   * `includeDeleted`, la extensión las filtraría y la purga no encontraría nunca nada.
   */
  async findPurgeable(days: number, now: Date, limit: number): Promise<ClientPhoto[]> {
    const cutoff = new Date(now.getTime() - days * 86_400_000);

    const rows = await this.scoped({ includeDeleted: true }, () =>
      withMappedErrors(this.entityName, () =>
        this.prisma.client.clientPhoto.findMany({
          where: { deletedAt: { not: null, lte: cutoff }, purgedAt: null },
          orderBy: { deletedAt: 'asc' },
          take: limit,
        }),
      ),
    );

    return rows.map((row) => this.toDomain(row));
  }

  protected buildWhere(filter: ClientPhotoFilter): Record<string, unknown> {
    return this.compose(
      filter.clientId ? { clientId: filter.clientId } : undefined,
      filter.appointmentId ? { appointmentId: filter.appointmentId } : undefined,
      filter.serviceId ? { serviceId: filter.serviceId } : undefined,
      filter.kind ? { kind: filter.kind } : undefined,
      this.dateRange(filter.from, filter.to)
        ? { takenAt: this.dateRange(filter.from, filter.to) }
        : undefined,
      // Publicar exige permiso **y** que el fichero siga existiendo.
      filter.onlyPublishable ? { allowsMarketing: true, purgedAt: null } : undefined,
    );
  }

  private toPersistence(photo: ClientPhoto) {
    return {
      appointmentId: photo.appointmentId,
      serviceId: photo.serviceId,
      kind: photo.kind,
      width: photo.width,
      height: photo.height,
      originalName: photo.originalName,
      caption: photo.caption,
      notes: photo.notes,
      takenAt: photo.takenAt,
      consentGivenAt: photo.consent.givenAt,
      consentSource: photo.consent.source,
      allowsMarketing: photo.consent.allowsMarketing,
      purgedAt: photo.purgedAt,
      deletedAt: photo.audit.deletedAt,
      deletedBy: photo.audit.deletedBy,
    };
  }

  protected toDomain(row: PhotoRow): ClientPhoto {
    return ClientPhoto.rehydrate(row.id, {
      tenantId: row.tenantId,
      clientId: row.clientId,
      appointmentId: row.appointmentId,
      serviceId: row.serviceId,
      kind: row.kind,
      storageKey: row.storageKey,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      checksum: row.checksum,
      width: row.width,
      height: row.height,
      originalName: row.originalName,
      caption: row.caption,
      notes: row.notes,
      takenAt: row.takenAt,
      consent: {
        givenAt: row.consentGivenAt,
        source: row.consentSource,
        allowsMarketing: row.allowsMarketing,
      },
      purgedAt: row.purgedAt,
      audit: {
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deletedAt: row.deletedAt,
        createdBy: row.createdBy,
        updatedBy: row.updatedBy,
        deletedBy: row.deletedBy,
      },
    });
  }
}
