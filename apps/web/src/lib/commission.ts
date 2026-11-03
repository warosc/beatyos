/**
 * Comisión en centavos: un porcentaje de lo que paga la clienta, igual que en la API
 * (ADR-0026). Si paga Q30 y la comisión es del 20 %, son Q6.00. El salón no cobra IVA,
 * así que no hay nada que descontar antes.
 */
export const commissionOf = (totalCents: number, percent: number) =>
  Math.round((totalCents * percent) / 100);
