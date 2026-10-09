import { Injectable } from '@nestjs/common';

import { withMappedErrors } from '../../../../shared/infrastructure/persistence/prisma/prisma-error.mapper';
import { QueryScopeStore } from '../../../../shared/infrastructure/persistence/prisma/query-scope';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import type {
  AgendaDirectory,
  AgendaLabels,
  AppointmentSummary,
  ReminderLabel,
} from '../../domain/agenda.ports';

const fullName = (row: { firstName: string; lastName: string }) =>
  `${row.firstName} ${row.lastName}`.trim();

/** El mismo nombre corto que da la ficha (`Stylist.displayName`): «Sara», no «Sara Molina». */
const stylistName = (row: { firstName: string; displayName: string | null }) =>
  row.displayName ?? row.firstName;

/**
 * Etiquetas de la agenda: una consulta por tipo, nunca una por cita.
 *
 * Una semana de un salón con seis profesionales ronda las doscientas citas; resolver sus
 * nombres de uno en uno serían doscientas consultas por cada vez que alguien abre la
 * agenda —y con el aviso en tiempo real, cada vez que alguien agenda—.
 */
@Injectable()
export class PrismaAgendaDirectory implements AgendaDirectory {
  constructor(private readonly prisma: PrismaService) {}

  async describe(
    appointments: readonly {
      id: string;
      clientId: string;
      stylistId: string;
      serviceIds: readonly string[];
    }[],
  ): Promise<AgendaLabels> {
    if (appointments.length === 0) {
      return {
        clients: new Map(),
        stylists: new Map(),
        services: new Map(),
        pendingChanges: new Map(),
        lastReminders: new Map(),
      };
    }

    const ids = appointments.map((a) => a.id);
    const clientIds = [...new Set(appointments.map((a) => a.clientId))];
    const stylistIds = [...new Set(appointments.map((a) => a.stylistId))];
    const serviceIds = [...new Set(appointments.flatMap((a) => a.serviceIds))];

    // Las fichas dadas de baja también: una cita vieja de una clienta que se fue, o de un
    // servicio retirado, sigue necesitando nombre en el histórico.
    const [clients, stylists, services] = await QueryScopeStore.includingDeleted(() =>
      withMappedErrors('Agenda', () =>
        Promise.all([
          this.prisma.client.client.findMany({
            where: { id: { in: clientIds } },
            select: { id: true, firstName: true, lastName: true, phone: true },
          }),
          this.prisma.client.stylist.findMany({
            where: { id: { in: stylistIds } },
            select: { id: true, firstName: true, lastName: true, displayName: true, color: true },
          }),
          this.prisma.client.service.findMany({
            where: { id: { in: serviceIds } },
            select: { id: true, name: true, color: true },
          }),
        ]),
      ),
    );

    const [pending, reminders] = await withMappedErrors('Agenda', () =>
      Promise.all([
        this.prisma.client.appointmentChangeRequest.findMany({
          where: { appointmentId: { in: ids }, status: 'PENDING' },
          select: {
            id: true,
            appointmentId: true,
            proposedStartsAt: true,
            reason: true,
            createdAt: true,
          },
        }),
        this.prisma.client.appointmentReminder.findMany({
          where: { appointmentId: { in: ids } },
          orderBy: { createdAt: 'desc' },
          select: {
            appointmentId: true,
            channel: true,
            status: true,
            createdAt: true,
            error: true,
          },
        }),
      ]),
    );

    const lastReminders = new Map<string, ReminderLabel>();
    for (const reminder of reminders) {
      // Vienen de más reciente a más antiguo: el primero de cada cita es el último intento.
      if (!lastReminders.has(reminder.appointmentId)) {
        lastReminders.set(reminder.appointmentId, {
          channel: reminder.channel,
          status: reminder.status,
          at: reminder.createdAt,
          error: reminder.error,
        });
      }
    }

    return {
      clients: new Map(clients.map((c) => [c.id, { name: fullName(c), phone: c.phone }])),
      stylists: new Map(stylists.map((s) => [s.id, { name: stylistName(s), color: s.color }])),
      services: new Map(services.map((s) => [s.id, { name: s.name, color: s.color }])),
      pendingChanges: new Map(
        pending.map((p) => [
          p.appointmentId,
          {
            id: p.id,
            proposedStartsAt: p.proposedStartsAt,
            reason: p.reason,
            requestedAt: p.createdAt,
          },
        ]),
      ),
      lastReminders,
    };
  }

  async summarize(
    appointmentIds: readonly string[],
  ): Promise<ReadonlyMap<string, AppointmentSummary>> {
    const ids = [...new Set(appointmentIds)];
    if (ids.length === 0) return new Map();

    const rows = await withMappedErrors('Cita', () =>
      this.prisma.client.appointment.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          status: true,
          client: { select: { firstName: true, lastName: true } },
          stylist: {
            select: { firstName: true, lastName: true, displayName: true, color: true },
          },
          services: {
            orderBy: { sortOrder: 'asc' },
            select: { service: { select: { name: true } } },
          },
        },
      }),
    );

    return new Map(
      rows.map((row) => [
        row.id,
        {
          clientName: fullName(row.client),
          stylistName: stylistName(row.stylist),
          stylistColor: row.stylist.color,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          status: row.status,
          serviceNames: row.services.map((line) => line.service.name),
        },
      ]),
    );
  }
}
