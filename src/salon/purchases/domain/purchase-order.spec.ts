import {
  BusinessRuleViolationError,
  DomainValidationError,
  EntityNotFoundError,
} from '../../../shared/domain/errors';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import { Percentage } from '../../../shared/domain/value-objects/time-range.vo';
import {
  buildPurchaseOrderLine,
  PurchaseOrder,
  type PurchaseOrderLine,
  type PurchaseOrderStatusValue,
} from './purchase-order.entity';
import { Quantity } from './quantity.vo';

const NOW = new Date('2026-09-07T10:00:00.000Z');
const TENANT = '11111111-1111-7111-8111-111111111111';
const gtq = (amount: string | number) => Money.fromDecimal(amount, 'GTQ');
const q = (value: string | number) => Quantity.fromDecimal(value);

let sequence = 0;
const line = (params: {
  quantity: string | number;
  unitCost: string | number;
  taxRate?: number;
  received?: string | number;
}): PurchaseOrderLine =>
  buildPurchaseOrderLine({
    id: `line-${++sequence}`,
    productId: `product-${sequence}`,
    quantity: q(params.quantity),
    unitCost: gtq(params.unitCost),
    taxRate: Percentage.create(params.taxRate ?? 12),
    receivedQuantity: params.received === undefined ? undefined : q(params.received),
    now: NOW,
  });

const order = (lines: PurchaseOrderLine[], status?: PurchaseOrderStatusValue): PurchaseOrder => {
  const draft = PurchaseOrder.open({
    id: 'order-1',
    tenantId: TENANT,
    supplierId: 'supplier-1',
    number: 'OC-2026-000001',
    currency: 'GTQ',
    lines,
    now: NOW,
    actorId: 'actor-1',
  });

  if (!status || status === 'DRAFT') return draft;

  // Se rehidrata para colocarlo en el estado deseado: las transiciones las escribe el
  // repositorio con un `UPDATE` condicional, no el agregado.
  return PurchaseOrder.rehydrate('order-1', {
    tenantId: TENANT,
    supplierId: 'supplier-1',
    number: 'OC-2026-000001',
    status,
    orderedAt: NOW,
    expectedAt: null,
    receivedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    supplierReference: null,
    notes: null,
    lines,
    subtotal: draft.subtotal,
    taxTotal: draft.taxTotal,
    total: draft.total,
    currency: 'GTQ',
    audit: draft.audit,
  });
};

beforeEach(() => {
  sequence = 0;
});

