'use client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { Appointment } from '@/features/agenda/types';
import type { ServiceTicket } from '@/features/service-tickets/types';
import { loadPage } from '@/lib/pagination';
import { sessionFetch } from '@/lib/session-fetch';
import { classifyDay, todayRange } from './day';

export const MY_DAY_KEY = ['my-day'] as const;

/**
 * Citas y comandas de hoy de la profesional, clasificadas por la hora.
 *
 * Lo usan la pantalla «Mi día» y el aviso del menú con la misma caché. El reloj avanza cada
 * minuto: es lo que hace que una cita pase sola a «atendiendo ahora» sin recargar nada.
 */
export function useMyDay(enabled = true) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  // Solo cambia al cambiar de día: si no, cada minuto sería una consulta nueva.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `now` cambia cada minuto; el rango, una vez al día
  const range = useMemo(() => todayRange(now), [dayKey]);
  const query = `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;

  const appointments = useQuery({
    queryKey: [...MY_DAY_KEY, 'appointments', range.from],
    enabled,
    refetchInterval: 60_000,
    queryFn: async () => {
      const response = await sessionFetch(`/api/agenda?resource=calendar&${query}`);
      if (!response.ok) throw new Error('No se pudo cargar tu agenda de hoy.');
      return ((await response.json()) as { data: Appointment[] }).data;
    },
  });
  const tickets = useQuery({
    queryKey: [...MY_DAY_KEY, 'tickets', range.from],
    enabled,
    // Así la profesional ve pasar a «Cobrado» lo que caja va cobrando.
    refetchInterval: 30_000,
    queryFn: ({ signal }) =>
      loadPage<ServiceTicket>(
        `/api/service-tickets?limit=100&sort=createdAt:desc&${query}`,
        signal,
      ).then((page) => page.data),
  });

  const day = useMemo(
    () => classifyDay(appointments.data ?? [], tickets.data ?? [], now),
    [appointments.data, tickets.data, now],
  );

  return { now, appointments, tickets, day };
}
