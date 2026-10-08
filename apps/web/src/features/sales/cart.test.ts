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

// Precios con el IVA dentro (ADR-0021): 25,00 + 21 % y 18,50 + 12 %.
const corte: SaleItem = { kind: 'SERVICE', id: 's1', name: 'Corte', price: '30.25', taxRate: 21 };
const champu: SaleItem = {
  kind: 'PRODUCT',
  id: 'p1',
  name: 'Champú',
  price: '20.72',
  taxRate: '12.00',
  stockOnHand: '2',
  trackStock: true,
};

const build = (...steps: [SaleItem, string | null][]): CartLine[] =>
  steps.reduce<CartLine[]>((lines, [item, stylist]) => addItem(lines, item, stylist).lines, []);

describe('cuenta del punto de venta', () => {
  it('cobra el precio tal cual y separa el IVA como la factura del servidor', () => {
    // 20,72 lleva dentro 2,22 de IVA sobre una base de 18,50.
    expect(unitTotalCents(champu)).toBe(2072);
    const [line] = build([champu, null]);
    expect(lineAmounts(line)).toEqual({
      grossCents: 2072,
      discountCents: 0,
      netCents: 1850,
      taxCents: 222,
      totalCents: 2072,
    });
  });

  it('cobra exactamente cualquier precio, aunque no exista una base de dos decimales', () => {
    const [line] = build([{ ...champu, price: '45.50' }, null]);
    expect(lineAmounts(line)).toMatchObject({ totalCents: 4550, taxCents: 487, netCents: 4063 });
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

  it('un descuento en quetzales baja exactamente eso lo que paga la clienta', () => {
    const [line] = build([corte, null]);
    const [descontada] = setDiscount([line], line.key, 605);
    // 30,25 − 6,05 = 24,20, que lleva dentro 4,20 de IVA: el impuesto solo va sobre lo pagado.
    expect(lineAmounts(descontada)).toMatchObject({ totalCents: 2420, taxCents: 420 });
    expect(setDiscount([line], line.key, 99_999)[0].discountCents).toBe(3025);
    expect(discountFromPercent(2500, 10)).toBe(250);
  });

  it('totaliza y prepara el cuerpo de POST /sales', () => {
    const lines = setDiscount(build([corte, 'ana'], [champu, null]), 'SERVICE:s1:ana', 605);
    expect(cartTotals(lines)).toEqual({
      // Lo que se pagaría sin descuentos, con el IVA dentro.
      subtotalCents: 3025 + 2072,
      discountCents: 605,
      taxCents: 420 + 222,
      totalCents: 2420 + 2072,
    });
    expect(toSaleLines(lines)).toEqual([
      { kind: 'SERVICE', itemId: 's1', quantity: 1, stylistId: 'ana', discountAmount: 6.05 },
      { kind: 'PRODUCT', itemId: 'p1', quantity: 1 },
    ]);
  });
});
