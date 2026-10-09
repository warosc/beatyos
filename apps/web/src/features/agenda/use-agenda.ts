'use client';
import { useQuery } from '@tanstack/react-query';
import { loadOptions } from '@/lib/pagination';
import { agendaGet } from './api';
import { addDays, DAY_MS, isoDay } from './time';
import type {
  Appointment,
  ChangeRequest,
  ChangeRequestStatus,
  Service,
  StylistShifts,
} from './types';

/** Todo lo de la agenda cuelga de esta clave: invalidarla refresca citas, turnos y avisos. */
export const AGENDA_KEY = ['agenda'] as const;
export const PENDING_CHANGES_KEY = ['agenda', 'pending-changes'] as const;

/**
 * Citas y jornadas de un rango de días.
 *
 * La API limita el calendario a 31 días: un mes con sus semanas de borde son 42, así que se
 * pide en tramos y se juntan. La vuelta a pedir cada minuto es la red de seguridad del canal
 * en vivo: si un aviso se pierde, el dato llega igual, solo que un poco más tarde.
 */
export function useAgendaRange(from: Date, days: number, enabled = true) {
  const to = addDays(from, days);
  const calendar = useQuery({
    queryKey: [...AGENDA_KEY, 'calendar', from.toISOString(), to.toISOString()],
    enabled,
    refetchInterval: 60_000,
    queryFn: async () => {
      const chunks: Promise<Appointment[]>[] = [];
      for (let start = from.getTime(); start < to.getTime(); start += 30 * DAY_MS) {
        const end = Math.min(start + 30 * DAY_MS, to.getTime());
        chunks.push(
          agendaGet<Appointment[]>('calendar', {
            from: new Date(start).toISOString(),
            to: new Date(end).toISOString(),
          }),
        );
      }
      const all = (await Promise.all(chunks)).flat();
      return Array.from(new Map(all.map((item) => [item.id, item])).values());
    },
  });
  const shifts = useQuery({
    queryKey: [...AGENDA_KEY, 'shifts', isoDay(from), days],
    enabled,
    refetchInterval: 5 * 60_000,
    queryFn: () =>
      agendaGet<StylistShifts[]>('shifts', {
        from: isoDay(from),
        to: isoDay(addDays(from, days - 1)),
      }),
  });
  return { calendar, shifts };
}

export function useServiceCatalog(enabled = true) {
  return useQuery({
    queryKey: ['services'],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: ({ signal }) => loadOptions<Service>('/api/agenda?resource=services', signal),
  });
}

export function useChangeRequests(status: ChangeRequestStatus | 'ALL', enabled = true) {
  return useQuery({
    queryKey: [...AGENDA_KEY, 'change-requests', status],
    enabled,
    queryFn: () =>
      agendaGet<ChangeRequest[]>('change-requests', status === 'ALL' ? {} : { status }),
  });
}

/** Cambios esperando respuesta. Alimenta el aviso del menú de quien aprueba. */
export function usePendingChanges(enabled: boolean) {
  return useQuery({
    queryKey: PENDING_CHANGES_KEY,
    enabled,
    refetchInterval: 60_000,
    queryFn: () =>
      agendaGet<{ count?: number } | null>('pending-changes').then((body) => body?.count ?? 0),
  });
}