describe('Pedido de compra', () => {
  // =========================================================================
  describe('aritmética del documento', () => {
    it('calcula la línea aplicando el impuesto sobre la base', () => {
      const only = line({ quantity: 3, unitCost: '10.10', taxRate: 12 });
      expect(only.lineSubtotal.toDecimalString()).toBe('30.30');
      expect(only.lineTotal.toDecimalString()).toBe('33.94');
    });

    /**
     * El caso que la implementación anterior fallaba: `2,5 × 4,05` da `10,125`, que
     * redondeado half-up es `10,13`. Multiplicando con `number` y guardando con
     * `.toFixed(2)` salía `11,34` en el total de línea y el subtotal del pedido se
     * truncaba a `40,42`.
     */
    it('redondea half-up una línea fraccionaria, sin arrastrar coma flotante', () => {
      const fraccion = line({ quantity: 2.5, unitCost: '4.05', taxRate: 12 });
      expect(fraccion.lineSubtotal.toDecimalString()).toBe('10.13');
      expect(fraccion.lineTotal.toDecimalString()).toBe('11.35');
    });

    it('suma el documento a partir de los totales de línea', () => {
      const documento = order([
        line({ quantity: 3, unitCost: '10.10', taxRate: 12 }),
        line({ quantity: 2.5, unitCost: '4.05', taxRate: 12 }),
      ]);

      expect(documento.subtotal.toDecimalString()).toBe('40.43');
      expect(documento.taxTotal.toDecimalString()).toBe('4.86');
      expect(documento.total.toDecimalString()).toBe('45.29');
    });

    it('mantiene la identidad subtotal + impuestos = total', () => {
      const documento = order(
        Array.from({ length: 7 }, () => line({ quantity: 1.333, unitCost: '3.33' })),
      );
      expect(documento.subtotal.add(documento.taxTotal).equals(documento.total)).toBe(true);
    });

    it('respeta un tipo impositivo exento', () => {
      const documento = order([line({ quantity: 1, unitCost: '100.00', taxRate: 0 })]);
      expect(documento.taxTotal.toDecimalString()).toBe('0.00');
      expect(documento.total.toDecimalString()).toBe('100.00');
    });

    it('respeta un tipo reducido distinto del general', () => {
      const documento = order([line({ quantity: 2, unitCost: '50.00', taxRate: 5 })]);
      expect(documento.taxTotal.toDecimalString()).toBe('5.00');
      expect(documento.total.toDecimalString()).toBe('105.00');
    });
  });

  // =========================================================================
  describe('reglas de composición', () => {
    it('no admite un pedido sin líneas', () => {
      expect(() => order([])).toThrow(BusinessRuleViolationError);
      expect(() => order([])).toThrow('al menos una línea');
    });

    it('rechaza una cantidad que no es positiva', () => {
      expect(() => line({ quantity: 0, unitCost: '5.00' })).toThrow(DomainValidationError);
    });

    it('rechaza un coste unitario negativo', () => {
      expect(() => line({ quantity: 1, unitCost: '-1.00' })).toThrow(DomainValidationError);
    });

    it('no mezcla monedas en un mismo documento', () => {
      const extranjera = buildPurchaseOrderLine({
        id: 'line-x',
        productId: 'product-x',
        quantity: q(1),
        unitCost: Money.fromDecimal('10.00', 'USD'),
        taxRate: Percentage.zero(),
        now: NOW,
      });

      expect(() => order([extranjera])).toThrow(DomainValidationError);
    });
  });

  // =========================================================================
  describe('transiciones de estado', () => {
    it('deja enviar un borrador', () => {
      expect(() =>
        order([line({ quantity: 1, unitCost: '5.00' })]).assertCanSubmit(),
      ).not.toThrow();
    });

    it.each<PurchaseOrderStatusValue>(['SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'])(
      'no deja enviar un pedido en %s',
      (status) => {
        const documento = order([line({ quantity: 1, unitCost: '5.00' })], status);
        expect(() => documento.assertCanSubmit()).toThrow(BusinessRuleViolationError);
        expect(() => documento.assertCanSubmit()).toThrow('borrador');
      },
    );

    it.each<PurchaseOrderStatusValue>(['DRAFT', 'SUBMITTED', 'PARTIALLY_RECEIVED'])(
      'deja cancelar un pedido en %s',
      (status) => {
        expect(() =>
          order([line({ quantity: 1, unitCost: '5.00' })], status).assertCanCancel(),
        ).not.toThrow();
      },
    );

    it.each<PurchaseOrderStatusValue>(['RECEIVED', 'CANCELLED'])(
      'no deja cancelar un pedido en %s',
      (status) => {
        const documento = order([line({ quantity: 1, unitCost: '5.00' })], status);
        expect(() => documento.assertCanCancel()).toThrow(BusinessRuleViolationError);
      },
    );

    it.each<PurchaseOrderStatusValue>(['SUBMITTED', 'PARTIALLY_RECEIVED'])(
      'admite recepción en %s',
      (status) => {
        expect(() =>
          order([line({ quantity: 1, unitCost: '5.00' })], status).assertReceivable(),
        ).not.toThrow();
      },
    );

    it.each<PurchaseOrderStatusValue>(['DRAFT', 'RECEIVED', 'CANCELLED'])(
      'no admite recepción en %s',
      (status) => {
        const documento = order([line({ quantity: 1, unitCost: '5.00' })], status);
        expect(() => documento.assertReceivable()).toThrow(BusinessRuleViolationError);
        expect(() => documento.assertReceivable()).toThrow('no está disponible para recepción');
      },
    );
  });

  // =========================================================================
  describe('recepción de mercancía', () => {
    it('acepta una entrega parcial y deja el resto pendiente', () => {
      const only = line({ quantity: 10, unitCost: '5.00' });
      const documento = order([only], 'SUBMITTED');

      expect(() => documento.planReceipt(only.id, q(4))).not.toThrow();
      documento.applyReceipt(only.id, q(4), NOW, 'actor-1');

      expect(documento.isFullyReceived).toBe(false);
      expect(documento.statusAfterReceipt()).toBe('PARTIALLY_RECEIVED');
      expect(documento.pendingOf(documento.lines[0]).toDecimalString()).toBe('6.000');
    });

    it('cierra el pedido cuando se completa la última unidad', () => {
      const only = line({ quantity: 10, unitCost: '5.00' });
      const documento = order([only], 'SUBMITTED');

      documento.applyReceipt(only.id, q(6), NOW, 'actor-1');
      documento.applyReceipt(only.id, q(4), NOW, 'actor-1');

      expect(documento.isFullyReceived).toBe(true);
      expect(documento.statusAfterReceipt()).toBe('RECEIVED');
    });

    /** El fallo que motivó `Quantity`: `0,3 − 0,1` no llega a `0,2` en coma flotante. */
    it('admite completar una cantidad fraccionaria pendiente', () => {
      const only = line({ quantity: 0.3, unitCost: '12.00' });
      const documento = order([only], 'SUBMITTED');

      documento.applyReceipt(only.id, q(0.1), NOW, 'actor-1');
      expect(() => documento.planReceipt(only.id, q(0.2))).not.toThrow();

      documento.applyReceipt(only.id, q(0.2), NOW, 'actor-1');
      expect(documento.isFullyReceived).toBe(true);
    });

    it('rechaza recibir más de lo pendiente', () => {
      const only = line({ quantity: 2, unitCost: '5.00' });
      const documento = order([only], 'SUBMITTED');

      expect(() => documento.planReceipt(only.id, q(3))).toThrow(BusinessRuleViolationError);
      expect(() => documento.planReceipt(only.id, q(3))).toThrow('supera el pendiente');
    });

    it('rechaza recibir más de lo que queda tras una entrega previa', () => {
      const only = line({ quantity: 10, unitCost: '5.00' });
      const documento = order([only], 'SUBMITTED');
      documento.applyReceipt(only.id, q(7), NOW, 'actor-1');

      expect(() => documento.planReceipt(only.id, q(4))).toThrow('supera el pendiente');
      expect(() => documento.planReceipt(only.id, q(3))).not.toThrow();
    });

    it('rechaza una entrega de cero o negativa', () => {
      const only = line({ quantity: 2, unitCost: '5.00' });
      const documento = order([only], 'SUBMITTED');

      expect(() => documento.planReceipt(only.id, q(0))).toThrow(BusinessRuleViolationError);
      expect(() => documento.planReceipt(only.id, q(1).subtract(q(2)))).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('no encuentra una línea que no es del pedido', () => {
      const documento = order([line({ quantity: 2, unitCost: '5.00' })], 'SUBMITTED');
      expect(() => documento.planReceipt('line-de-otro', q(1))).toThrow(EntityNotFoundError);
    });

    it('sigue parcialmente recibido mientras quede otra línea pendiente', () => {
      const primera = line({ quantity: 1, unitCost: '5.00' });
      const segunda = line({ quantity: 4, unitCost: '2.00' });
      const documento = order([primera, segunda], 'SUBMITTED');

      documento.applyReceipt(primera.id, q(1), NOW, 'actor-1');

      expect(documento.isFullyReceived).toBe(false);
      expect(documento.statusAfterReceipt()).toBe('PARTIALLY_RECEIVED');
    });
  });
});
