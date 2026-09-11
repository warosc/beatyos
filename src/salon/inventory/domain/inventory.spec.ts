import { BusinessRuleViolationError, DomainValidationError } from '@shared/domain/errors';
import { Money } from '@shared/domain/value-objects/money.vo';

import { Batch } from './batch.entity';
import { StockAllocationService } from './stock-allocation.service';

const NOW = new Date('2026-09-10T10:00:00.000Z');
const TENANT = '11111111-1111-7111-8111-111111111111';

const day = (isoDate: string): Date => new Date(`${isoDate}T00:00:00.000Z`);

let sequence = 0;

const batch = (params: {
  quantity: number;
  cost: string;
  expiresAt?: string | null;
  receivedAt?: string;
  number?: string;
}): Batch => {
  sequence += 1;
  return Batch.receive({
    id: `batch-${sequence}`,
    tenantId: TENANT,
    productId: 'product-1',
    batchNumber: params.number ?? `L${sequence}`,
    quantity: params.quantity,
    unitCost: Money.fromDecimal(params.cost, 'EUR'),
    expiresAt: params.expiresAt === null ? null : day(params.expiresAt ?? '2027-01-01'),
    now: params.receivedAt ? new Date(params.receivedAt) : NOW,
    actorId: 'encargada',
  });
};

