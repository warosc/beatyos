import { DomainValidationError } from '../errors';

/**
 * Conversión entre la hora local de un salón y instantes absolutos.
 *
 * ── Por qué esto no es trivial ──────────────────────────────────────────────────────
 *
 * Un horario de trabajo se expresa en hora local —«de 9:00 a 18:00»— y no cambia nunca.
 * Una cita, en cambio, ocurre en un instante absoluto. Traducir de lo primero a lo
 * segundo exige conocer el desplazamiento horario **de ese día concreto**, y ese
 * desplazamiento cambia dos veces al año.
 *
 * El error clásico es `new Date(2026, 8, 10, 9, 0)`, que usa la zona horaria del
 * **servidor**. Un salón de Madrid gestionado desde un contenedor en UTC vería sus citas
 * desplazadas dos horas media parte del año, y una sola hora la otra mitad. Peor: el
 * fallo aparece y desaparece con el cambio de hora, que es la forma más incómoda de
 * descubrir un bug.
 *
 * Aquí la conversión es explícita y la zona horaria un parámetro obligatorio. No hay
 * ninguna función que use la hora del servidor.
 */

/** Minutos transcurridos desde la medianoche local. `540` es las 9:00. */
export type MinutesFromMidnight = number;

export const MINUTES_IN_DAY = 1440;

/** Margen para detectar un salto de horario de verano cerca del instante buscado. */
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/** Día del calendario en la zona del salón, sin hora ni desplazamiento asociados. */
export interface CalendarDay {
  readonly year: number;
  /** 1-12, como lo escribiría una persona. */
  readonly month: number;
  readonly day: number;
}

/**
 * Desplazamiento de una zona horaria en un instante dado, en milisegundos.
 *
 * Se obtiene formateando el instante en esa zona y comparándolo con el mismo reloj
 * interpretado como UTC. Es la única vía sin dependencias que respeta el histórico real
 * de cambios de hora de cada país, porque delega en la base de datos IANA del sistema.
 */
export function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const asIfUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    // Algunos entornos formatean la medianoche como «24» en lugar de «00».
    field('hour') % 24,
    field('minute'),
    field('second'),
  );

  return asIfUtc - instant.getTime();
}

/**
 * Convierte una hora local del salón en el instante absoluto correspondiente.
 *
 * La dificultad de fondo: **el desplazamiento horario depende del instante que se está
 * intentando calcular**. Es una circularidad que solo aparece los dos domingos del año en
 * que cambia la hora, y que se resuelve probando las dos interpretaciones posibles y
 * comprobando cuál de ellas vuelve a producir la hora local pedida.
 *
 * Casos límite de esos dos domingos:
 *
 * - **Hora inexistente** (marzo, 02:00→03:00): las 02:30 no ocurren. Se devuelve el
 *   instante en que el reloj salta, en lugar de fallar: para una agenda es preferible
 *   desplazar la cita treinta minutos que rechazar la reserva con un error que nadie
 *   sabría interpretar.
 * - **Hora ambigua** (octubre, 03:00→02:00): las 02:30 ocurren dos veces. Se elige la
 *   **primera**, que es la interpretación que espera cualquiera al mirar un calendario.
 */
export function zonedTimeToInstant(
  day: CalendarDay,
  minutesFromMidnight: MinutesFromMidnight,
  timeZone: string,
): Date {
  assertValidMinutes(minutesFromMidnight);

  const naiveUtc = Date.UTC(
    day.year,
    day.month - 1,
    day.day,
    Math.floor(minutesFromMidnight / 60),
    minutesFromMidnight % 60,
  );

  // Desplazamientos a ambos lados del instante buscado. Seis horas de margen cubren de
  // sobra cualquier salto de horario de verano, que nunca pasa de una hora.
  const offsetBefore = timeZoneOffsetMs(new Date(naiveUtc - SIX_HOURS_MS), timeZone);
  const offsetAfter = timeZoneOffsetMs(new Date(naiveUtc + SIX_HOURS_MS), timeZone);

  // Caso normal —364 días al año—: no hay cambio de hora cerca y la conversión es directa.
  if (offsetBefore === offsetAfter) {
    return new Date(naiveUtc - offsetBefore);
  }

  // Hay un salto cerca. Se prueban las dos interpretaciones y se comprueba cuál de ellas
  // **vuelve a dar la hora local pedida**: es la única forma de distinguir una hora
  // ambigua (ocurre dos veces) de una inexistente (no ocurre ninguna).
  const candidateBefore = naiveUtc - offsetBefore;
  const candidateAfter = naiveUtc - offsetAfter;

  const beforeIsReal = timeZoneOffsetMs(new Date(candidateBefore), timeZone) === offsetBefore;
  const afterIsReal = timeZoneOffsetMs(new Date(candidateAfter), timeZone) === offsetAfter;

  if (beforeIsReal && afterIsReal) {
    // Hora ambigua (octubre): las 02:30 ocurren dos veces. Se toma la primera, que es la
    // interpretación que espera cualquiera al mirar un calendario.
    return new Date(Math.min(candidateBefore, candidateAfter));
  }

  if (beforeIsReal) return new Date(candidateBefore);
  if (afterIsReal) return new Date(candidateAfter);

  // Hora inexistente (marzo): el reloj salta de 02:00 a 03:00 y las 02:30 no llegan a
  // existir. Se devuelve el instante posterior al salto —la cita se desplaza— en lugar
  // de rechazar la reserva con un error que nadie sabría interpretar.
  return new Date(Math.max(candidateBefore, candidateAfter));
}

