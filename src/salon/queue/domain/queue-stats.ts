import { DomainValidationError } from '../../../shared/domain/errors';
import {
  addCalendarDays,
  formatCalendarDay,
  minutesFromMidnightInZone,
  parseCalendarDay,
  type CalendarDay,
} from '../../../shared/domain/time/zoned-time';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import type { QueueTurnStatusValue } from './queue-turn.entity';

/**
 * Indicadores de la fila de espera (ADR-0025).
 *
 * Funciones puras, como los informes (ADR-0015): entran los turnos del periodo, salen las
 * cifras. Responden a lo que la propietaria necesita decidir —cuánto esperan, cuántas se
 * van, a qué horas y qué días hace falta más gente, quién atiende y cuánto deja la clienta
 * sin cita—, y se prueban con datos escritos a mano.
 *
 * Las horas y los días son del salón, no de UTC: una clienta que llega a las 18:30 en
 * Guatemala llega «por la tarde», aunque en UTC ya sea el día siguiente.
 */

/** Un turno, reducido a lo que los indicadores usan. */
export interface QueueTurnFact {
  readonly businessDate: string;
  readonly status: QueueTurnStatusValue;
  readonly createdAt: Date;
  readonly firstCalledAt: Date | null;
  readonly startedAt: Date | null;
  readonly closedAt: Date | null;
  readonly stylistId: string | null;
  readonly preferredStylistId: string | null;
  readonly serviceIds: readonly string[];
  /** Lo cobrado por su comanda. `null` si no se atendió o todavía no se cobró. */
  readonly charged: Money | null;
}

/** Días del salón, ambos incluidos. */
export interface QueuePeriod {
  readonly from: string;
  readonly to: string;
}

export interface MinutesSummary {
  readonly average: number | null;
  readonly median: number | null;
  /** Nueve de cada diez esperaron esto o menos. */
  readonly p90: number | null;
  readonly max: number | null;
  readonly samples: number;
}

export interface HourStat {
  /** Hora local de llegada, 0–23. */
  readonly hour: number;
  readonly arrivals: number;
  readonly abandoned: number;
  readonly averageWait: number | null;
}

export interface WeekdayStat {
  /** 0 = domingo. */
  readonly weekday: number;
  readonly arrivals: number;
  /** Llegadas por cada día de ese tipo que tuvo el periodo: compara lunes con sábados. */
  readonly arrivalsPerDay: number;
  readonly averageWait: number | null;
}

export interface DayStat {
  readonly date: string;
  readonly arrivals: number;
  readonly attended: number;
  readonly abandoned: number;
  readonly averageWait: number | null;
}

export interface StylistStat {
  readonly stylistId: string;
  readonly attended: number;
  /** Cuántas la pidieron por su nombre al llegar. */
  readonly requested: number;
  readonly averageService: number | null;
}

export interface ServiceDemand {
  readonly serviceId: string;
  readonly requests: number;
}

/**
 * Conclusiones listas para leer. Llevan los datos, no el texto: la pantalla las redacta.
 * Solo aparecen cuando hay muestras suficientes para que no sean una anécdota.
 */
export type QueueInsight =
  | { readonly kind: 'peak-hour'; readonly hour: number; readonly arrivals: number }
  | { readonly kind: 'slowest-hour'; readonly hour: number; readonly averageWait: number }
  | { readonly kind: 'leave-after'; readonly minutes: number; readonly samples: number }
  | { readonly kind: 'busiest-weekday'; readonly weekday: number; readonly arrivalsPerDay: number }
  | { readonly kind: 'most-requested'; readonly stylistId: string; readonly requested: number };

