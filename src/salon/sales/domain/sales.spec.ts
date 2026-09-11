import {
  BusinessRuleViolationError,
  DomainValidationError,
  InvalidStateTransitionError,
} from '../../../shared/domain/errors';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import { Percentage } from '../../../shared/domain/value-objects/time-range.vo';
import { buildInvoiceLine, Invoice, type InvoiceLine } from './invoice.entity';
import { Payment } from './payment.entity';

const TENANT = '11111111-1111-7111-8111-111111111111';
const NOW = new Date('2026-09-03T10:00:00.000Z');
const gtq = (amount: string) => Money.fromDecimal(amount, 'GTQ');

let sequence = 0;
const nextId = () => `line-${(sequence += 1)}`;

const aLine = (overrides: Partial<Parameters<typeof buildInvoiceLine>[0]> = {}): InvoiceLine =>
  buildInvoiceLine({
    id: nextId(),
    kind: 'SERVICE',
    description: 'Corte de pelo',
    quantity: 1,
    unitPrice: gtq('100.00'),
    taxRate: Percentage.create(12),
    ...overrides,
  });

const anInvoice = (lines: InvoiceLine[] = [aLine()]) =>
  Invoice.issue({
    id: 'invoice-1',
    tenantId: TENANT,
    number: 'F-2026-000001',
    lines,
    currency: 'GTQ',
    now: NOW,
    actorId: 'user-1',
  });

beforeEach(() => {
  sequence = 0;
});

describe('buildInvoiceLine', () => {
  it('aplica el IVA sobre la base', () => {
    const line = aLine({ unitPrice: gtq('100.00'), taxRate: Percentage.create(12) });

    expect(line.lineSubtotal.toDecimalString()).toBe('100.00');
    expect(line.taxAmount.toDecimalString()).toBe('12.00');
    expect(line.lineTotal.toDecimalString()).toBe('112.00');
  });

  it('descuenta antes de aplicar el impuesto', () => {
    // Aplicar el IVA antes del descuento haría pagar impuesto sobre dinero que el cliente
    // no desembolsa: 100 − 20 = 80, y el 12 % de 80 son 9,60.
    const line = aLine({ unitPrice: gtq('100.00'), discountAmount: gtq('20.00') });

    expect(line.lineSubtotal.toDecimalString()).toBe('80.00');
    expect(line.taxAmount.toDecimalString()).toBe('9.60');
    expect(line.lineTotal.toDecimalString()).toBe('89.60');
  });

  it('multiplica por la cantidad antes de descontar', () => {
    const line = aLine({ quantity: 3, unitPrice: gtq('25.00'), discountAmount: gtq('5.00') });

    expect(line.lineSubtotal.toDecimalString()).toBe('70.00');
  });

  it('rechaza un descuento mayor que la línea', () => {
    expect(() => aLine({ unitPrice: gtq('50.00'), discountAmount: gtq('60.00') })).toThrow(
      BusinessRuleViolationError,
    );
  });

  it('rechaza cantidad no positiva', () => {
    expect(() => aLine({ quantity: 0 })).toThrow(DomainValidationError);
  });

  it('calcula la comisión sobre la base, no sobre el total con impuesto', () => {
    // El IVA no es ingreso del salón: es dinero recaudado para Hacienda, y pagar comisión
    // sobre él sería pagar por recaudar. El 20 % de 100 son 20, no el 20 % de 112.
    const line = aLine({ unitPrice: gtq('100.00'), commissionRate: Percentage.create(20) });

    expect(line.commissionAmount.toDecimalString()).toBe('20.00');
  });

  it('no devenga comisión si el servicio no la tiene fijada', () => {
    expect(aLine().commissionAmount.toDecimalString()).toBe('0.00');
  });
});

