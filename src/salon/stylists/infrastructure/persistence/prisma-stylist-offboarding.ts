import { Injectable } from '@nestjs/common';
import type { AppointmentStatus, QueueTurnStatus } from '@prisma/client';

import { withMappedErrors } from '../../../../shared/infrastructure/persistence/prisma/prisma-error.mapper';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import type {
  StylistOffboarding,
  StylistPendingWork,
} from '../../domain/stylist-offboarding.ports';

/** Citas que alguien tiene que atender todavía. */
const OPEN_APPOINTMENT: AppointmentStatus[] = ['SCHEDULED', 'CONFIRMED', 'IN_PROGRESS'];

/** Turnos que ya son suyos: la llamaron o tiene a la clienta en la silla. */
const ACTIVE_TURN: QueueTurnStatus[] = ['CALLED', 'IN_SERVICE'];

/** Las que caben en el aviso sin hacerlo eterno; el total se cuenta aparte. */
const LISTED = 50;

/**
 * Lee lo pendiente de una profesional directamente de las tablas de agenda, cola y comandas
 * (ADR-0028). Solo cuenta y lista; nunca decide.
 */
@Injectable()
export class PrismaStylistOffboarding implements StylistOffboarding {
  constructor(private readonly prisma: PrismaService) {}

  async pendingWorkOf(stylistId: string, now: Date): Promise<StylistPendingWork> {
    // `endsAt > now`, no `startsAt >= now`: la cita que está ocurriendo ahora también cuenta.
    const appointmentWhere = {
      stylistId,
      status: { in: OPEN_APPOINTMENT },
      endsAt: { gt: now },
    };
    const ticketWhere = { stylistId, status: 'PENDING' as const };

    const [appointmentCount, appointments, ticketCount, tickets, turns, waiting] =
      await withMappedErrors('Profesional', () =>
        Promise.all([
          this.prisma.client.appointment.count({ where: appointmentWhere }),
          this.prisma.client.appointment.findMany({
            where: appointmentWhere,
            orderBy: { startsAt: 'asc' },
            take: LISTED,
            select: {
              id: true,
              startsAt: true,
              endsAt: true,
              status: true,
              client: { select: { firstName: true, lastName: true } },
              services: {
                orderBy: { sortOrder: 'asc' },
                select: { service: { select: { name: true } } },
              },
            },
          }),
          this.prisma.client.serviceTicket.count({ where: ticketWhere }),
          this.prisma.client.serviceTicket.findMany({
            where: ticketWhere,
            orderBy: { createdAt: 'asc' },
            take: LISTED,
            select: { id: true, createdAt: true, clientName: true },
          }),
          this.prisma.client.queueTurn.findMany({
            where: { stylistId, status: { in: ACTIVE_TURN } },
            orderBy: { number: 'asc' },
            select: { id: true, number: true, clientName: true, status: true },
          }),
          this.prisma.client.queueTurn.count({
            where: { preferredStylistId: stylistId, status: 'WAITING' },
          }),
        ]),
      );

    return {
      appointments: {
        total: appointmentCount,
        items: appointments.map((row) => ({
          id: row.id,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          status: row.status,
          clientName: `${row.client.firstName} ${row.client.lastName}`.trim(),
          serviceNames: row.services.map((line) => line.service.name),
        })),
      },
      pendingTickets: { total: ticketCount, items: tickets },
      activeQueueTurns: turns,
      waitingPreferences: waiting,
    };
  }

  async releaseQueuePreferences(stylistId: string): Promise<number> {
    const result = await withMappedErrors('Turno', () =>
      this.prisma.client.queueTurn.updateMany({
        where: { preferredStylistId: stylistId, status: 'WAITING' },
        data: { preferredStylistId: null },
      }),
    );
    return result.count;
  }
}