export interface QueueStats {
  readonly period: QueuePeriod;
  readonly arrivals: number;
  readonly attended: number;
  /** Se fueron, o recepción las sacó de la fila. */
  readonly left: number;
  /** La llamaron y no apareció. */
  readonly noShow: number;
  /** Seguían en la fila cuando terminó su día. */
  readonly unattended: number;
  /** Hoy, todavía esperando o en atención: no cuentan ni como atendidas ni como perdidas. */
  readonly pending: number;
  readonly abandoned: number;
  /** Perdidas sobre las que ya se resolvieron, en %. `null` sin ninguna resuelta. */
  readonly abandonmentRate: number | null;
  /** De la llegada a la primera llamada. */
  readonly wait: MinutesSummary;
  /** Cuánto aguantaron las que se fueron sin que nadie las llamara. */
  readonly waitBeforeLeaving: MinutesSummary;
  /** Del sillón al final, de las atendidas. */
  readonly service: MinutesSummary;
  readonly revenue: Money;
  readonly chargedTurns: number;
  readonly byHour: readonly HourStat[];
  readonly byWeekday: readonly WeekdayStat[];
  readonly byDay: readonly DayStat[];
  readonly byStylist: readonly StylistStat[];
  readonly byService: readonly ServiceDemand[];
  readonly insights: readonly QueueInsight[];
}

/** Por debajo de esto, una media es una anécdota y no se saca conclusión. */
export const MIN_SAMPLES = 3;
const MAX_PERIOD_DAYS = 366;

const CLOSED_LOST: ReadonlySet<QueueTurnStatusValue> = new Set(['CANCELLED', 'NO_SHOW']);
const OPEN: ReadonlySet<QueueTurnStatusValue> = new Set(['WAITING', 'CALLED', 'IN_SERVICE']);

// ---------------------------------------------------------------------------

/**
 * Periodo de los indicadores, en días del salón. Por defecto, los últimos `fallbackDays`
 * hasta hoy incluido. Con el mismo tope de un año que los informes.
 */
export function resolveQueuePeriod(params: {
  from?: string | null;
  to?: string | null;
  today: string;
  fallbackDays: number;
}): QueuePeriod {
  const to = parseCalendarDay(params.to ?? params.today);
  const from = params.from
    ? parseCalendarDay(params.from)
    : addCalendarDays(to, -(params.fallbackDays - 1));

  const span = daysBetween(from, to);
  if (span < 0) {
    throw new DomainValidationError('La fecha inicial debe ser anterior a la final', 'period');
  }
  if (span + 1 > MAX_PERIOD_DAYS) {
    throw new DomainValidationError(`El periodo máximo es de ${MAX_PERIOD_DAYS} días`, 'period');
  }
  return { from: formatCalendarDay(from), to: formatCalendarDay(to) };
}

/** Minutos de espera de un turno ya llamado. `null` si nadie la llamó todavía. */
export const waitMinutes = (turn: Pick<QueueTurnFact, 'createdAt' | 'firstCalledAt'>) =>
  turn.firstCalledAt ? minutesBetween(turn.createdAt, turn.firstCalledAt) : null;

