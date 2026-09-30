import type { Appointment } from '@/features/agenda/types';
import type { ServiceTicket } from '@/features/service-tickets/types';

/**
 * El día de la profesional: qué cita toca ahora y cuáles le falta declarar.
 *
 * Lógica pura. La decide la hora, no un botón: en un salón con trabajo nadie pulsa
 * «empezar», así que la cita pasa sola a «atendiendo ahora» cuando llega su hora, y a «falta
 * registrar» cuando termina sin que se haya enviado a caja.
 */

export type DayGroup = 'now' | 'overdue' | 'upcoming';

export interface DayAppointment {
  appointment: Appointment;
  group: DayGroup;
}

export interface StylistDay {
  now: Appointment[];
  overdue: Appointment[];
  upcoming: Appointment[];
  /** Lo que se recuerda en el menú: citas que ya tocan o ya pasaron y no se han declarado. */
  pendingCount: number;
}

/** Una cita cancelada o a la que la clienta no vino no se atiende ni se declara. */
const SKIPPED = new Set(['CANCELLED', 'NO_SHOW']);

/** Comandas que cuentan: una anulada deja la cita otra vez sin declarar. */
export const registeredAppointmentIds = (tickets: readonly ServiceTicket[]): Set<string> =>
  new Set(
    tickets
      .filter((ticket) => ticket.status !== 'CANCELLED' && ticket.appointmentId)
      .map((ticket) => ticket.appointmentId as string),
  );

export function classifyDay(
  appointments: readonly Appointment[],
  tickets: readonly ServiceTicket[],
  now: Date,
): StylistDay {
  const registered = registeredAppointmentIds(tickets);
  const day: StylistDay = { now: [], overdue: [], upcoming: [], pendingCount: 0 };

  const ordered = [...appointments].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  for (const appointment of ordered) {
    if (SKIPPED.has(appointment.status) || registered.has(appointment.id)) continue;

    const startsAt = new Date(appointment.startsAt);
    const endsAt = new Date(appointment.endsAt);
    if (appointment.status === 'IN_PROGRESS' || (startsAt <= now && now < endsAt)) {
      day.now.push(appointment);
    } else if (endsAt <= now) {
      day.overdue.push(appointment);
    } else {
      day.upcoming.push(appointment);
    }
  }

  day.pendingCount = day.now.length + day.overdue.length;
  return day;
}

/** «hace 40 min», «hace 2 h»: cuánto lleva una cita terminada sin declararse. */
export function since(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'ahora mismo';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `hace ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}

/** Hoy, de medianoche a medianoche, en la hora del dispositivo —la del salón—. */
export function todayRange(now = new Date()): { from: string; to: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}
