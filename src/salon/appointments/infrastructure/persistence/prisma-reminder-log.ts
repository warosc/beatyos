import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { EntityNotFoundError } from '../../../../shared/domain/errors';
import { withMappedErrors } from '../../../../shared/infrastructure/persistence/prisma/prisma-error.mapper';
import { PrismaService } from '../../../../shared/infrastructure/persistence/prisma/prisma.service';
import { QueryScopeStore } from '../../../../shared/infrastructure/persistence/prisma/query-scope';
import type { ReminderAttempt, ReminderContext, ReminderLog } from '../../domain/agenda.ports';

const CONTEXT_SELECT = {
  id: true,
  tenantId: true,
  startsAt: true,
  tenant: { select: { name: true } },
  client: { select: { firstName: true, phone: true } },
  stylist: { select: { firstName: true, lastName: true, displayName: true } },
  services: { orderBy: { sortOrder: 'asc' }, select: { service: { select: { name: true } } } },
} satisfies Prisma.AppointmentSelect;

type ContextRow = Prisma.AppointmentGetPayload<{ select: typeof CONTEXT_SELECT }>;

/** Citas a las que podría tocar recordar: vivas, pendientes o confirmadas, sin recordar. */
const dueWhere = (window: { from: Date; to: Date }): Prisma.AppointmentWhereInput => ({
  status: { in: ['SCHEDULED', 'CONFIRMED'] },
  reminderSentAt: null,
  startsAt: { gte: window.from, lte: window.to },
  // Sin teléfono ya se intentó y se descartó: no se vuelve a intentar en cada pasada.
  reminders: { none: { status: 'SKIPPED' } },
});

@Injectable()
export class PrismaReminderLog implements ReminderLog {
  constructor(private readonly prisma: PrismaService) {}

  async record(attempt: ReminderAttempt): Promise<void> {
    await withMappedErrors('Recordatorio', () =>
      this.prisma.client.appointmentReminder.create({
        data: {
          id: attempt.id,
          tenantId: attempt.tenantId,
          appointmentId: attempt.appointmentId,
          channel: attempt.channel,
          recipient: attempt.recipient,
          status: attempt.status,
          error: attempt.error,
          providerId: attempt.providerId,
          createdAt: attempt.createdAt,
          createdBy: attempt.createdBy,
        },
      }),
    );
  }

  async findDue(window: { from: Date; to: Date }, maxFailures: number): Promise<ReminderContext[]> {
    const rows = await withMappedErrors('Recordatorio', () =>
      this.prisma.client.appointment.findMany({
        where: dueWhere(window),
        select: {
          ...CONTEXT_SELECT,
          _count: { select: { reminders: { where: { status: 'FAILED' } } } },
        },
        orderBy: { startsAt: 'asc' },
        // Una pasada no debe tardar minutos: lo que no quepa sale en la siguiente.
        take: 200,
      }),
    );

    return rows
      .filter((row) => row._count.reminders < maxFailures)
      .map((row) => this.toContext(row));
  }

  async contextFor(appointmentId: string): Promise<ReminderContext> {
    const row = await withMappedErrors('Cita', () =>
      this.prisma.client.appointment.findFirst({
        where: { id: appointmentId },
        select: CONTEXT_SELECT,
      }),
    );
    if (!row) throw new EntityNotFoundError('Cita', appointmentId);
    return this.toContext(row);
  }

  /**
   * Salones con recordatorios pendientes. Es una de las pocas consultas **entre salones**
   * del sistema, y solo devuelve identificadores: el envío en sí corre después dentro de
   * cada salón, con su aislamiento normal.
   */
  async tenantsWithDue(window: { from: Date; to: Date }): Promise<string[]> {
    const rows = await QueryScopeStore.crossTenant(() =>
      this.prisma.client.appointment.findMany({
        where: dueWhere(window),
        select: { tenantId: true },
        distinct: ['tenantId'],
      }),
    );
    return rows.map((row) => row.tenantId);
  }

  async markReminderSent(appointmentId: string, at: Date): Promise<void> {
    await withMappedErrors('Cita', () =>
      this.prisma.client.appointment.updateMany({
        where: { id: appointmentId },
        data: { reminderSentAt: at },
      }),
    );
  }

  async assignConfirmationToken(appointmentId: string, tokenHash: string): Promise<void> {
    await withMappedErrors('Cita', () =>
      this.prisma.client.appointment.updateMany({
        where: { id: appointmentId },
        data: { confirmationTokenHash: tokenHash },
      }),
    );
  }

  /**
   * Localiza la cita de un enlace **entre salones**: quien lo abre no ha iniciado sesión y
   * el salón se averigua precisamente por el enlace. Se busca por el hash, que es único;
   * el token en claro nunca toca la base.
   */
  async findByConfirmationToken(
    tokenHash: string,
  ): Promise<{ appointmentId: string; tenantId: string } | null> {
    const row = await QueryScopeStore.crossTenant(() =>
      this.prisma.client.appointment.findFirst({
        where: { confirmationTokenHash: tokenHash },
        select: { id: true, tenantId: true },
      }),
    );
    return row ? { appointmentId: row.id, tenantId: row.tenantId } : null;
  }

  private toContext(row: ContextRow): ReminderContext {
    return {
      appointmentId: row.id,
      tenantId: row.tenantId,
      salonName: row.tenant.name,
      clientFirstName: row.client.firstName,
      clientPhone: row.client.phone,
      stylistName:
        row.stylist.displayName ?? `${row.stylist.firstName} ${row.stylist.lastName}`.trim(),
      serviceNames: row.services.map((line) => line.service.name),
      startsAt: row.startsAt,
    };
  }
}