/** Día del calendario en el que cae un instante, según la zona del salón. */
export function instantToCalendarDay(instant: Date, timeZone: string): CalendarDay {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  return { year: field('year'), month: field('month'), day: field('day') };
}

/**
 * Día de la semana local: 0 = domingo … 6 = sábado.
 *
 * Se calcula en la zona del salón, no en la del servidor. Una cita de las 00:30 del lunes
 * en Madrid ocurre el domingo en UTC, y usar el día equivocado haría que el horario del
 * lunes no se aplicara.
 */
export function dayOfWeekInZone(instant: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(instant);
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);

  if (index === -1) {
    throw new DomainValidationError(`No se pudo determinar el día de la semana en ${timeZone}`);
  }
  return index;
}

/** Minutos desde la medianoche local que corresponden a un instante. */
export function minutesFromMidnightInZone(instant: Date, timeZone: string): MinutesFromMidnight {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);

  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  return (field('hour') % 24) * 60 + field('minute');
}

/** Avanza `days` días de calendario. Opera sobre el calendario, no sobre milisegundos. */
export function addCalendarDays(day: CalendarDay, days: number): CalendarDay {
  // `Date.UTC` normaliza los desbordes de mes y año, incluidos los bisiestos. Sumar
  // 86 400 000 ms sobre un instante sería incorrecto: los días del cambio de hora tienen
  // 23 o 25 horas.
  const shifted = new Date(Date.UTC(day.year, day.month - 1, day.day + days));

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** `true` si los dos días son el mismo. */
export function isSameCalendarDay(a: CalendarDay, b: CalendarDay): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/** Formato ISO `YYYY-MM-DD`, que es como viajan las fechas puras por la API. */
export function formatCalendarDay(day: CalendarDay): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${day.year}-${pad(day.month)}-${pad(day.day)}`;
}

/** Interpreta `YYYY-MM-DD` como día de calendario, sin arrastrar zona horaria alguna. */
export function parseCalendarDay(value: string): CalendarDay {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new DomainValidationError(`Fecha no válida: "${value}". Se espera YYYY-MM-DD.`, 'date');
  }

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];

  // Se comprueba que la fecha exista de verdad: `2026-02-31` encaja con la expresión
  // regular pero no es un día, y `Date.UTC` lo convertiría en el 3 de marzo en silencio.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new DomainValidationError(`La fecha ${value} no existe en el calendario`, 'date');
  }

  return { year, month, day };
}

/** `true` si la zona horaria la reconoce el sistema. Se usa al dar de alta un salón. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function assertValidMinutes(minutes: MinutesFromMidnight): void {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MINUTES_IN_DAY) {
    throw new DomainValidationError(
      `Los minutos desde medianoche deben estar entre 0 y ${MINUTES_IN_DAY}, se recibió ${minutes}`,
      'minutes',
    );
  }
}

/** `540` → `"09:00"`. Para pintar horarios en la interfaz. */
export function formatMinutes(minutes: MinutesFromMidnight): string {
  assertValidMinutes(minutes);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** `"09:00"` → `540`. */
export function parseMinutes(value: string): MinutesFromMidnight {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new DomainValidationError(`Hora no válida: "${value}". Se espera HH:MM.`, 'time');
  }

  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (Number(match[2]) > 59) {
    throw new DomainValidationError(`Hora no válida: "${value}"`, 'time');
  }

  assertValidMinutes(minutes);
  return minutes;
}
