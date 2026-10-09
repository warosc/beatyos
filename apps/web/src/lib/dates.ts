const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Fecha `AAAA-MM-DD` en la hora del navegador, que es la del salón.
 *
 * No sirve `toISOString().slice(0, 10)`: esa es la fecha en UTC, y en Guatemala (UTC−6) a
 * partir de las 18:00 ya es «mañana». El panel del día mostraba entonces Q0 y ninguna cita.
 */
export const localDay = (date: Date = new Date()) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** Un día completo en la hora del navegador, que es la del salón. */
export function dayRange(day: string): { from: Date; to: Date } {
  const [year, month, date] = day.split('-').map(Number);
  return {
    from: new Date(year, month - 1, date, 0, 0, 0, 0),
    to: new Date(year, month - 1, date, 23, 59, 59, 999),
  };
}
