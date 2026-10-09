/**
 * Aritmética de fechas de la agenda.
 *
 * Todo en la hora del navegador, que en un salón es la del salón: la agenda se abre en el
 * mostrador y en los teléfonos del equipo, no desde otro huso. Sin librería de fechas: lo
 * que hace falta —inicio del día, sumar días, minutos desde medianoche— cabe aquí y se
 * prueba entero.
 */

export const DAY_MS = 86_400_000;

export const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

export const addDays = (date: Date, days: number) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

/** `YYYY-MM-DD` del día local. Es el formato que esperan los turnos y la disponibilidad. */
export const isoDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export const parseIsoDay = (value: string) => {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
};

export const sameDay = (a: Date, b: Date) => isoDay(a) === isoDay(b);

/** Lunes de la semana del día: en un salón la semana empieza el lunes. */
export const startOfWeek = (date: Date) => addDays(startOfDay(date), -((date.getDay() + 6) % 7));

/** Minutos desde la medianoche local de `day` hasta `instant`. Puede ser negativo o >1440. */
export const minutesInDay = (instant: Date | string, day: Date) =>
  Math.round((new Date(instant).getTime() - startOfDay(day).getTime()) / 60_000);

/** Instante del día local a esos minutos desde medianoche. */
export const atMinutes = (day: Date, minutes: number) =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);

export const snap = (minutes: number, step = 15) => Math.round(minutes / step) * step;

export const time = (iso: string | Date) =>
  new Date(iso).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' });

/**
 * Hora corta para los bloques de la parrilla, `3:30` en lugar de `03:30 p. m.`: en una
 * columna estrecha el sufijo parte la línea, y la propia parrilla ya dice si es mañana o tarde.
 */
export const shortTime = (iso: string | Date) => {
  const date = new Date(iso);
  return `${((date.getHours() + 11) % 12) + 1}:${String(date.getMinutes()).padStart(2, '0')}`;
};

/** Duración legible: «45 min», «1 h», «1 h 30 min». */
export const formatDuration = (minutes: number) =>
  minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;

/** Sin tildes ni mayúsculas, para buscar: «depilacion» encuentra «Depilación». */
export const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

export const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

export const hourLabel = (minutes: number) => {
  const hour = Math.floor(minutes / 60);
  const suffix = hour < 12 ? 'a. m.' : 'p. m.';
  return `${((hour + 11) % 12) + 1} ${suffix}`;
};

export const dayLabel = (date: Date, options: Intl.DateTimeFormatOptions = {}) =>
  date.toLocaleDateString('es-GT', { weekday: 'long', day: 'numeric', month: 'long', ...options });

/**
 * Rango de horas que pinta la parrilla: desde la primera hora en que alguien trabaja o tiene
 * cita hasta la última, redondeado a horas enteras y con un mínimo de 8:00 a 19:00.
 *
 * Un salón que abre a las 9 no necesita ver la madrugada, y uno que tiene una novia a las
 * 7:00 tiene que verla aunque ese día abra a las 9.
 */
export function visibleHours(
  ranges: readonly { start: number; end: number }[],
  fallback = { start: 8 * 60, end: 19 * 60 },
): { start: number; end: number } {
  if (!ranges.length) return fallback;
  const start = Math.min(fallback.start, ...ranges.map((range) => range.start));
  const end = Math.max(fallback.end, ...ranges.map((range) => range.end));
  return {
    start: Math.max(0, Math.floor(start / 60) * 60),
    end: Math.min(24 * 60, Math.ceil(end / 60) * 60),
  };
}

/**
 * Reparte citas que se solapan en carriles, para pintarlas lado a lado.
 *
 * Una profesional no puede tener dos citas a la vez, pero la vista de semana con todo el
 * equipo sí las junta en una columna. Cada cita recibe su carril y cuántos carriles tiene
 * su grupo de solapes, que es lo que fija su ancho.
 */
export function layoutLanes<T extends { startsAt: string; endsAt: string }>(
  items: readonly T[],
): { item: T; lane: number; lanes: number }[] {
  const sorted = [...items].sort(
    (a, b) => a.startsAt.localeCompare(b.startsAt) || b.endsAt.localeCompare(a.endsAt),
  );
  const result: { item: T; lane: number; lanes: number }[] = [];
  let group: { item: T; lane: number; lanes: number }[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -Infinity;

  const close = () => {
    const lanes = laneEnds.length;
    for (const entry of group) entry.lanes = lanes;
    result.push(...group);
    group = [];
    laneEnds = [];
  };

  for (const item of sorted) {
    const start = new Date(item.startsAt).getTime();
    const end = new Date(item.endsAt).getTime();
    if (group.length && start >= groupEnd) {
      close();
      groupEnd = -Infinity;
    }
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    group.push({ item, lane, lanes: 0 });
    groupEnd = Math.max(groupEnd, end);
  }
  if (group.length) close();
  return result;
}
