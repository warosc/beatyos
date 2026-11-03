import { Money } from '../../../shared/domain/value-objects/money.vo';
import { commissionPayouts } from './commission-payout';
import type { StylistSalesTotals } from './sales.repositories';

const gtq = (amount: string) => Money.fromDecimal(amount, 'GTQ');

const row = (overrides: Partial<StylistSalesTotals> = {}): StylistSalesTotals => ({
  stylistId: 's-1',
  kind: 'SERVICE',
  quantity: 1,
  sold: gtq('30.00'),
  commission: gtq('6.00'),
  ...overrides,
});

describe('commissionPayouts', () => {
  it('separa servicios y productos y suma lo que hay que entregarle', () => {
    const [sara] = commissionPayouts(
      [
        row({ quantity: 3, sold: gtq('90.00'), commission: gtq('18.00') }),
        row({ kind: 'PRODUCT', quantity: 1, sold: gtq('50.00'), commission: gtq('5.00') }),
      ],
      new Map([['s-1', 'Sara']]),
      'GTQ',
    );

    expect(sara.stylistName).toBe('Sara');
    expect(sara.services.count).toBe(3);
    expect(sara.services.sold.toDecimalString()).toBe('90.00');
    expect(sara.services.commission.toDecimalString()).toBe('18.00');
    expect(sara.products.count).toBe(1);
    expect(sara.products.commission.toDecimalString()).toBe('5.00');
    expect(sara.total.toDecimalString()).toBe('23.00');
  });

  it('deja a cero el tipo que no vendió', () => {
    const [sara] = commissionPayouts([row()], new Map([['s-1', 'Sara']]), 'GTQ');

    expect(sara.products.count).toBe(0);
    expect(sara.products.commission.toDecimalString()).toBe('0.00');
    expect(sara.total.toDecimalString()).toBe('6.00');
  });

  it('ordena por nombre y no pierde a nadie sin nombre resuelto', () => {
    const payouts = commissionPayouts(
      [row({ stylistId: 's-2' }), row({ stylistId: 's-1' }), row({ stylistId: 's-3' })],
      new Map([
        ['s-1', 'Zoe'],
        ['s-2', 'Ana'],
      ]),
      'GTQ',
    );

    expect(payouts.map((p) => p.stylistName)).toEqual(['Ana', 'Profesional', 'Zoe']);
  });

  it('sin ventas con profesional no hay nada que pagar', () => {
    expect(commissionPayouts([], new Map(), 'GTQ')).toEqual([]);
  });
});
