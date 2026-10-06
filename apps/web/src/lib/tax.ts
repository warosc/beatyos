/** IVA de Guatemala: el que la API aplica a un servicio si no se indica otro. */
export const IVA_RATE = 12;

/** Impuesto de una base en centavos, con el mismo redondeo que la API (mitad hacia arriba). */
const taxOf = (baseCents: number, rate: number) => Math.round((baseCents * rate) / 100);

export interface PriceSplit {
  /** Precio sin IVA, que es el que guarda la API. */
  readonly base: number;
  readonly tax: number;
  /** Lo que de verdad pagará la clienta. */
  readonly total: number;
}

/**
 * Reparte lo que paga la clienta en precio sin IVA más IVA, todo en centavos.
 *
 * La API guarda el precio sin IVA y calcula el impuesto encima, así que no todos los totales
 * se pueden alcanzar exactos: con el 12 %, Q100 sí (89.29 + 10.71), pero Q45.50 no. En ese
 * caso se elige el total más cercano y, si empatan, el menor: mejor cobrar un centavo menos
 * de lo que dijo la dueña que uno más. `total` dice siempre el importe real.
 */
export function splitPriceWithTax(totalCents: number, rate = IVA_RATE): PriceSplit {
  const guess = Math.round(totalCents / (1 + rate / 100));
  const candidates = [guess - 1, guess, guess + 1]
    .filter((base) => base > 0)
    .map((base) => ({ base, tax: taxOf(base, rate), total: base + taxOf(base, rate) }));
  return candidates.reduce((best, candidate) => {
    const gap = Math.abs(candidate.total - totalCents);
    const bestGap = Math.abs(best.total - totalCents);
    return gap < bestGap || (gap === bestGap && candidate.total < best.total) ? candidate : best;
  });
}

/** Comisión en centavos: se calcula sobre el precio sin IVA, igual que en la API. */
export const commissionOf = (baseCents: number, percent: number) =>
  Math.round((baseCents * percent) / 100);
