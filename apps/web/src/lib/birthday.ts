/**
 * Cumpleaños de una clienta como lo guarda la API: `MM-DD`, sin año (ADR-0022).
 *
 * El salón la felicita; no necesita saber su edad, y preguntar el año incomoda.
 */
export const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const;

/** Febrero admite el 29: hay quien cumple en año bisiesto. */
export const daysInMonth = (month: number) =>
  [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 31;

/** `04-17` → «17 de abril». */
export function formatBirthday(value: string | null | undefined): string | null {
  const match = value ? /^(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) return null;
  const month = Number(match[1]);
  return `${Number(match[2])} de ${MONTHS[month - 1]}`;
}

/** Día y mes elegidos por separado → `MM-DD`, o `null` si falta alguno. */
export const toBirthday = (day: string, month: string): string | null =>
  day && month ? `${month.padStart(2, '0')}-${day.padStart(2, '0')}` : null;

/** `MM-DD` → día y mes por separado, para los selectores del formulario. */
export function splitBirthday(value: string | null | undefined): { day: string; month: string } {
  const match = value ? /^(\d{2})-(\d{2})$/.exec(value) : null;
  return match
    ? { day: String(Number(match[2])), month: String(Number(match[1])) }
    : { day: '', month: '' };
}
