import type { ConfigService } from '@nestjs/config';

import {
  InMemoryBatchRepository,
  InMemoryMovementRepository,
  InMemoryProductRepository,
} from '@test/doubles/inventory.doubles';
import {
  InMemoryPurchaseOrderRepository,
  InMemorySupplierRepository,
  SequentialPurchaseOrderNumberGenerator,
} from '@test/doubles/purchases.doubles';
import { passthroughUnitOfWork } from '@test/doubles/salon.doubles';

import type { AuditRecorder, Clock, IdGenerator } from '../../../shared/application/ports';
import { BusinessRuleViolationError, EntityNotFoundError } from '../../../shared/domain/errors';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import { Percentage } from '../../../shared/domain/value-objects/time-range.vo';
import type { Env } from '../../../shared/infrastructure/config/env.schema';
import { ReceiveStockUseCase } from '../../inventory/application/inventory.use-cases';
import { Product } from '../../inventory/domain/product.entity';
import { Supplier } from '../domain/supplier.entity';
import {
  CancelPurchaseOrderUseCase,
  CreatePurchaseOrderUseCase,
  PurchaseOrderViewFactory,
  ReceivePurchaseOrderUseCase,
  SubmitPurchaseOrderUseCase,
} from './purchase-order.use-cases';

const TENANT = '11111111-1111-7111-8111-111111111111';
const NOW = new Date('2026-09-07T10:00:00.000Z');
const gtq = (amount: string) => Money.fromDecimal(amount, 'GTQ');

