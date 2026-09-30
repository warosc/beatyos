import { describe, expect, it } from 'vitest';
import {
  changeCents,
  paymentProblem,
  quickTenders,
  remainingCents,
  toPayments,
  type PaymentRow,
} from './payment';

const row = (overrides: Partial<PaymentRow>): PaymentRow => ({
  id: 'r',
  method: 'CASH',
  amountCents: 0,
  tenderedCents: null,
  reference: '',
  ...overrides,
});

describe('cobro', () => {
  it('calcula el vuelto sin enviarlo al servidor', () => {
    const efectivo = row({ amountCents: 13_750, tenderedCents: 20_000 });
    expect(changeCents(efectivo)).toBe(6_250);
    expect(toPayments([efectivo])).toEqual([{ method: 'CASH', amount: 137.5 }]);
  });

  it('propone el importe exacto y los billetes siguientes', () => {
    expect(quickTenders(13_750)).toEqual([13_750, 15_000, 20_000, 50_000]);
    expect(quickTenders(10_000)).toEqual([10_000, 20_000, 50_000]);
  });

  it('exige que el pago dividido cuadre al céntimo', () => {
    const rows = [row({ amountCents: 10_000 }), row({ method: 'CARD', amountCents: 3_749 })];
    expect(remainingCents(13_750, rows)).toBe(1);
    expect(paymentProblem(13_750, rows, true)).toMatch(/Faltan 0.01/);
    rows[1].amountCents = 3_750;
    expect(paymentProblem(13_750, rows, true)).toBeNull();
  });

  it('bloquea el efectivo con la caja cerrada y deja decidir al servidor si no se sabe', () => {
    const rows = [row({ amountCents: 5_000 })];
    expect(paymentProblem(5_000, rows, false)).toMatch(/caja está cerrada/);
    expect(paymentProblem(5_000, rows, null)).toBeNull();
    expect(paymentProblem(5_000, [row({ method: 'CARD', amountCents: 5_000 })], false)).toBeNull();
  });

  it('avisa si lo recibido no alcanza', () => {
    const rows = [row({ amountCents: 5_000, tenderedCents: 2_000 })];
    expect(paymentProblem(5_000, rows, true)).toMatch(/no alcanza/);
  });

  it('envía la referencia de tarjeta o transferencia solo si se escribió', () => {
    expect(
      toPayments([
        row({ method: 'CARD', amountCents: 100, reference: ' 4242 ' }),
        row({ method: 'TRANSFER', amountCents: 200 }),
      ]),
    ).toEqual([
      { method: 'CARD', amount: 1, reference: '4242' },
      { method: 'TRANSFER', amount: 2 },
    ]);
  });
});