describe('Invoice', () => {
  describe('emisión', () => {
    it('nace emitida y sin cobrar', () => {
      const invoice = anInvoice();

      expect(invoice.status).toBe('ISSUED');
      expect(invoice.paidTotal.toDecimalString()).toBe('0.00');
      expect(invoice.balanceDue.toDecimalString()).toBe('112.00');
    });

    it('rechaza una factura sin líneas', () => {
      expect(() => anInvoice([])).toThrow(DomainValidationError);
    });

    it('rechaza mezclar monedas en un mismo documento', () => {
      // Convertir por nuestra cuenta aplicaría un tipo de cambio que nadie ha elegido.
      const enDolares = aLine({ unitPrice: Money.fromDecimal('100.00', 'USD') });

      expect(() => anInvoice([aLine(), enDolares])).toThrow(/está en USD y la factura en GTQ/);
    });

    it('ordena las líneas por su posición', () => {
      const segunda = aLine({ description: 'Segunda', sortOrder: 2 });
      const primera = aLine({ description: 'Primera', sortOrder: 1 });

      expect(anInvoice([segunda, primera]).lines.map((l) => l.description)).toEqual([
        'Primera',
        'Segunda',
      ]);
    });
  });

  describe('totales', () => {
    it('suma los totales de línea en lugar de agregar base e impuesto', () => {
      // Con varios tipos de IVA, redondear el impuesto sobre la base agregada puede dar un
      // céntimo distinto que redondearlo línea a línea. Lo que el cliente ve desglosado son
      // las líneas, así que el total tiene que casar con ellas.
      const invoice = anInvoice([
        aLine({ unitPrice: gtq('33.33'), taxRate: Percentage.create(12) }),
        aLine({ unitPrice: gtq('33.33'), taxRate: Percentage.create(12) }),
        aLine({ unitPrice: gtq('33.34'), taxRate: Percentage.create(12) }),
      ]);

      const sumaDeLineas = invoice.lines.reduce(
        (total, line) => total.add(line.lineTotal),
        gtq('0.00'),
      );

      expect(invoice.total.equals(sumaDeLineas)).toBe(true);
    });

    it('acumula el descuento de todas las líneas', () => {
      const invoice = anInvoice([
        aLine({ unitPrice: gtq('100.00'), discountAmount: gtq('10.00') }),
        aLine({ unitPrice: gtq('50.00'), discountAmount: gtq('5.00') }),
      ]);

      expect(invoice.discountTotal.toDecimalString()).toBe('15.00');
      expect(invoice.subtotal.toDecimalString()).toBe('135.00');
    });

    it('acumula las comisiones devengadas', () => {
      const invoice = anInvoice([
        aLine({ unitPrice: gtq('100.00'), commissionRate: Percentage.create(20) }),
        aLine({ unitPrice: gtq('50.00'), commissionRate: Percentage.create(10) }),
      ]);

      expect(invoice.commissionTotal.toDecimalString()).toBe('25.00');
    });

    it('distingue las líneas de producto, que son las que mueven existencias', () => {
      const invoice = anInvoice([
        aLine({ kind: 'PRODUCT', productId: 'p-1' }),
        aLine({ kind: 'SERVICE', serviceId: 's-1' }),
      ]);

      expect(invoice.productLines).toHaveLength(1);
    });
  });

  describe('cobro', () => {
    it('queda pagada al cubrir el total exactamente', () => {
      const invoice = anInvoice();
      invoice.registerPayment(gtq('112.00'), NOW, 'user-1');

      expect(invoice.status).toBe('PAID');
      expect(invoice.paidAt).toEqual(NOW);
      expect(invoice.balanceDue.isZero()).toBe(true);
    });

    it('queda a medias con un cobro parcial', () => {
      const invoice = anInvoice();
      invoice.registerPayment(gtq('50.00'), NOW, 'user-1');

      expect(invoice.status).toBe('PARTIALLY_PAID');
      expect(invoice.balanceDue.toDecimalString()).toBe('62.00');
      expect(invoice.paidAt).toBeNull();
    });

    it('acumula varios cobros hasta saldar', () => {
      const invoice = anInvoice();
      invoice.registerPayment(gtq('50.00'), NOW, 'user-1');
      invoice.registerPayment(gtq('62.00'), NOW, 'user-1');

      expect(invoice.status).toBe('PAID');
    });

    it('rechaza el sobrepago', () => {
      // Un cobro de más es casi siempre un error de tecleo. Admitirlo convertiría la
      // factura en un vale a favor del cliente que nadie ha decidido emitir.
      const invoice = anInvoice();

      expect(() => invoice.registerPayment(gtq('200.00'), NOW, 'user-1')).toThrow(
        BusinessRuleViolationError,
      );
      expect(invoice.paidTotal.isZero()).toBe(true);
    });

    it('rechaza un cobro en otra moneda', () => {
      expect(() =>
        anInvoice().registerPayment(Money.fromDecimal('112.00', 'USD'), NOW, 'user-1'),
      ).toThrow(DomainValidationError);
    });

    it('rechaza cobrar una factura ya saldada', () => {
      const invoice = anInvoice();
      invoice.registerPayment(gtq('112.00'), NOW, 'user-1');

      expect(() => invoice.registerPayment(gtq('1.00'), NOW, 'user-1')).toThrow(
        InvalidStateTransitionError,
      );
    });
  });

  describe('anulación', () => {
    it('anula una factura sin cobros', () => {
      const invoice = anInvoice();
      invoice.void('Cobrada a la clienta equivocada', NOW, 'user-1');

      expect(invoice.status).toBe('VOID');
      expect(invoice.voidReason).toBe('Cobrada a la clienta equivocada');
    });

    it('impide anular una factura con cobros', () => {
      // Anularla dejando los cobros en pie descuadraría la caja del día, y el arqueo de esa
      // noche no cerraría sin que nadie supiera por qué.
      const invoice = anInvoice();
      invoice.registerPayment(gtq('50.00'), NOW, 'user-1');

      expect(() => invoice.void('Error', NOW, 'user-1')).toThrow(/Devuelva el importe/);
    });

    it('exige un motivo', () => {
      expect(() => anInvoice().void('   ', NOW, 'user-1')).toThrow(DomainValidationError);
    });

    it('no anula dos veces', () => {
      const invoice = anInvoice();
      invoice.void('Error', NOW, 'user-1');

      expect(() => invoice.void('Otra vez', NOW, 'user-1')).toThrow(InvalidStateTransitionError);
    });
  });

  describe('vencimiento', () => {
    const conVencimiento = (dueAt: Date) =>
      Invoice.issue({
        id: 'invoice-2',
        tenantId: TENANT,
        number: 'F-2026-000002',
        lines: [aLine()],
        currency: 'GTQ',
        dueAt,
        now: NOW,
        actorId: 'user-1',
      });

    it('marca vencida la que pasó su fecha', () => {
      const invoice = conVencimiento(new Date('2026-08-01T00:00:00.000Z'));
      invoice.markOverdue(NOW);

      expect(invoice.status).toBe('OVERDUE');
    });

    it('no toca la que aún está en plazo', () => {
      const invoice = conVencimiento(new Date('2026-12-01T00:00:00.000Z'));
      invoice.markOverdue(NOW);

      expect(invoice.status).toBe('ISSUED');
    });

    it('no toca una factura ya pagada', () => {
      const invoice = conVencimiento(new Date('2026-08-01T00:00:00.000Z'));
      invoice.registerPayment(gtq('112.00'), NOW, 'user-1');
      invoice.markOverdue(NOW);

      expect(invoice.status).toBe('PAID');
    });
  });
});

