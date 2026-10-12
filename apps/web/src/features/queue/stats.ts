import { problem } from '@/features/service-tickets/types';
import { sessionFetch } from '@/lib/session-fetch';
import { minutesLabel } from './types';

export interface MinutesSummary {
  average: number | null;
  median: number | null;
  p90: number | null;
  max: number | null;
  samples: number;
}

export type QueueInsight =
  | { kind: 'peak-hour'; hour: number; arrivals: number }
  | { kind: 'slowest-hour'; hour: number; averageWait: number }
  | { kind: 'leave-after'; minutes: number; samples: number }
  | { kind: 'busiest-weekday'; weekday: number; arrivalsPerDay: number }
  | { kind: 'most-requested'; stylistId: string; stylistName: string; requested: number };

/** Indicadores de la fila (ADR-0025), tal como los da `GET /queue/stats`. */
export interface QueueStats {
  from: string;
  to: string;
  arrivals: number;
  attended: number;
  left: number;
  noShow: number;
  unattended: number;
  pending: number;
  abandoned: number;
  abandonmentRate: number | null;
  wait: MinutesSummary;
  waitBeforeLeaving: MinutesSummary;
  service: MinutesSummary;
  revenue: string;
  currency: string;
  chargedTurns: number;
  byHour: { hour: number; arrivals: number; abandoned: number; averageWait: number | null }[];
  byWeekday: {
    weekday: number;
    arrivals: number;
    arrivalsPerDay: number;
    averageWait: number | null;
  }[];
  byDay: {
    date: string;
    arrivals: number;
    attended: number;
    abandoned: number;
    averageWait: number | null;
  }[];
  byStylist: {
    stylistId: string;
    name: string;
    attended: number;
    requested: number;
    averageService: number | null;
  }[];
  byService: { serviceId: string; name: string; requests: number }[];
  insights: QueueInsight[];
}

export async function fetchQueueStats(from: string, to: string): Promise<QueueStats> {
  const query = new URLSearchParams({ from, to });
  const response = await sessionFetch(`/api/queue/stats?${query}`);
  if (!response.ok) throw new Error(await problem(response, 'No pudimos cargar las cifras.'));
  return ((await response.json()) as { data: QueueStats }).data;
}

export const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** «9 a. m.», «4 p. m.»: como se dice la hora en el salón. */
export function hourLabel(hour: number): string {
  const suffix = hour < 12 ? 'a. m.' : 'p. m.';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${suffix}`;
}

/** La hora partida en número y sufijo, para el eje de un gráfico estrecho. */
export const hourParts = (hour: number) => {
  const [number = '', ...suffix] = hourLabel(hour).split(' ');
  return { number, suffix: suffix.join(' ') };
};

/** Tramo de una hora: «de 4 a 5 p. m.». */
export const hourRange = (hour: number) =>
  `de ${hourLabel(hour).replace(/ [ap]\. m\.$/, '')} a ${hourLabel((hour + 1) % 24)}`;

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Lo que la propietaria lee primero: cada conclusión en una frase, con la decisión que
 * sugiere. Los datos vienen calculados y con muestras suficientes; aquí solo se redactan.
 */
export function insightText(insight: QueueInsight): { title: string; hint: string } {
  switch (insight.kind) {
    case 'peak-hour':
      return {
        title: `La hora con más llegadas es ${hourRange(insight.hour)}`,
        hint: `Llegaron ${insight.arrivals} sin cita en ese tramo. Es la hora en que más falta hace tener a alguien libre para la fila.`,
      };
    case 'slowest-hour':
      return {
        title: `${capitalize(hourRange(insight.hour))} se espera más: ${minutesLabel(insight.averageWait)} de media`,
        hint: 'Si en ese tramo hay citas que ocupan a todo el equipo, conviene reservar un hueco para la fila.',
      };
    case 'leave-after':
      return {
        title: `Las que se van aguantan unos ${minutesLabel(insight.minutes)}`,
        hint: `Es la mitad de las ${insight.samples} que se fueron sin que las llamaran. Pasado ese tiempo, avisar o asignar a otra profesional evita perderlas.`,
      };
    case 'busiest-weekday':
      return {
        title: `El ${WEEKDAYS[insight.weekday]} llegan más clientas sin cita`,
        hint: `${insight.arrivalsPerDay.toLocaleString('es-GT')} de media ese día. Buen día para reforzar el equipo.`,
      };
    case 'most-requested':
      return {
        title: `A ${insight.stylistName} la piden por su nombre`,
        hint: `${insight.requested} clientas la pidieron al llegar. Su agenda es la que más clientela atrae de la fila.`,
      };
  }
}
