import {
  InMemoryBatchRepository,
  InMemoryMovementRepository,
  InMemoryProductRepository,
} from '@test/doubles/inventory.doubles';
import { passthroughUnitOfWork } from '@test/doubles/salon.doubles';

import type { AuditRecorder, Clock, IdGenerator } from '../../../shared/application/ports';
import { BusinessRuleViolationError, ConflictError } from '../../../shared/domain/errors';
import { Money } from '../../../shared/domain/value-objects/money.vo';
import { Batch } from '../domain/batch.entity';
import { Product } from '../domain/product.entity';
import {
  AdjustStockUseCase,
  ConsumeStockUseCase,
  CreateProductUseCase,
  DeleteProductUseCase,
  GetKardexUseCase,
  GetStockAlertsUseCase,
  ReceiveStockUseCase,
  SearchProductsUseCase,
} from './inventory.use-cases';

const TENANT = '11111111-1111-7111-8111-111111111111';
const NOW = new Date('2026-09-03T10:00:00.000Z');
const gtq = (amount: string) => Money.fromDecimal(amount, 'GTQ');
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('Casos de uso de inventario', () => {
  let products: InMemoryProductRepository;
  let batches: InMemoryBatchRepository;
  let movements: InMemoryMovementRepository;
  let audit: AuditRecorder;
  let clock: Clock;
  let ids: IdGenerator;
  let sequence: number;

  beforeEach(() => {
    products = new InMemoryProductRepository();
    batches = new InMemoryBatchRepository();
    movements = new InMemoryMovementRepository();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    clock = { now: () => NOW };
    sequence = 0;
    ids = { generate: () => `generated-${(sequence += 1)}` };
  });

  const aProduct = (overrides: Partial<Parameters<typeof Product.create>[0]> = {}) =>
    Product.create({
      id: 'product-1',
      tenantId: TENANT,
      sku: 'TINTE-6.0',
      name: 'Tinte castaño 6.0',
      price: gtq('180.00'),
      costPrice: gtq('60.00'),
      now: NOW,
      actorId: 'user-1',
      ...overrides,
    });

  const aBatch = (overrides: Partial<Parameters<typeof Batch.receive>[0]> = {}) =>
    Batch.receive({
      id: `batch-${(sequence += 1)}`,
      tenantId: TENANT,
      productId: 'product-1',
      batchNumber: 'L-001',
      quantity: 10,
      unitCost: gtq('60.00'),
      now: NOW,
      actorId: 'user-1',
      ...overrides,
    });

  /**
   * Lote que ya ha caducado.
   *
   * Se recibe con fecha anterior a su caducidad porque `Batch.receive` rechaza dar de alta
   * mercancía ya vencida. No es un rodeo del test: un lote caducado solo puede llegar a
   * estarlo **por el paso del tiempo**, y construirlo de otro modo probaría un estado que
   * el sistema no permite alcanzar.
   */
  const anExpiredBatch = (expiredOn: string, overrides = {}) =>
    Batch.receive({
      id: `batch-${(sequence += 1)}`,
      tenantId: TENANT,
      productId: 'product-1',
      batchNumber: 'L-VENC',
      quantity: 10,
      unitCost: gtq('60.00'),
      expiresAt: day(expiredOn),
      now: new Date(day(expiredOn).getTime() - 90 * 86_400_000),
      actorId: 'user-1',
      ...overrides,
    });

  const receiveStock = () =>
    new ReceiveStockUseCase(products, batches, movements, ids, clock, passthroughUnitOfWork, audit);

  const consumeStock = () =>
    new ConsumeStockUseCase(products, batches, movements, ids, clock, passthroughUnitOfWork, audit);

  const adjustStock = () =>
    new AdjustStockUseCase(
      products,
      batches,
      movements,
      ids,
      clock,
      passthroughUnitOfWork,
      audit,
      consumeStock(),
    );

  // -------------------------------------------------------------------------

  describe('alta de producto', () => {
    it('crea el producto y deja rastro en la auditoría', async () => {
      const product = await new CreateProductUseCase(products, ids, clock, audit).execute({
        tenantId: TENANT,
        sku: 'sh-arg-500',
        name: 'Champú de argán',
        price: '120.00',
        currency: 'GTQ',
        actorId: 'user-1',
      });

      expect(product.sku).toBe('SH-ARG-500');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'CREATE', entityType: 'Product' }),
      );
    });

    it('distingue el SKU duplicado del que quedó en un producto eliminado', async () => {
      // Son dos problemas con soluciones distintas: uno exige otro código y el otro se
      // arregla recuperando lo que había.
      const existing = aProduct();
      products.seed(existing);
      await products.softDelete(existing.id);

      const promise = new CreateProductUseCase(products, ids, clock, audit).execute({
        tenantId: TENANT,
        sku: 'TINTE-6.0',
        name: 'Otro tinte',
        price: '180.00',
        currency: 'GTQ',
        actorId: 'user-1',
      });

      await expect(promise).rejects.toThrow(ConflictError);
      await expect(promise).rejects.toThrow(/Recupérelo/);
    });
  });

  describe('baja de producto', () => {
    it('impide dar de baja lo que aún está en la estantería', async () => {
      const product = aProduct();
      product.applyDelta(4, NOW, 'user-1');
      products.seed(product);

      await expect(
        new DeleteProductUseCase(products, clock, audit).execute({
          productId: product.id,
          actorId: 'user-1',
        }),
      ).rejects.toThrow(/quedan 4 unidades/);
    });
  });

  // -------------------------------------------------------------------------

  describe('recepción de mercancía', () => {
    it('sube existencias, recalcula el coste medio y anota el asiento', async () => {
      const product = aProduct({ costPrice: gtq('60.00') });
      product.applyDelta(10, NOW, 'user-1');
      products.seed(product);

      const result = await receiveStock().execute({
        tenantId: TENANT,
        productId: product.id,
        quantity: 10,
        unitCost: '80.00',
        actorId: 'user-1',
      });

      expect(result.balanceAfter).toBe(20);
      expect(result.movement.type).toBe('PURCHASE_IN');
      expect(result.movement.balanceAfter).toBe(20);
      // 10 a 60,00 más 10 a 80,00: la media pondera con lo que había, no con el resultado.
      expect(product.costPrice.toDecimalString()).toBe('70.00');
    });

    it('crea el lote cuando la entrada trae número', async () => {
      products.seed(aProduct({ tracksBatches: true }));

      const result = await receiveStock().execute({
        tenantId: TENANT,
        productId: 'product-1',
        quantity: 6,
        unitCost: '60.00',
        batchNumber: 'L-2026-04',
        expiresAt: day('2027-04-30'),
        actorId: 'user-1',
      });

      expect(result.batch?.batchNumber).toBe('L-2026-04');
      expect(result.movement.batchId).toBe(result.batch?.id);
    });

    it('exige número de lote en un producto que se traza por lote', async () => {
      // Aceptar la entrada anónima dejaría unidades de las que ninguna salida FEFO sabría
      // descontar, y el agujero estaría justo donde hace falta la trazabilidad.
      products.seed(aProduct({ tracksBatches: true }));

      await expect(
        receiveStock().execute({
          tenantId: TENANT,
          productId: 'product-1',
          quantity: 6,
          unitCost: '60.00',
          actorId: 'user-1',
        }),
      ).rejects.toThrow(/indique el número impreso/);
    });

    it('amplía el lote existente cuando llega partido en dos entregas', async () => {
      products.seed(aProduct({ tracksBatches: true }));
      const existing = aBatch({ batchNumber: 'L-001', quantity: 10 });
      batches.seed(existing);

      const result = await receiveStock().execute({
        tenantId: TENANT,
        productId: 'product-1',
        quantity: 5,
        unitCost: '60.00',
        batchNumber: 'L-001',
        actorId: 'user-1',
      });

      expect(result.batch?.id).toBe(existing.id);
      expect(existing.initialQuantity).toBe(15);
      expect(existing.remainingQuantity).toBe(15);
    });

    it('rechaza reutilizar el número de lote con otro coste', async () => {
      // Con datos distintos no es el mismo lote, es un número repetido.
      products.seed(aProduct({ tracksBatches: true }));
      batches.seed(aBatch({ batchNumber: 'L-001', unitCost: gtq('60.00') }));

      await expect(
        receiveStock().execute({
          tenantId: TENANT,
          productId: 'product-1',
          quantity: 5,
          unitCost: '75.00',
          batchNumber: 'L-001',
          actorId: 'user-1',
        }),
      ).rejects.toThrow(/ya existe con un coste/);
    });

    it('rechaza reutilizar el número de lote con otra caducidad', async () => {
      products.seed(aProduct({ tracksBatches: true }));
      batches.seed(aBatch({ batchNumber: 'L-001', expiresAt: day('2027-01-31') }));

      await expect(
        receiveStock().execute({
          tenantId: TENANT,
          productId: 'product-1',
          quantity: 5,
          unitCost: '60.00',
          batchNumber: 'L-001',
          expiresAt: day('2027-06-30'),
          actorId: 'user-1',
        }),
      ).rejects.toThrow(/otra fecha de caducidad/);
    });

    it('rechaza recibir en un producto sin control de existencias', async () => {
      products.seed(aProduct({ trackStock: false }));

      await expect(
        receiveStock().execute({
          tenantId: TENANT,
          productId: 'product-1',
          quantity: 5,
          unitCost: '60.00',
          actorId: 'user-1',
        }),
      ).rejects.toThrow(/no lleva control de existencias/);
    });
  });

  // -------------------------------------------------------------------------

  describe('consumo FEFO', () => {
    /** Producto con lotes y tres entradas de caducidad distinta. */
    const seedThreeBatches = () => {
      const product = aProduct({ tracksBatches: true });
      product.applyDelta(30, NOW, 'user-1');
      products.seed(product);

      // Se siembran en desorden a propósito: el reparto no puede depender de cómo lleguen.
      const june = aBatch({
        batchNumber: 'L-JUN',
        quantity: 10,
        expiresAt: day('2027-06-30'),
        unitCost: gtq('60.00'),
      });
      const march = aBatch({
        batchNumber: 'L-MAR',
        quantity: 10,
        expiresAt: day('2027-03-31'),
        unitCost: gtq('50.00'),
      });
      const never = aBatch({
        batchNumber: 'L-SIN',
        quantity: 10,
        expiresAt: null,
        unitCost: gtq('70.00'),
      });

      batches.seed(june, march, never);
      return { product, june, march, never };
    };

    it('consume primero el lote que caduca antes, no el que llegó antes', async () => {
      const { march, june } = seedThreeBatches();

      const result = await consumeStock().execute({
        tenantId: TENANT,
        productId: 'product-1',
        quantity: 4,
        actorId: 'user-1',
      });

      expect(march.remainingQuantity).toBe(6);
      expect(june.remainingQuantity).toBe(10);
      expect(result.movements).toHaveLength(1);
      expect(result.movements[0].batchId).toBe(march.id);
    });

    it('encadena lotes cuando uno no basta y deja el que no caduca para el final', async () => {
      const { march, june, never } = seedThreeBatches();

      const result = await consumeStock().execute({
        tenantId: TENANT,
        productId: 'product-1',
        quantity: 25,
        actorId: 'user-1',
      });

      expect(march.remainingQuantity).toBe(0);
      expect(june.remainingQuantity).toBe(0);
      expect(never.remainingQuantity).toBe(5);
      expect(result.movements.map((m) => m.batchId)).toEqual([march.id, june.id, never.id]);
    });

    it('valora la salida al coste real de cada lote, no a una media', async () => {
      seedThreeBatches();

      // 10 a 50,00 más 5 a 60,00 = 800,00. Una media global daría otra cifra y el margen
      // del servicio dejaría de ser exacto.
      const result = await consumeStock().execute({
        tenantId: TENANT,
        productId: 'product-1',
        quantity: 15,
        actorId: 'user-1',
      });

      expect(result.totalCost.toDecimalString()).toBe('800.00');
    });

    it('registra un asiento por lote con saldos descendentes', async () => {
      // Un asiento por lote es lo que permite responder «qué lote se le aplicó a esta
      // clienta» ante una reacción (Reglamento (CE) 1223/2009).
      seedThreeBatches();

      const result = await consumeStock().execute({
        tenantId: TENANT,
        productId: 'product-1',
        quantity: 15,
        actorId: 'user-1',
      });

      expect(result.movements.map((m) => m.balanceAfter)).toEqual([20, 15]);
      expect(result.balanceAfter).toBe(15);
    });

    it('bloquea el consumo de un lote caducado', async () => {
      const product = aProduct({ tracksBatches: true });
      product.applyDelta(10, NOW, 'user-1');
      products.seed(product);
      batches.seed(anExpiredBatch('2026-08-01'));

      const promise = consumeStock().execute({
        tenantId: TENANT,
        productId: 'product-1',
        quantity: 2,
        actorId: 'user-1',
      });

      await expect(promise).rejects.toThrow(BusinessRuleViolationError);
      await expect(promise).rejects.toThrow(/lotes caducados/);
    });

    it('permite consumir caducado cuando se autoriza expresamente', async () => {
      const product = aProduct({ tracksBatches: true });
      product.applyDelta(10, NOW, 'user-1');
      products.seed(product);
      const expired = anExpiredBatch('2026-08-01');
      batches.seed(expired);

      const result = await consumeStock().execute({
        tenantId: TENANT,
        productId: 'product-1',
        quantity: 2,
        allowExpired: true,
        actorId: 'user-1',
      });

      expect(expired.remainingQuantity).toBe(8);
      expect(result.balanceAfter).toBe(8);
    });

    it('sigue el camino corto en un producto sin lotes', async () => {
      const product = aProduct({ tracksBatches: false, costPrice: gtq('60.00') });
      product.applyDelta(10, NOW, 'user-1');
      products.seed(product);

      const result = await consumeStock().execute({
        tenantId: TENANT,
        productId: 'product-1',
        quantity: 2,
        actorId: 'user-1',
      });

      expect(result.movements).toHaveLength(1);
      expect(result.movements[0].batchId).toBeNull();
      expect(result.totalCost.toDecimalString()).toBe('120.00');
    });

    it('rechaza la salida que supera lo disponible sin tocar ningún lote', async () => {
      // El reparto se calcula antes de escribir: una salida imposible se rechaza entera y
      // no a mitad de camino, con medio lote ya consumido.
      const { march, june, never } = seedThreeBatches();

      await expect(
        consumeStock().execute({
          tenantId: TENANT,
          productId: 'product-1',
          quantity: 31,
          actorId: 'user-1',
        }),
      ).rejects.toThrow(/Existencias insuficientes/);

      expect([march, june, never].map((b) => b.remainingQuantity)).toEqual([10, 10, 10]);
      expect(movements.entries).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------

  describe('ajuste', () => {
    it('rechaza un ajuste de cero', async () => {
      products.seed(aProduct());

      await expect(
        adjustStock().execute({
          tenantId: TENANT,
          productId: 'product-1',
          quantityDelta: 0,
          reason: 'Recuento',
          actorId: 'user-1',
        }),
      ).rejects.toThrow(/no puede ser de cero/);
    });

    it('aplica la merma de un lote concreto', async () => {
      const product = aProduct({ tracksBatches: true });
      product.applyDelta(10, NOW, 'user-1');
      products.seed(product);
      const batch = aBatch({ quantity: 10 });
      batches.seed(batch);

      const result = await adjustStock().execute({
        tenantId: TENANT,
        productId: 'product-1',
        quantityDelta: -2,
        type: 'WASTE_OUT',
        batchId: batch.id,
        reason: 'Envase roto',
        actorId: 'user-1',
      });

      expect(batch.remainingQuantity).toBe(8);
      expect(result.balanceAfter).toBe(8);
      expect(result.movements[0].reason).toBe('Envase roto');
    });

    it('delega en FEFO la salida sin lote de un producto trazado', async () => {
      // Se delega en lugar de reimplementar el reparto: dos motores de inventario acaban
      // divergiendo (ADR-0002).
      const product = aProduct({ tracksBatches: true });
      product.applyDelta(20, NOW, 'user-1');
      products.seed(product);
      const soon = aBatch({ batchNumber: 'L-MAR', quantity: 10, expiresAt: day('2027-03-31') });
      const later = aBatch({ batchNumber: 'L-JUN', quantity: 10, expiresAt: day('2027-06-30') });
      batches.seed(later, soon);

      const result = await adjustStock().execute({
        tenantId: TENANT,
        productId: 'product-1',
        quantityDelta: -12,
        reason: 'Recuento de marzo',
        actorId: 'user-1',
      });

      expect(soon.remainingQuantity).toBe(0);
      expect(later.remainingQuantity).toBe(8);
      expect(result.movements).toHaveLength(2);
    });

    it('rechaza la entrada por ajuste en un producto trazado por lote', async () => {
      // Inventarle un lote parecería trazabilidad sin serlo. La vía correcta es la
      // recepción, con su número.
      products.seed(aProduct({ tracksBatches: true }));

      await expect(
        adjustStock().execute({
          tenantId: TENANT,
          productId: 'product-1',
          quantityDelta: 5,
          reason: 'Aparecieron unidades',
          actorId: 'user-1',
        }),
      ).rejects.toThrow(/registre la entrada como recepción/);
    });

    it('rechaza un lote que no pertenece al producto', async () => {
      const product = aProduct({ tracksBatches: true });
      product.applyDelta(10, NOW, 'user-1');
      products.seed(product);
      batches.seed(aBatch({ productId: 'otro-producto' }));

      await expect(
        adjustStock().execute({
          tenantId: TENANT,
          productId: 'product-1',
          quantityDelta: -1,
          batchId: 'batch-1',
          reason: 'Recuento',
          actorId: 'user-1',
        }),
      ).rejects.toThrow(/no pertenece a ese producto/);
    });

    it('rechaza el ajuste que dejaría existencias negativas', async () => {
      const product = aProduct();
      product.applyDelta(2, NOW, 'user-1');
      products.seed(product);

      await expect(
        adjustStock().execute({
          tenantId: TENANT,
          productId: 'product-1',
          quantityDelta: -5,
          reason: 'Recuento',
          actorId: 'user-1',
        }),
      ).rejects.toThrow(/Existencias insuficientes/);
    });
  });

  // -------------------------------------------------------------------------

  describe('la caché de existencias no se calcula, se aplica', () => {
    it('mantiene el saldo cuadrado tras varias operaciones encadenadas', async () => {
      // Este es el fallo que motivó reemplazar el motor: la versión anterior leía
      // `stockOnHand`, sumaba en JavaScript y escribía el total. Dos operaciones sobre el
      // mismo agregado leído una vez perdían la primera. Aquí cada paso pasa por
      // `applyStockDelta`, así que el saldo se acumula en lugar de pisarse.
      const product = aProduct();
      products.seed(product);

      await receiveStock().execute({
        tenantId: TENANT,
        productId: product.id,
        quantity: 10,
        unitCost: '60.00',
        actorId: 'user-1',
      });
      await receiveStock().execute({
        tenantId: TENANT,
        productId: product.id,
        quantity: 5,
        unitCost: '60.00',
        actorId: 'user-1',
      });
      const result = await consumeStock().execute({
        tenantId: TENANT,
        productId: product.id,
        quantity: 3,
        actorId: 'user-1',
      });

      expect(result.balanceAfter).toBe(12);
      // El ledger es la fuente de verdad y la caché su suma: tienen que coincidir.
      expect(await movements.balanceOf(product.id)).toBe(12);
      expect(product.stockOnHand).toBe(12);
    });
  });

  // -------------------------------------------------------------------------

  describe('consultas', () => {
    it('enriquece el kardex con producto y lote sin una consulta por fila', async () => {
      const product = aProduct({ tracksBatches: true });
      products.seed(product);
      const batch = aBatch({ batchNumber: 'L-001' });
      batches.seed(batch);

      await receiveStock().execute({
        tenantId: TENANT,
        productId: product.id,
        quantity: 5,
        unitCost: '60.00',
        batchNumber: 'L-001',
        actorId: 'user-1',
      });

      const page = await new GetKardexUseCase(movements, products, batches).execute({
        filter: {},
        page: { page: 1, limit: 20 },
      });

      expect(page.data[0].product?.name).toBe('Tinte castaño 6.0');
      expect(page.data[0].batch?.batchNumber).toBe('L-001');
    });

    it('filtra el catálogo por semáforo de existencias', async () => {
      const low = aProduct({ id: 'p-low', sku: 'A-1', reorderPoint: 5 });
      low.applyDelta(3, NOW, 'user-1');
      const fine = aProduct({ id: 'p-ok', sku: 'A-2', reorderPoint: 5 });
      fine.applyDelta(20, NOW, 'user-1');
      products.seed(low, fine, aProduct({ id: 'p-out', sku: 'A-3' }));

      const page = await new SearchProductsUseCase(products).execute({
        filter: { stock: 'LOW' },
        page: { page: 1, limit: 20 },
      });

      expect(page.data.map((p) => p.id)).toEqual(['p-low']);
    });

    it('junta reposición y caducidad en una sola respuesta', async () => {
      const low = aProduct({ id: 'p-low', sku: 'A-1', reorderPoint: 5, reorderQuantity: 12 });
      low.applyDelta(3, NOW, 'user-1');
      products.seed(low);
      batches.seed(
        aBatch({ productId: 'p-low', batchNumber: 'L-PRONTO', expiresAt: day('2026-09-20') }),
        anExpiredBatch('2026-08-01', { productId: 'p-low' }),
        aBatch({ productId: 'p-low', batchNumber: 'L-LEJOS', expiresAt: day('2027-12-31') }),
      );

      const alerts = await new GetStockAlertsUseCase(products, batches, clock).execute({
        withinDays: 30,
      });

      expect(alerts.reorder[0]).toMatchObject({ missing: 2, suggestedOrder: 12 });
      expect(alerts.expiring.map((item) => item.batch.batchNumber)).toEqual(['L-PRONTO']);
      expect(alerts.expired.map((batch) => batch.batchNumber)).toEqual(['L-VENC']);
    });

    it('sugiere al menos lo que falta cuando no hay cantidad de pedido fijada', async () => {
      const low = aProduct({ id: 'p-low', reorderPoint: 8, reorderQuantity: 0 });
      low.applyDelta(3, NOW, 'user-1');
      products.seed(low);

      const alerts = await new GetStockAlertsUseCase(products, batches, clock).execute({});

      expect(alerts.reorder[0].suggestedOrder).toBe(5);
    });
  });
});
