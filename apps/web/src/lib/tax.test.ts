import { describe, expect, it } from 'vitest';
import { commissionOf, includedTax } from './tax';

describe('IVA incluido en el precio', () => {
  it('separa el IVA de un precio redondo', () => {
    // Q100 son 89,29 para el salón y 10,71 de IVA.
    expect(includedTax(10_000)).toBe(1_071);
    expect(includedTax(11_200)).toBe(1_200);
  });

  it('cualquier precio se cobra exacto: el IVA sale de dentro, no se suma', () => {
    // Con el IVA sumado encima, Q45.50 no se podía cobrar; ahora es 40,63 + 4,87.
    expect(includedTax(4_550)).toBe(487);
  });

  it('usa el IVA de cada artículo', () => {
    expect(includedTax(3_025, 21)).toBe(525);
    expect(includedTax(5_000, 0)).toBe(0);
  });

  it('calcula la comisión sobre el precio sin IVA', () => {
    expect(commissionOf(8_929, 40)).toBe(3_572);
  });
});