describe('Batch', () => {
  describe('recepción', () => {
    it('nace con la cantidad completa disponible', () => {
      const lote = batch({ quantity: 20, cost: '7.20' });

      expect(lote.initialQuantity).toBe(20);
      expect(lote.remainingQuantity).toBe(20);
      expect(lote.consumedQuantity).toBe(0);
      expect(lote.isDepleted).toBe(false);
    });

    it('calcula el valor de sus existencias con el coste real', () => {
      const lote = batch({ quantity: 20, cost: '7.20' });
      expect(lote.remainingValue.toDecimalString()).toBe('144.00');
    });

    it('rechaza recibir mercancía ya caducada', () => {
      // O la fecha está mal tecleada, o el proveedor mandó producto inservible. En ambos
      // casos hay que pararlo en el muelle, no al intentar usarlo.
      expect(() => batch({ quantity: 10, cost: '5.00', expiresAt: '2026-01-01' })).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('admite lotes sin caducidad', () => {
      const lote = batch({ quantity: 10, cost: '5.00', expiresAt: null });

      expect(lote.expiresAt).toBeNull();
      expect(lote.isExpired(NOW)).toBe(false);
      expect(lote.daysUntilExpiry(NOW)).toBeNull();
    });

    it('exige número de lote, cantidad positiva y coste no negativo', () => {
      expect(() => batch({ quantity: 10, cost: '5.00', number: '  ' })).toThrow(
        DomainValidationError,
      );
      expect(() => batch({ quantity: 0, cost: '5.00' })).toThrow(DomainValidationError);
      expect(() => batch({ quantity: -1, cost: '5.00' })).toThrow(DomainValidationError);
      expect(() => batch({ quantity: 10, cost: '-1.00' })).toThrow(DomainValidationError);
    });
  });

  describe('caducidad', () => {
    it('cuenta los días que faltan', () => {
      const lote = batch({ quantity: 10, cost: '5.00', expiresAt: '2026-09-20' });
      expect(lote.daysUntilExpiry(NOW)).toBe(10);
    });

    it('detecta el vencimiento', () => {
      const lote = batch({ quantity: 10, cost: '5.00', expiresAt: '2026-09-20' });

      expect(lote.isExpired(NOW)).toBe(false);
      expect(lote.isExpired(new Date('2026-09-21T00:00:00.000Z'))).toBe(true);
    });

    it('avisa dentro del plazo indicado', () => {
      const lote = batch({ quantity: 10, cost: '5.00', expiresAt: '2026-09-20' });

      expect(lote.expiresWithin(30, NOW)).toBe(true);
      expect(lote.expiresWithin(5, NOW)).toBe(false);
    });

    it('un lote caducado deja de estar disponible aunque le quede producto', () => {
      const lote = batch({ quantity: 10, cost: '5.00', expiresAt: '2026-09-20' });
      const after = new Date('2026-10-01T00:00:00.000Z');

      expect(lote.remainingQuantity).toBe(10);
      expect(lote.isAvailable(after)).toBe(false);
    });
  });

  describe('consumo', () => {
    it('descuenta y deja el resto', () => {
      const lote = batch({ quantity: 20, cost: '7.20' });

      lote.consume(5, NOW, 'estilista');

      expect(lote.remainingQuantity).toBe(15);
      expect(lote.consumedQuantity).toBe(5);
    });

    it('no acumula error de coma flotante', () => {
      // Restar 0,15 de 20 en IEEE-754 da 19.849999999999998. Sin redondear, esa cola se
      // acumula hasta que el recuento físico no cuadra por milésimas inexplicables.
      const lote = batch({ quantity: 20, cost: '7.20' });

      for (let i = 0; i < 10; i += 1) lote.consume(0.15, NOW, 'estilista');

      expect(lote.remainingQuantity).toBe(18.5);
    });

    it('rechaza consumir más de lo que queda', () => {
      const lote = batch({ quantity: 10, cost: '5.00' });

      expect(() => lote.consume(11, NOW, 'x')).toThrow(BusinessRuleViolationError);
      expect(() => lote.consume(11, NOW, 'x')).toThrow(/solo tiene 10/);
    });

    it('agota el lote exactamente', () => {
      const lote = batch({ quantity: 10, cost: '5.00' });

      lote.consume(10, NOW, 'x');

      expect(lote.remainingQuantity).toBe(0);
      expect(lote.isDepleted).toBe(true);
      expect(lote.isAvailable(NOW)).toBe(false);
    });

    it('rechaza cantidades no positivas', () => {
      const lote = batch({ quantity: 10, cost: '5.00' });
      expect(() => lote.consume(0, NOW, 'x')).toThrow(DomainValidationError);
      expect(() => lote.consume(-1, NOW, 'x')).toThrow(DomainValidationError);
    });
  });

  describe('devolución', () => {
    it('devuelve producto al lote', () => {
      const lote = batch({ quantity: 10, cost: '5.00' });
      lote.consume(4, NOW, 'x');

      lote.restock(2, NOW, 'x');

      expect(lote.remainingQuantity).toBe(8);
    });

    it('no permite devolver más de lo que entró', () => {
      // Devolver más de lo recibido significa que el error está en otro sitio. Taparlo
      // aquí lo escondería.
      const lote = batch({ quantity: 10, cost: '5.00' });
      lote.consume(2, NOW, 'x');

      expect(() => lote.restock(5, NOW, 'x')).toThrow(BusinessRuleViolationError);
    });

    it('rechaza cantidades no positivas', () => {
      expect(() => batch({ quantity: 10, cost: '5.00' }).restock(0, NOW, 'x')).toThrow(
        DomainValidationError,
      );
    });
  });

  describe('recuento físico', () => {
    it('devuelve la diferencia y ajusta', () => {
      const lote = batch({ quantity: 20, cost: '7.20' });
      lote.consume(5, NOW, 'x');

      // La estantería manda sobre el sistema.
      const delta = lote.adjustTo(14, NOW, 'encargada');

      expect(delta).toBe(-1);
      expect(lote.remainingQuantity).toBe(14);
    });

    it('una diferencia positiva también se registra', () => {
      const lote = batch({ quantity: 20, cost: '7.20' });
      lote.consume(10, NOW, 'x');

      expect(lote.adjustTo(12, NOW, 'encargada')).toBe(2);
    });

    it('rechaza un recuento negativo o mayor que lo recibido', () => {
      const lote = batch({ quantity: 20, cost: '7.20' });

      expect(() => lote.adjustTo(-1, NOW, 'x')).toThrow(DomainValidationError);
      expect(() => lote.adjustTo(25, NOW, 'x')).toThrow(BusinessRuleViolationError);
    });
  });
});

describe('StockAllocationService', () => {
  describe('orden FEFO', () => {
    it('ordena por caducidad, no por recepción', () => {
      // El caso que separa FEFO de FIFO: un pedido reciente con caducidad más corta, cosa
      // habitual cuando el proveedor liquida existencias.
      const antiguo = batch({
        quantity: 10,
        cost: '5.00',
        expiresAt: '2027-06-01',
        receivedAt: '2026-01-01T00:00:00.000Z',
        number: 'ANTIGUO',
      });
      const reciente = batch({
        quantity: 10,
        cost: '5.00',
        expiresAt: '2026-11-01',
        receivedAt: '2026-09-01T00:00:00.000Z',
        number: 'RECIENTE',
      });

      const orden = StockAllocationService.sortByFefo([antiguo, reciente]);

      // FIFO habría sacado ANTIGUO primero y RECIENTE habría caducado en la estantería.
      expect(orden.map((b) => b.batchNumber)).toEqual(['RECIENTE', 'ANTIGUO']);
    });

    it('los lotes sin caducidad van al final', () => {
      const sinCaducidad = batch({ quantity: 10, cost: '5.00', expiresAt: null, number: 'SIN' });
      const conCaducidad = batch({
        quantity: 10,
        cost: '5.00',
        expiresAt: '2027-01-01',
        number: 'CON',
      });

      const orden = StockAllocationService.sortByFefo([sinCaducidad, conCaducidad]);

      // No urge gastar lo que no caduca.
      expect(orden.map((b) => b.batchNumber)).toEqual(['CON', 'SIN']);
    });

    it('desempata por fecha de recepción', () => {
      const primero = batch({
        quantity: 10,
        cost: '5.00',
        expiresAt: '2027-01-01',
        receivedAt: '2026-01-01T00:00:00.000Z',
        number: 'PRIMERO',
      });
      const segundo = batch({
        quantity: 10,
        cost: '5.00',
        expiresAt: '2027-01-01',
        receivedAt: '2026-06-01T00:00:00.000Z',
        number: 'SEGUNDO',
      });

      // Sin desempate, dos ejecuciones podrían repartir distinto y el coste del mismo
      // servicio variaría sin motivo.
      expect(
        StockAllocationService.sortByFefo([segundo, primero]).map((b) => b.batchNumber),
      ).toEqual(['PRIMERO', 'SEGUNDO']);
    });
  });

  describe('reparto', () => {
    it('consume de un solo lote cuando basta', () => {
      const lote = batch({ quantity: 20, cost: '7.20' });

      const result = StockAllocationService.allocate({
        batches: [lote],
        quantity: 5,
        currency: 'EUR',
        now: NOW,
      });

      expect(result.allocations).toHaveLength(1);
      expect(result.allocations[0].quantity).toBe(5);
      expect(result.totalCost.toDecimalString()).toBe('36.00');
    });

    it('reparte entre varios lotes con su coste real', () => {
      const barato = batch({
        quantity: 3,
        cost: '5.00',
        expiresAt: '2026-11-01',
        number: 'BARATO',
      });
      const caro = batch({ quantity: 10, cost: '8.00', expiresAt: '2027-01-01', number: 'CARO' });

      const result = StockAllocationService.allocate({
        batches: [caro, barato],
        quantity: 5,
        currency: 'EUR',
        now: NOW,
      });

      // FEFO agota BARATO (3 × 5,00 = 15,00) y saca 2 de CARO (2 × 8,00 = 16,00).
      expect(result.allocations.map((a) => [a.batchNumber, a.quantity])).toEqual([
        ['BARATO', 3],
        ['CARO', 2],
      ]);
      expect(result.totalCost.toDecimalString()).toBe('31.00');
      // Cada tramo lleva su coste real; la media es solo para mostrar.
      expect(result.averageUnitCost.toDecimalString()).toBe('6.20');
    });

    it('no toca los lotes: devuelve el plan', () => {
      const lote = batch({ quantity: 20, cost: '7.20' });

      StockAllocationService.allocate({
        batches: [lote],
        quantity: 5,
        currency: 'EUR',
        now: NOW,
      });

      // Aplicarlo es cosa del caso de uso, dentro de una transacción.
      expect(lote.remainingQuantity).toBe(20);
    });

    it('salta los lotes caducados', () => {
      const caducado = batch({
        quantity: 100,
        cost: '5.00',
        expiresAt: '2026-09-20',
        number: 'CADUCADO',
      });
      const vigente = batch({
        quantity: 10,
        cost: '8.00',
        expiresAt: '2027-01-01',
        number: 'VIGENTE',
      });

      const after = new Date('2026-10-01T00:00:00.000Z');
      const result = StockAllocationService.allocate({
        batches: [caducado, vigente],
        quantity: 5,
        currency: 'EUR',
        now: after,
      });

      expect(result.allocations.map((a) => a.batchNumber)).toEqual(['VIGENTE']);
    });

    it('rechaza si no hay suficiente y distingue lo caducado', () => {
      const caducado = batch({
        quantity: 100,
        cost: '5.00',
        expiresAt: '2026-09-20',
        number: 'CADUCADO',
      });
      const after = new Date('2026-10-01T00:00:00.000Z');

      const error = (() => {
        try {
          StockAllocationService.allocate({
            batches: [caducado],
            quantity: 5,
            currency: 'EUR',
            now: after,
          });
          return null;
        } catch (caught) {
          return caught as BusinessRuleViolationError;
        }
      })();

      // «No hay» y «hay pero está caducado» son problemas distintos: el segundo tiene
      // solución sin comprar nada.
      expect(error!.code).toBe('INSUFFICIENT_STOCK');
      expect(error!.message).toMatch(/lotes caducados/);
      expect(error!.details).toMatchObject({ available: 0, expiredQuantity: 100 });
    });

    it('permite forzar el consumo de lotes caducados', () => {
      const caducado = batch({
        quantity: 10,
        cost: '5.00',
        expiresAt: '2026-09-20',
        number: 'CADUCADO',
      });
      const after = new Date('2026-10-01T00:00:00.000Z');

      // Exige permiso y queda auditado (ADR-0012): la decisión la asume alguien que puede
      // responder por ella.
      const result = StockAllocationService.allocate({
        batches: [caducado],
        quantity: 5,
        currency: 'EUR',
        now: after,
        allowExpired: true,
      });

      expect(result.allocations).toHaveLength(1);
    });

    it('agota exactamente las existencias disponibles', () => {
      const a = batch({ quantity: 3, cost: '5.00', expiresAt: '2026-11-01' });
      const b = batch({ quantity: 2, cost: '6.00', expiresAt: '2026-12-01' });

      const result = StockAllocationService.allocate({
        batches: [a, b],
        quantity: 5,
        currency: 'EUR',
        now: NOW,
      });

      expect(result.allocations).toHaveLength(2);
      expect(result.totalCost.toDecimalString()).toBe('27.00');
    });

    it('reparte cantidades fraccionarias', () => {
      const lote = batch({ quantity: 1, cost: '30.00' });

      const result = StockAllocationService.allocate({
        batches: [lote],
        quantity: 0.15,
        currency: 'EUR',
        now: NOW,
      });

      expect(result.allocations[0].quantity).toBe(0.15);
      expect(result.totalCost.toDecimalString()).toBe('4.50');
    });

    it('rechaza cantidades no positivas', () => {
      expect(() =>
        StockAllocationService.allocate({
          batches: [batch({ quantity: 10, cost: '5.00' })],
          quantity: 0,
          currency: 'EUR',
          now: NOW,
        }),
      ).toThrow(DomainValidationError);
    });

    it('sin lotes no hay nada que repartir', () => {
      expect(() =>
        StockAllocationService.allocate({ batches: [], quantity: 1, currency: 'EUR', now: NOW }),
      ).toThrow(/Existencias insuficientes/);
    });
  });

  describe('métricas', () => {
    const lotes = () => [
      batch({ quantity: 10, cost: '5.00', expiresAt: '2026-09-15', number: 'PRONTO' }),
      batch({ quantity: 20, cost: '7.00', expiresAt: '2027-01-01', number: 'LEJOS' }),
      batch({ quantity: 5, cost: '4.00', expiresAt: '2026-09-20', number: 'MEDIO' }),
    ];

    it('suma las existencias disponibles', () => {
      expect(StockAllocationService.availableQuantity(lotes(), NOW)).toBe(35);
    });

    it('cuenta aparte lo inmovilizado por caducidad', () => {
      const after = new Date('2026-09-18T00:00:00.000Z');
      const stock = lotes();

      // Es la cifra que importa: producto que está en la estantería, parece stock y no se
      // puede usar.
      expect(StockAllocationService.availableQuantity(stock, after)).toBe(25);
      expect(StockAllocationService.expiredQuantity(stock, after)).toBe(10);
    });

    it('valora el inventario con el coste real de cada lote', () => {
      // 10×5 + 20×7 + 5×4 = 210
      expect(StockAllocationService.inventoryValue(lotes(), 'EUR', NOW).toDecimalString()).toBe(
        '210.00',
      );
    });

    it('lista lo que caduca pronto, por urgencia', () => {
      const pronto = StockAllocationService.expiringSoon(lotes(), 15, NOW);

      expect(pronto.map((b) => b.batchNumber)).toEqual(['PRONTO', 'MEDIO']);
    });

    it('no incluye lotes agotados en los avisos', () => {
      const stock = lotes();
      stock[0].consume(10, NOW, 'x');

      expect(StockAllocationService.expiringSoon(stock, 15, NOW).map((b) => b.batchNumber)).toEqual(
        ['MEDIO'],
      );
    });
  });

  describe('media móvil ponderada', () => {
    it('pondera por cantidad, no por número de compras', () => {
      // 100 unidades a 5 € y 1 a 50 € dan 5,45 €, no 27,50 €.
      const result = StockAllocationService.weightedAverageCost({
        currentQuantity: 100,
        currentUnitCost: Money.fromDecimal('5.00', 'EUR'),
        incomingQuantity: 1,
        incomingUnitCost: Money.fromDecimal('50.00', 'EUR'),
      });

      expect(result.toDecimalString()).toBe('5.45');
    });

    it('sin existencias previas manda el coste nuevo', () => {
      // Puede ocurrir tras un ajuste que dejó el stock a cero.
      const result = StockAllocationService.weightedAverageCost({
        currentQuantity: 0,
        currentUnitCost: Money.fromDecimal('5.00', 'EUR'),
        incomingQuantity: 10,
        incomingUnitCost: Money.fromDecimal('8.00', 'EUR'),
      });

      expect(result.toDecimalString()).toBe('8.00');
    });

    it('rechaza una entrada no positiva', () => {
      expect(() =>
        StockAllocationService.weightedAverageCost({
          currentQuantity: 10,
          currentUnitCost: Money.fromDecimal('5.00', 'EUR'),
          incomingQuantity: 0,
          incomingUnitCost: Money.fromDecimal('8.00', 'EUR'),
        }),
      ).toThrow(DomainValidationError);
    });
  });
});
