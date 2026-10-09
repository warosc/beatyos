import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictError, EntityNotFoundError } from '../../../../shared/domain/errors';
import { withMappedErrors } from '../../../../shared/infrastructure/persistence/prisma/prisma-error.mapper';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import { AppointmentChangeRequest } from '../../domain/change-request.entity';
import type {
  ChangeRequestFilter,
  ChangeRequestRepository,
} from '../../domain/change-request.repository';

type Row = Prisma.AppointmentChangeRequestGetPayload<object>;

const ENTITY = 'Solicitud de cambio';

@Injectable()
export class PrismaChangeRequestRepository implements ChangeRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByIdOrFail(id: string): Promise<AppointmentChangeRequest> {
    const row = await withMappedErrors(ENTITY, () =>
      this.prisma.client.appointmentChangeRequest.findFirst({ where: { id } }),
    );
    if (!row) throw new EntityNotFoundError(ENTITY, id);
    return this.toDomain(row);
  }

  async findPendingForAppointment(appointmentId: string): Promise<AppointmentChangeRequest | null> {
    const row = await withMappedErrors(ENTITY, () =>
      this.prisma.client.appointmentChangeRequest.findFirst({
        where: { appointmentId, status: 'PENDING' },
      }),
    );
    return row ? this.toDomain(row) : null;
  }

  async list(filter: ChangeRequestFilter, limit: number): Promise<AppointmentChangeRequest[]> {
    const rows = await withMappedErrors(ENTITY, () =>
      this.prisma.client.appointmentChangeRequest.findMany({
        where: {
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.stylistId ? { stylistId: filter.stylistId } : {}),
          ...(filter.appointmentIds ? { appointmentId: { in: [...filter.appointmentIds] } } : {}),
          ...(filter.decidedSince ? { decidedAt: { gte: filter.decidedSince } } : {}),
        },
        // Las pendientes, de la más antigua a la más reciente: quien lleva más tiempo
        // esperando respuesta va primero. Las decididas, al revés.
        orderBy: filter.status === 'PENDING' ? { createdAt: 'asc' } : [{ updatedAt: 'desc' }],
        take: limit,
      }),
    );
    return rows.map((row) => this.toDomain(row));
  }

  countPending(): Promise<number> {
    return withMappedErrors(ENTITY, () =>
      this.prisma.client.appointmentChangeRequest.count({ where: { status: 'PENDING' } }),
    );
  }

  async create(request: AppointmentChangeRequest): Promise<AppointmentChangeRequest> {
    try {
      const row = await this.prisma.client.appointmentChangeRequest.create({
        data: { id: request.id, tenantId: request.tenantId, ...this.toPersistence(request) },
      });
      return this.toDomain(row);
    } catch (error) {
      // El índice único parcial no lleva el nombre en el mensaje de Prisma, solo el campo:
      // se traduce aquí, que es donde se sabe qué significa.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError(
          'CHANGE_REQUEST_ALREADY_PENDING',
          'Ya hay un cambio pendiente para esta cita',
        );
      }
      throw error;
    }
  }

  /**
   * Toda escritura es una decisión sobre una petición pendiente, así que solo se guarda si
   * en la base **sigue pendiente**. Si dos encargadas responden a la vez —o la profesional la
   * retira mientras tanto—, la segunda no encuentra fila y recibe un conflicto en lugar de
   * dejar la cita movida con la petición marcada como rechazada.
   */
  async update(request: AppointmentChangeRequest): Promise<AppointmentChangeRequest> {
    const result = await withMappedErrors(ENTITY, () =>
      this.prisma.client.appointmentChangeRequest.updateMany({
        where: { id: request.id, status: 'PENDING' },
        data: this.toPersistence(request),
      }),
    );
    if (result.count === 0) {
      await this.findByIdOrFail(request.id);
      throw new ConflictError(
        'CHANGE_REQUEST_ALREADY_DECIDED',
        'Otra persona ya respondió esta petición. Actualiza la lista.',
      );
    }
    return this.findByIdOrFail(request.id);
  }

  private toPersistence(request: AppointmentChangeRequest) {
    return {
      appointmentId: request.appointmentId,
      stylistId: request.stylistId,
      requestedBy: request.requestedBy,
      currentStartsAt: request.currentStartsAt,
      proposedStartsAt: request.proposedStartsAt,
      reason: request.reason,
      status: request.status,
      decidedBy: request.decidedBy,
      decidedAt: request.decidedAt,
      decisionNote: request.decisionNote,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    };
  }

  private toDomain(row: Row): AppointmentChangeRequest {
    return AppointmentChangeRequest.rehydrate(row.id, {
      tenantId: row.tenantId,
      appointmentId: row.appointmentId,
      stylistId: row.stylistId,
      requestedBy: row.requestedBy,
      currentStartsAt: row.currentStartsAt,
      proposedStartsAt: row.proposedStartsAt,
      reason: row.reason,
      status: row.status,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt,
      decisionNote: row.decisionNote,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}
