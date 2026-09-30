/**
 * Cobro: lógica pura del diálogo de pago, compartida por Ventas y Caja.
 *
 * La API exige que los pagos sumen **exactamente** el total y no admite sobrepago: el
 * vuelto no viaja al servidor. Lo que la clienta entrega en efectivo se anota aquí solo
 * para calcular el cambio; al servidor se envía el importe que se queda el salón.
 */

export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER' | 'OTHER';

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: 'Efectivo',
  CARD: 'Tarjeta',
  TRANSFER: 'Transferencia',
  OTHER: 'Otro',
};

export const METHODS = Object.keys(METHOD_LABEL) as PaymentMethod[];

export interface PaymentRow {
  id: string;
  method: PaymentMethod;
  amountCents: number;
  /** Lo que entrega la clienta en efectivo. Solo sirve para calcular el vuelto. */
  tenderedCents: number | null;
  reference: string;
}

export const MAX_PAYMENTS = 10;

export const paidCents = (rows: readonly PaymentRow[]) =>
  rows.reduce((sum, row) => sum + row.amountCents, 0);

export const remainingCents = (totalCents: number, rows: readonly PaymentRow[]) =>
  totalCents - paidCents(rows);

export const changeCents = (row: PaymentRow): number =>
  row.method === 'CASH' && row.tenderedCents != null
    ? Math.max(0, row.tenderedCents - row.amountCents)
    : 0;

export const totalChangeCents = (rows: readonly PaymentRow[]) =>
  rows.reduce((sum, row) => sum + changeCents(row), 0);

/**
 * Billetes con los que es probable que paguen: el importe exacto y los siguientes
 * redondeos a 50, 100, 200 y 500 quetzales, sin repetir.
 */
export function quickTenders(amountCents: number): number[] {
  const steps = [5_000, 10_000, 20_000, 50_000];
  const rounded = steps.map((step) => Math.ceil(amountCents / step) * step);
  return [...new Set([amountCents, ...rounded.filter((value) => value > amountCents)])].slice(0, 4);
}

/**
 * Motivo por el que no se puede cobrar todavía, o `null` si el cobro es válido.
 * `cashOpen` es `null` cuando quien cobra no puede consultar la caja: decide el servidor.
 */
export function paymentProblem(
  totalCents: number,
  rows: readonly PaymentRow[],
  cashOpen: boolean | null,
): string | null {
  if (!rows.length) return 'Elige un método de pago.';
  if (rows.some((row) => row.amountCents <= 0)) {
    return 'Escribe cuánto se paga con cada método; ninguno puede quedar en cero.';
  }
  if (cashOpen === false && rows.some((row) => row.method === 'CASH')) {
    return 'La caja está cerrada: ábrela antes de cobrar en efectivo.';
  }
  const missing = remainingCents(totalCents, rows);
  if (missing > 0) return `Faltan ${(missing / 100).toFixed(2)} por cobrar.`;
  if (missing < 0) return `Los pagos superan el total en ${(-missing / 100).toFixed(2)}.`;
  const short = rows.find(
    (row) =>
      row.method === 'CASH' && row.tenderedCents != null && row.tenderedCents < row.amountCents,
  );
  if (short) {
    const missing = (short.amountCents - (short.tenderedCents ?? 0)) / 100;
    return `Lo recibido en efectivo no alcanza: faltan ${missing.toFixed(2)}.`;
  }
  return null;
}

/** Pagos tal como los espera la API. */
export const toPayments = (rows: readonly PaymentRow[]) =>
  rows.map((row) => ({
    method: row.method,
    amount: row.amountCents / 100,
    ...(row.reference.trim() ? { reference: row.reference.trim() } : {}),
  }));
