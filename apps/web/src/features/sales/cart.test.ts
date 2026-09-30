import { describe, expect, it } from 'vitest';
import {
  addItem,
  cartTotals,
  discountFromPercent,
  lineAmounts,
  setDiscount,
  setQuantity,
  setStylist,
  toSaleLines,
  unitTotalCents,
  type CartLine,
  type SaleItem,
} from './cart';

const corte: SaleItem = { kind: 'SERVICE', id: 's1', name: 'Corte', price: '25.00', taxRate: 21 };
const champu: SaleItem = {
  kind: 'PRODUCT',
  id: 'p1',
  name: 'Champú',
  price: '18.50',
  taxRate: '12.00',
  stockOnHand: '2',
  trackStock: true,
};

const build = (...steps: [SaleItem, string | null][]): CartLine[] =>
  steps.reduce<CartLine[]>((lines, [item, stylist]) => addItem(lines, item, stylist).lines, []);

describe('cuenta del punto de venta', () => {
  it('redondea como la factura del servidor: IVA sobre el neto, al céntimo', () => {
    // 18,50 × 12 % = 2,22 → 20,72. Es el caso de la prueba e2e de venta.
    expect(unitTotalCents(champu)).toBe(2072);
    const [line] = build([champu, null]);
    expect(lineAmounts(line)).toEqual({
      grossCents: 1850,
      discountCents: 0,
      netCents: 1850,
      taxCents: 222,
      totalCents: 2072,
    });
  });

  it('suma la misma línea en lugar de repetirla', () => {
    const lines = build([corte, 'ana'], [corte, 'ana']);
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(2);
  });

  it('separa el mismo servicio hecho por dos profesionales', () => {
    const lines = build([corte, 'ana'], [corte, 'eva']);
    expect(lines.map((line) => line.stylistId)).toEqual(['ana', 'eva']);
  });

  it('agrupa un producto aunque cambie quien atiende, como exige la API', () => {
    const lines = build([champu, 'ana'], [champu, 'eva']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ quantity: 2, stylistId: 'ana' });
  });

  it('no vende más existencias de las que hay', () => {
    const lines = build([champu, null], [champu, null]);
    const result = addItem(lines, champu, null);
    expect(result.error).toMatch(/No hay más existencias/);
    expect(result.lines[0].quantity).toBe(2);
  });

  it('acota la cantidad escrita: unidades en servicios, stock en productos', () => {
    const [servicio] = build([corte, null]);
    expect(setQuantity([servicio], servicio.key, 2.6).lines[0].quantity).toBe(3);
    expect(setQuantity([servicio], servicio.key, 0).lines[0].quantity).toBe(1);

    const [producto] = build([champu, null]);
    const tope = setQuantity([producto], producto.key, 5);
    expect(tope.lines[0].quantity).toBe(2);
    expect(tope.error).toMatch(/Solo quedan 2/);
  });

  it('funde dos líneas si se reasigna a la misma profesional', () => {
    const lines = build([corte, 'ana'], [corte, 'eva']);
    const merged = setStylist(lines, lines[1].key, 'ana');
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ stylistId: 'ana', quantity: 2 });
  });

  it('aplica el descuento antes del IVA y nunca por encima del bruto', () => {
    const [line] = build([corte, null]);
    const [descontada] = setDiscount([line], line.key, 500);
    // (25,00 − 5,00) × 1,21 = 24,20
    expect(lineAmounts(descontada).totalCents).toBe(2420);
    expect(setDiscount([line], line.key, 99_999)[0].discountCents).toBe(2500);
    expect(discountFromPercent(2500, 10)).toBe(250);
  });

  it('totaliza y prepara el cuerpo de POST /sales', () => {
    const lines = setDiscount(build([corte, 'ana'], [champu, null]), 'SERVICE:s1:ana', 500);
    expect(cartTotals(lines)).toEqual({
      subtotalCents: 4350,
      discountCents: 500,
      taxCents: 420 + 222,
      totalCents: 2420 + 2072,
    });
    expect(toSaleLines(lines)).toEqual([
      { kind: 'SERVICE', itemId: 's1', quantity: 1, stylistId: 'ana', discountAmount: 5 },
      { kind: 'PRODUCT', itemId: 'p1', quantity: 1 },
    ]);
  });
});
