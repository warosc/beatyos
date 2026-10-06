import { describe, expect, it } from 'vitest';
import { commissionOf, splitPriceWithTax } from './tax';

describe('precio con IVA', () => {
  it('reparte un precio redondo en base más IVA exactos', () => {
    expect(splitPriceWithTax(10_000)).toEqual({ base: 8_929, tax: 1_071, total: 10_000 });
  });

  it('alcanza exacto cualquier precio en quetzales enteros', () => {
    for (let quetzales = 1; quetzales <= 3_000; quetzales++) {
      expect(splitPriceWithTax(quetzales * 100).total).toBe(quetzales * 100);
    }
  });

  it('si el total no se puede alcanzar, dice el real y no cobra de más', () => {
    // Q45.50 no tiene base que dé exacto con el 12 %: 40.62 da 45.49 y 40.63 da 45.51.
    const split = splitPriceWithTax(4_550);

    expect(split.total).toBe(4_549);
    expect(split.base + split.tax).toBe(split.total);
  });

  it('calcula la comisión sobre el precio sin IVA', () => {
    expect(commissionOf(8_929, 40)).toBe(3_572);
  });
});