describe('Payment', () => {
  const aPayment = (overrides: Partial<Parameters<typeof Payment.receive>[0]> = {}) =>
    Payment.receive({
      id: 'payment-1',
      tenantId: TENANT,
      invoiceId: 'invoice-1',
      method: 'CARD',
      amount: gtq('112.00'),
      now: NOW,
      actorId: 'user-1',
      ...overrides,
    });

  it('exige caja abierta para el efectivo', () => {
    // Sin sesión, el dinero entra en el sistema y no aparece en ningún arqueo: el descuadre
    // de esa noche sería inexplicable porque el cobro existe y el cajón no sabe de él.
    expect(() => aPayment({ method: 'CASH' })).toThrow(/caja abierta/);
  });

  it('acepta el efectivo con una sesión asignada', () => {
    expect(aPayment({ method: 'CASH', sessionId: 'session-1' }).isCash).toBe(true);
  });

  it('no exige caja para los cobros que no son en efectivo', () => {
    expect(aPayment({ method: 'TRANSFER' }).sessionId).toBeNull();
  });

  it('rechaza un importe no positivo', () => {
    expect(() => aPayment({ amount: gtq('0.00') })).toThrow(DomainValidationError);
  });

  describe('devolución', () => {
    it('admite una devolución parcial', () => {
      const payment = aPayment();
      payment.refund(gtq('30.00'), 'Devuelve un producto', NOW);

      expect(payment.status).toBe('PARTIALLY_REFUNDED');
      expect(payment.netAmount.toDecimalString()).toBe('82.00');
    });

    it('marca devuelto del todo al cubrir el importe', () => {
      const payment = aPayment();
      payment.refund(gtq('112.00'), 'Anulación', NOW);

      expect(payment.status).toBe('REFUNDED');
      expect(payment.netAmount.isZero()).toBe(true);
    });

    it('acumula devoluciones sucesivas', () => {
      const payment = aPayment();
      payment.refund(gtq('50.00'), 'Primera', NOW);
      payment.refund(gtq('62.00'), 'Segunda', NOW);

      expect(payment.status).toBe('REFUNDED');
    });

    it('rechaza devolver más de lo cobrado', () => {
      const payment = aPayment();

      expect(() => payment.refund(gtq('200.00'), 'Error', NOW)).toThrow(BusinessRuleViolationError);
    });

    it('exige un motivo', () => {
      expect(() => aPayment().refund(gtq('10.00'), '  ', NOW)).toThrow(DomainValidationError);
    });

    it('no devuelve dos veces lo ya devuelto entero', () => {
      const payment = aPayment();
      payment.refund(gtq('112.00'), 'Anulación', NOW);

      expect(() => payment.refund(gtq('1.00'), 'Otra vez', NOW)).toThrow(
        /ya se ha devuelto por completo/,
      );
    });
  });
});
