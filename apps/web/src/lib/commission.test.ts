import { describe, expect, it } from 'vitest';
import { commissionOf } from './commission';

describe('comisión', () => {
  it('es un porcentaje de lo que paga la clienta', () => {
    // Q30 al 20 %: Q6.00, sin descontar IVA.
    expect(commissionOf(3_000, 20)).toBe(600);
  });

  it('redondea al centavo', () => {
    // 15 % de Q30.25 son 4,5375: Q4.54.
    expect(commissionOf(3_025, 15)).toBe(454);
  });

  it('sin porcentaje no hay comisión', () => {
    expect(commissionOf(10_000, 0)).toBe(0);
  });
});