/** Resumen de una lista de minutos: media, mediana, p90 y máximo, redondeados al minuto. */
export function summarizeMinutes(values: readonly number[]): MinutesSummary {
  if (values.length === 0) {
    return { average: null, median: null, p90: null, max: null, samples: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  // Percentil por rango más cercano: siempre es una espera que de verdad ocurrió.
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return {
    average: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    median: Math.round(percentile(0.5)),
    p90: Math.round(percentile(0.9)),
    max: Math.round(sorted.at(-1)!),
    samples: sorted.length,
  };
}

export function summarizeQueue(
  facts: readonly QueueTurnFact[],
  options: { period: QueuePeriod; today: string; timeZone: string; currency: string },
): QueueStats {
  const { period, today, timeZone, currency } = options;
  const inPeriod = facts.filter(
    (turn) => turn.businessDate >= period.from && turn.businessDate <= period.to,
  );

  const outcome = (turn: QueueTurnFact) => {
    if (turn.status === 'DONE') return 'attended' as const;
    if (turn.status === 'CANCELLED') return 'left' as const;
    if (turn.status === 'NO_SHOW') return 'noShow' as const;
    // Sigue abierto: si su día ya pasó, se quedó sin atender; si es de hoy, aún se resuelve.
    return turn.businessDate < today ? ('unattended' as const) : ('pending' as const);
  };
  const isLost = (turn: QueueTurnFact) =>
    CLOSED_LOST.has(turn.status) || (OPEN.has(turn.status) && turn.businessDate < today);

  const count = (kind: ReturnType<typeof outcome>) =>
    inPeriod.filter((turn) => outcome(turn) === kind).length;
  const attended = count('attended');
  const left = count('left');
  const noShow = count('noShow');
  const unattended = count('unattended');
  const pending = count('pending');
  const abandoned = left + noShow + unattended;
  const resolved = inPeriod.length - pending;

  const waits = inPeriod.map(waitMinutes).filter((value): value is number => value !== null);
  const leaving = inPeriod
    .filter((turn) => turn.status === 'CANCELLED' && !turn.firstCalledAt && turn.closedAt)
    .map((turn) => minutesBetween(turn.createdAt, turn.closedAt!));
  const services = inPeriod
    .filter((turn) => turn.status === 'DONE' && turn.startedAt && turn.closedAt)
    .map((turn) => minutesBetween(turn.startedAt!, turn.closedAt!));
  const charged = inPeriod
    .map((turn) => turn.charged)
    .filter((money): money is Money => money !== null);

  const byHour = hourStats(inPeriod, timeZone, isLost);
  const byWeekday = weekdayStats(inPeriod, period);
  const byStylist = stylistStats(inPeriod);
  const leaveSummary = summarizeMinutes(leaving);

  return {
    period,
    arrivals: inPeriod.length,
    attended,
    left,
    noShow,
    unattended,
    pending,
    abandoned,
    abandonmentRate: resolved > 0 ? Math.round((abandoned / resolved) * 1000) / 10 : null,
    wait: summarizeMinutes(waits),
    waitBeforeLeaving: leaveSummary,
    service: summarizeMinutes(services),
    revenue: Money.sum(charged, currency),
    chargedTurns: charged.length,
    byHour,
    byWeekday,
    byDay: dayStats(inPeriod, period, isLost),
    byStylist,
    byService: serviceDemand(inPeriod),
    insights: insightsFrom({ byHour, byWeekday, byStylist, leaveSummary }),
  };
}

// ---------------------------------------------------------------------------

function hourStats(
  turns: readonly QueueTurnFact[],
  timeZone: string,
  isLost: (turn: QueueTurnFact) => boolean,
): HourStat[] {
  if (turns.length === 0) return [];
  const hourOf = (turn: QueueTurnFact) =>
    Math.floor(minutesFromMidnightInZone(turn.createdAt, timeZone) / 60);
  const hours = turns.map(hourOf);
  const first = Math.min(...hours);
  const last = Math.max(...hours);

  // Tramo continuo entre la primera y la última hora con llegadas: una hora sin nadie
  // también es un dato, y un hueco en el gráfico lo escondería.
  return Array.from({ length: last - first + 1 }, (_, index) => {
    const hour = first + index;
    const group = turns.filter((_, position) => hours[position] === hour);
    return {
      hour,
      arrivals: group.length,
      abandoned: group.filter(isLost).length,
      averageWait: averageWaitOf(group),
    };
  });
}

function weekdayStats(turns: readonly QueueTurnFact[], period: QueuePeriod): WeekdayStat[] {
  const days = periodDays(period);
  return Array.from({ length: 7 }, (_, weekday) => {
    const group = turns.filter((turn) => weekdayOf(turn.businessDate) === weekday);
    const occurrences = days.filter((date) => weekdayOf(date) === weekday).length;
    return {
      weekday,
      arrivals: group.length,
      arrivalsPerDay: occurrences ? Math.round((group.length / occurrences) * 10) / 10 : 0,
      averageWait: averageWaitOf(group),
    };
  });
}

function dayStats(
  turns: readonly QueueTurnFact[],
  period: QueuePeriod,
  isLost: (turn: QueueTurnFact) => boolean,
): DayStat[] {
  return periodDays(period).map((date) => {
    const group = turns.filter((turn) => turn.businessDate === date);
    return {
      date,
      arrivals: group.length,
      attended: group.filter((turn) => turn.status === 'DONE').length,
      abandoned: group.filter(isLost).length,
      averageWait: averageWaitOf(group),
    };
  });
}

function stylistStats(turns: readonly QueueTurnFact[]): StylistStat[] {
  const ids = new Set(
    turns.flatMap((turn) =>
      [turn.status === 'DONE' ? turn.stylistId : null, turn.preferredStylistId].filter(
        (id): id is string => !!id,
      ),
    ),
  );
  return [...ids]
    .map((stylistId) => {
      const done = turns.filter((turn) => turn.status === 'DONE' && turn.stylistId === stylistId);
      const services = done
        .filter((turn) => turn.startedAt && turn.closedAt)
        .map((turn) => minutesBetween(turn.startedAt!, turn.closedAt!));
      return {
        stylistId,
        attended: done.length,
        requested: turns.filter((turn) => turn.preferredStylistId === stylistId).length,
        averageService: summarizeMinutes(services).average,
      };
    })
    .sort((a, b) => b.attended - a.attended || b.requested - a.requested);
}

function serviceDemand(turns: readonly QueueTurnFact[]): ServiceDemand[] {
  const counts = new Map<string, number>();
  for (const serviceId of turns.flatMap((turn) => turn.serviceIds)) {
    counts.set(serviceId, (counts.get(serviceId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([serviceId, requests]) => ({ serviceId, requests }))
    .sort((a, b) => b.requests - a.requests);
}

function insightsFrom(stats: {
  byHour: readonly HourStat[];
  byWeekday: readonly WeekdayStat[];
  byStylist: readonly StylistStat[];
  leaveSummary: MinutesSummary;
}): QueueInsight[] {
  const insights: QueueInsight[] = [];

  const peak = maxBy(stats.byHour, (hour) => hour.arrivals);
  if (peak && peak.arrivals >= MIN_SAMPLES) {
    insights.push({ kind: 'peak-hour', hour: peak.hour, arrivals: peak.arrivals });
  }

  const slowest = maxBy(
    stats.byHour.filter((hour) => hour.averageWait !== null && hour.arrivals >= MIN_SAMPLES),
    (hour) => hour.averageWait!,
  );
  if (slowest) {
    insights.push({ kind: 'slowest-hour', hour: slowest.hour, averageWait: slowest.averageWait! });
  }

  if (stats.leaveSummary.samples >= MIN_SAMPLES) {
    insights.push({
      kind: 'leave-after',
      minutes: stats.leaveSummary.median!,
      samples: stats.leaveSummary.samples,
    });
  }

  const busiest = maxBy(stats.byWeekday, (day) => day.arrivalsPerDay);
  if (busiest && busiest.arrivals >= MIN_SAMPLES) {
    insights.push({
      kind: 'busiest-weekday',
      weekday: busiest.weekday,
      arrivalsPerDay: busiest.arrivalsPerDay,
    });
  }

  const requested = maxBy(stats.byStylist, (stylist) => stylist.requested);
  if (requested && requested.requested >= MIN_SAMPLES) {
    insights.push({
      kind: 'most-requested',
      stylistId: requested.stylistId,
      requested: requested.requested,
    });
  }

  return insights;
}

// ---------------------------------------------------------------------------

const minutesBetween = (from: Date, to: Date) =>
  Math.max(0, (to.getTime() - from.getTime()) / 60_000);

const averageWaitOf = (turns: readonly QueueTurnFact[]) =>
  summarizeMinutes(turns.map(waitMinutes).filter((value): value is number => value !== null))
    .average;

/** El primero con el valor más alto; ante un empate, el que aparece antes. */
const maxBy = <T>(items: readonly T[], value: (item: T) => number): T | undefined =>
  items.reduce<T | undefined>(
    (best, item) => (best === undefined || value(item) > value(best) ? item : best),
    undefined,
  );

const toUtcMs = (day: CalendarDay) => Date.UTC(day.year, day.month - 1, day.day);

const daysBetween = (from: CalendarDay, to: CalendarDay) =>
  Math.round((toUtcMs(to) - toUtcMs(from)) / 86_400_000);

/** Día de la semana de una fecha pura. Sin zona: el día del salón ya es local. */
const weekdayOf = (date: string) => new Date(toUtcMs(parseCalendarDay(date))).getUTCDay();

function periodDays(period: QueuePeriod): string[] {
  const from = parseCalendarDay(period.from);
  const length = daysBetween(from, parseCalendarDay(period.to)) + 1;
  return Array.from({ length }, (_, index) => formatCalendarDay(addCalendarDays(from, index)));
}