describe('Casos de uso de pedidos de compra', () => {
  let orders: InMemoryPurchaseOrderRepository;
  let suppliers: InMemorySupplierRepository;
  let products: InMemoryProductRepository;
  let batches: InMemoryBatchRepository;
  let movements: InMemoryMovementRepository;
  let numbers: SequentialPurchaseOrderNumberGenerator;
  let views: PurchaseOrderViewFactory;
  let receiveStock: ReceiveStockUseCase;
  let create: CreatePurchaseOrderUseCase;
  let submit: SubmitPurchaseOrderUseCase;
  let receive: ReceivePurchaseOrderUseCase;
  let cancel: CancelPurchaseOrderUseCase;
  let sequence: number;

  const clock: Clock = { now: () => NOW };
  const audit: AuditRecorder = { record: jest.fn().mockResolvedValue(undefined) };
  const config = { get: () => 'GTQ' } as unknown as ConfigService<Env, true>;

  const seedProduct = (overrides: { id: string; taxRate?: number; tracksBatches?: boolean }) =>
    Product.create({
      id: overrides.id,
      tenantId: TENANT,
      sku: `SKU-${overrides.id}`,
      name: `Producto ${overrides.id}`,
      price: gtq('100.00'),
      costPrice: gtq('50.00'),
      taxRate: Percentage.create(overrides.taxRate ?? 12),
      tracksBatches: overrides.tracksBatches ?? false,
      now: NOW,
      actorId: 'actor-1',
    });

  const seedSupplier = (id = 'supplier-1') =>
    Supplier.create({
      id,
      tenantId: TENANT,
      code: `PROV-${id}`,
      name: 'Distribuciones de prueba',
      now: NOW,
      actorId: 'actor-1',
    });

  beforeEach(() => {
    sequence = 0;
    const ids: IdGenerator = { generate: () => `id-${++sequence}` };

    orders = new InMemoryPurchaseOrderRepository();
    suppliers = new InMemorySupplierRepository();
    products = new InMemoryProductRepository();
    batches = new InMemoryBatchRepository();
    movements = new InMemoryMovementRepository();
    numbers = new SequentialPurchaseOrderNumberGenerator();

    views = new PurchaseOrderViewFactory(suppliers, products, movements);

    receiveStock = new ReceiveStockUseCase(
      products,
      batches,
      movements,
      ids,
      clock,
      passthroughUnitOfWork,
      audit,
    );

    create = new CreatePurchaseOrderUseCase(
      orders,
      suppliers,
      products,
      numbers,
      ids,
      clock,
      passthroughUnitOfWork,
      audit,
      views,
      config,
    );
    submit = new SubmitPurchaseOrderUseCase(orders, clock, views);
    receive = new ReceivePurchaseOrderUseCase(
      orders,
      receiveStock,
      clock,
      passthroughUnitOfWork,
      audit,
      views,
    );
    cancel = new CancelPurchaseOrderUseCase(orders, clock, passthroughUnitOfWork, views);
  });

  const openOrder = async (line: { quantity: number; unitCost: number; taxRate?: number }) => {
    suppliers.seed(seedSupplier());
    products.seed(seedProduct({ id: 'product-1' }));

    return create.execute({
      tenantId: TENANT,
      supplierId: 'supplier-1',
      lines: [{ productId: 'product-1', ...line }],
      actorId: 'actor-1',
    });
  };

  const submittedOrder = async (line: { quantity: number; unitCost: number }) => {
    const created = await openOrder(line);
    await submit.execute({ orderId: created.order.id, actorId: 'actor-1' });
    return created.order;
  };

  // =========================================================================
  describe('alta', () => {
    it('conserva la fecha esperada indicada', async () => {
      suppliers.seed(seedSupplier());
      products.seed(seedProduct({ id: 'product-1' }));
      const expectedAt = '2037-10-01T12:00:00.000Z';

      const { order } = await create.execute({
        tenantId: TENANT,
        supplierId: 'supplier-1',
        expectedAt,
        lines: [{ productId: 'product-1', quantity: 1, unitCost: 5 }],
        actorId: 'actor-1',
      });

      expect(order.expectedAt).toEqual(new Date(expectedAt));
    });

    it('usa impuesto cero si el catálogo devuelve un producto inconsistente', async () => {
      suppliers.seed(seedSupplier());
      const unexpected = seedProduct({ id: 'product-distinto', taxRate: 12 });
      jest.spyOn(products, 'findManyByIds').mockResolvedValueOnce([unexpected]);

      const { order } = await create.execute({
        tenantId: TENANT,
        supplierId: 'supplier-1',
        lines: [{ productId: 'product-1', quantity: 1, unitCost: 100 }],
        actorId: 'actor-1',
      });

      expect(order.lines[0].taxRate.value).toBe(0);
    });

    it('toma el tipo impositivo del producto cuando la línea no lo declara', async () => {
      suppliers.seed(seedSupplier());
      products.seed(seedProduct({ id: 'product-1', taxRate: 5 }));

      const { order } = await create.execute({
        tenantId: TENANT,
        supplierId: 'supplier-1',
        lines: [{ productId: 'product-1', quantity: 2, unitCost: 50 }],
        actorId: 'actor-1',
      });

      expect(order.lines[0].taxRate.value).toBe(5);
      expect(order.total.toDecimalString()).toBe('105.00');
    });

    it('respeta el tipo que la línea declara explícitamente', async () => {
      suppliers.seed(seedSupplier());
      products.seed(seedProduct({ id: 'product-1', taxRate: 12 }));

      const { order } = await create.execute({
        tenantId: TENANT,
        supplierId: 'supplier-1',
        lines: [{ productId: 'product-1', quantity: 1, unitCost: 100, taxRate: 0 }],
        actorId: 'actor-1',
      });

      expect(order.taxTotal.toDecimalString()).toBe('0.00');
    });

    it('numera correlativamente dentro del año', async () => {
      const first = await openOrder({ quantity: 1, unitCost: 5 });
      const second = await create.execute({
        tenantId: TENANT,
        supplierId: 'supplier-1',
        lines: [{ productId: 'product-1', quantity: 1, unitCost: 5 }],
        actorId: 'actor-1',
      });

      expect(first.order.number).toBe('OC-2026-000001');
      expect(second.order.number).toBe('OC-2026-000002');
    });

    it('exige un proveedor activo', async () => {
      const supplier = seedSupplier();
      supplier.markDeleted(NOW, 'actor-1');
      suppliers.seed(supplier);
      products.seed(seedProduct({ id: 'product-1' }));

      await expect(
        create.execute({
          tenantId: TENANT,
          supplierId: 'supplier-1',
          lines: [{ productId: 'product-1', quantity: 1, unitCost: 5 }],
          actorId: 'actor-1',
        }),
      ).rejects.toThrow(EntityNotFoundError);
    });

    it('rechaza un producto inexistente', async () => {
      suppliers.seed(seedSupplier());

      await expect(
        create.execute({
          tenantId: TENANT,
          supplierId: 'supplier-1',
          lines: [{ productId: 'fantasma', quantity: 1, unitCost: 5 }],
          actorId: 'actor-1',
        }),
      ).rejects.toThrow(EntityNotFoundError);
    });

    it('no admite un pedido sin líneas', async () => {
      await expect(
        create.execute({
          tenantId: TENANT,
          supplierId: 'supplier-1',
          lines: [],
          actorId: 'actor-1',
        }),
      ).rejects.toThrow(BusinessRuleViolationError);
    });
  });

  // =========================================================================
  describe('transiciones', () => {
    it('rechaza enviar un pedido inexistente', async () => {
      await expect(submit.execute({ orderId: 'missing', actorId: 'actor-1' })).rejects.toThrow(
        'borrador',
      );
    });

    it('rechaza cancelar un pedido inexistente', async () => {
      await expect(
        cancel.execute({ orderId: 'missing', reason: 'No existe', actorId: 'actor-1' }),
      ).rejects.toThrow('no admite cancelación');
    });

    it('rechaza cancelar si otra transición gana antes de escribir', async () => {
      const order = await submittedOrder({ quantity: 1, unitCost: 5 });
      jest.spyOn(orders, 'markCancelled').mockResolvedValueOnce(false);

      await expect(
        cancel.execute({ orderId: order.id, reason: 'Carrera', actorId: 'actor-1' }),
      ).rejects.toThrow('no admite cancelación');
    });

    it('envía un borrador y deja el pedido en SUBMITTED', async () => {
      const created = await openOrder({ quantity: 1, unitCost: 5 });
      const { order } = await submit.execute({
        orderId: created.order.id,
        actorId: 'actor-1',
      });

      expect(order.status).toBe('SUBMITTED');
      expect(order.orderedAt).toEqual(NOW);
    });

    it('no envía dos veces el mismo pedido', async () => {
      const order = await submittedOrder({ quantity: 1, unitCost: 5 });

      await expect(submit.execute({ orderId: order.id, actorId: 'actor-1' })).rejects.toThrow(
        'borrador',
      );
    });

    it('cancela un pedido enviado', async () => {
      const order = await submittedOrder({ quantity: 1, unitCost: 5 });
      const { order: cancelled } = await cancel.execute({
        orderId: order.id,
        reason: 'Ya no hace falta',
        actorId: 'actor-1',
      });

      expect(cancelled.status).toBe('CANCELLED');
    });

    it('no cancela un pedido ya recibido', async () => {
      const order = await submittedOrder({ quantity: 1, unitCost: 5 });
      await receive.execute({
        orderId: order.id,
        tenantId: TENANT,
        lines: [{ lineId: order.lines[0].id, quantity: 1 }],
        actorId: 'actor-1',
      });

      await expect(
        cancel.execute({ orderId: order.id, reason: 'Tarde', actorId: 'actor-1' }),
      ).rejects.toThrow('no admite cancelación');
    });
  });

  // =========================================================================
  describe('recepción', () => {
    it('da entrada al stock delegando en inventario', async () => {
      const order = await submittedOrder({ quantity: 10, unitCost: 5 });

      const { order: received } = await receive.execute({
        orderId: order.id,
        tenantId: TENANT,
        lines: [{ lineId: order.lines[0].id, quantity: 4 }],
        actorId: 'actor-1',
      });

      expect(received.status).toBe('PARTIALLY_RECEIVED');
      // El movimiento lo escribe `ReceiveStockUseCase`: si esto falla, la delegación se ha
      // roto y compras habría vuelto a tener motor de existencias propio (ADR-0002).
      expect(await products.findByIdOrFail('product-1')).toMatchObject({ stockOnHand: 4 });
      expect(await movements.balanceOf('product-1')).toBe(4);
    });

    it('cierra el pedido al completar la última unidad', async () => {
      const order = await submittedOrder({ quantity: 10, unitCost: 5 });
      const lineId = order.lines[0].id;

      await receive.execute({
        orderId: order.id,
        tenantId: TENANT,
        lines: [{ lineId, quantity: 6 }],
        actorId: 'actor-1',
      });
      const { order: received } = await receive.execute({
        orderId: order.id,
        tenantId: TENANT,
        lines: [{ lineId, quantity: 4 }],
        actorId: 'actor-1',
      });

      expect(received.status).toBe('RECEIVED');
      expect(received.receivedAt).toEqual(NOW);
    });

    it('admite completar una cantidad fraccionaria pendiente', async () => {
      const order = await submittedOrder({ quantity: 0.3, unitCost: 12 });
      const lineId = order.lines[0].id;

      await receive.execute({
        orderId: order.id,
        tenantId: TENANT,
        lines: [{ lineId, quantity: 0.1 }],
        actorId: 'actor-1',
      });
      const { order: received } = await receive.execute({
        orderId: order.id,
        tenantId: TENANT,
        lines: [{ lineId, quantity: 0.2 }],
        actorId: 'actor-1',
      });

      expect(received.status).toBe('RECEIVED');
    });

    it('rechaza recibir más de lo pendiente sin tocar el inventario', async () => {
      const order = await submittedOrder({ quantity: 2, unitCost: 5 });

      await expect(
        receive.execute({
          orderId: order.id,
          tenantId: TENANT,
          lines: [{ lineId: order.lines[0].id, quantity: 3 }],
          actorId: 'actor-1',
        }),
      ).rejects.toThrow('supera el pendiente');

      expect(await movements.balanceOf('product-1')).toBe(0);
    });

    it('no admite recepción sobre un borrador', async () => {
      const created = await openOrder({ quantity: 1, unitCost: 5 });

      await expect(
        receive.execute({
          orderId: created.order.id,
          tenantId: TENANT,
          lines: [{ lineId: created.order.lines[0].id, quantity: 1 }],
          actorId: 'actor-1',
        }),
      ).rejects.toThrow('no está disponible para recepción');
    });

    it('exige al menos una línea', async () => {
      const order = await submittedOrder({ quantity: 1, unitCost: 5 });

      await expect(
        receive.execute({
          orderId: order.id,
          tenantId: TENANT,
          lines: [],
          actorId: 'actor-1',
        }),
      ).rejects.toThrow('al menos una línea recibida');
    });

    /**
     * Regresión de R0-BE-003.
     *
     * La versión anterior comprobaba lo pendiente en JavaScript sobre un valor leído al
     * abrir la transacción. Dos personas descargando el mismo albarán pasaban las dos la
     * validación, y el sobre-recibo lo paraba el `CHECK` de la base con un error de
     * restricción sin traducir: un 500 en una operación de mostrador.
     *
     * Ahora la condición viaja dentro del `UPDATE`. Cuando otra entrega se adelanta, la
     * escritura no se aplica y quien llega segundo recibe el 422 que explica lo ocurrido.
     */
    it('rechaza con un error de negocio la entrega que otra se adelantó a consumir', async () => {
      const order = await submittedOrder({ quantity: 10, unitCost: 5 });
      const lineId = order.lines[0].id;

      // Entre la lectura del pedido y la escritura de la línea, otra transacción recibe
      // las diez unidades completas.
      orders.beforeReceiveLine = (id) => {
        if (id !== lineId) return;
        orders.beforeReceiveLine = undefined;
        void orders.receiveLine(order.lines[0], order.lines[0].quantity, NOW);
      };

      await expect(
        receive.execute({
          orderId: order.id,
          tenantId: TENANT,
          lines: [{ lineId, quantity: 10 }],
          actorId: 'actor-1',
        }),
      ).rejects.toThrow(BusinessRuleViolationError);

      await expect(
        receive.execute({
          orderId: order.id,
          tenantId: TENANT,
          lines: [{ lineId, quantity: 10 }],
          actorId: 'actor-1',
        }),
      ).rejects.toThrow('supera el pendiente');
    });
  });

  describe('composición de vistas', () => {
    it('tolera que el proveedor relacionado ya no esté disponible', async () => {
      const created = await openOrder({ quantity: 1, unitCost: 5 });
      const withoutSupplier = new PurchaseOrderViewFactory(
        new InMemorySupplierRepository(),
        products,
        movements,
      );

      const one = await withoutSupplier.forOne(created.order, false);
      const many = await withoutSupplier.forMany([created.order]);

      expect(one.supplier).toBeNull();
      expect(many[0].supplier).toBeNull();
    });
  });
});
