/** IVA de Guatemala: el que la API aplica a un servicio o producto si no se indica otro. */
export const IVA_RATE = 12;

/**
 * IVA que va dentro de un precio, en centavos (ADR-0021).
 *
 * Los precios ya llevan el IVA: lo que escribe la dueña es lo que paga la clienta, al
 * centavo. El impuesto solo se separa como dato interno, con el mismo redondeo que la API
 * (`Money.includedTax`): la base se redondea mitad hacia arriba y el IVA es lo que falta.
 */
export const includedTax = (totalCents: number, rate: number = IVA_RATE) =>
  totalCents - Math.round((totalCents * 100) / (100 + rate));

/** Comisión en centavos: se calcula sobre el precio sin IVA, igual que en la API. */
export const commissionOf = (baseCents: number, percent: number) =>
  Math.round((baseCents * percent) / 100);
