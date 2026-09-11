import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';
import { QueryScopeStore } from '@shared/infrastructure/persistence/prisma/query-scope';

import { api, createTestApp, resetDatabase } from './app-harness';
import { seedTwoTenants, TEST_PASSWORD, type SeededTenant } from './fixtures';

/**
 * Inventario, de extremo a extremo.
 *
 * Estos tests existen por lo que la suite unitaria **no puede** afirmar. En memoria no hay
 * concurrencia: dos operaciones simultáneas sobre el mismo producto se ejecutan uno detrás
 * de otra y cualquier implementación parece correcta, incluso la que lee el stock, suma en
 * JavaScript y escribe el total. Ese era exactamente el motor anterior, y el fallo que
 * escondía —una caja entera de producto desaparecida sin rastro— solo aparece cuando dos
 * peticiones se cruzan de verdad contra PostgreSQL.
 *
 * Aquí también se comprueba que las garantías siguen en pie **saltándose la aplicación**:
 * una restricción que solo cumple el código deja de ser una garantía en cuanto alguien
 * abra una consola de SQL.
 */

const DAY = 86_400_000;
const isoDay = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

describe('Inventario (integración)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let salonA: SeededTenant;
  let token: string;

  beforeAll(async () => {
    const context = await createTestApp();
    app = context.app;
    prisma = context.prisma;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    ({ salonA } = await seedTwoTenants(prisma));

    const login = await request(app.getHttpServer())
      .post(api('/auth/login'))
      .send({ email: salonA.ownerEmail, password: TEST_PASSWORD })
      .expect(200);

    token = login.body.data.accessToken as string;
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => app.getHttpServer();

  /** Da de alta un producto por la API y devuelve su identificador. */
  const createProduct = async (
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; body: Record<string, unknown> }> => {
    const response = await request(server())
      .post(api('/products'))
      .set(auth())
      .send({ sku: 'SH-TEST-1', name: 'Champú de prueba', price: 120, ...overrides })
      .expect(201);

    return { id: response.body.data.id as string, body: response.body.data };
  };

  const receive = (body: Record<string, unknown>) =>
    request(server()).post(api('/inventory/receive')).set(auth()).send(body);

  const consume = (body: Record<string, unknown>) =>
    request(server()).post(api('/inventory/consume')).set(auth()).send(body);

  /**
   * Consulta directa a la base, fuera de una petición HTTP.
   *
   * La extensión de Prisma exige un salón activo en toda consulta (ADR-0003) y aquí no hay
   * petición que lo aporte. `crossTenant` es la vía explícita para saltárselo, y que haga
   * falta declararla es precisamente la garantía funcionando: lo que no se puede es
   * consultar sin salón **por descuido**.
   */
  const inspect = <T>(work: () => Promise<T>): Promise<T> => QueryScopeStore.crossTenant(work);

  const ledgerBalanceOf = async (productId: string): Promise<number> => {
    const result = await inspect(() =>
      prisma.client.inventoryMovement.aggregate({
        where: { productId },
        _sum: { quantityDelta: true },
      }),
    );
    return Number(result._sum.quantityDelta);
  };

  const stockOf = async (productId: string): Promise<string> => {
    const response = await request(server())
      .get(api(`/products/${productId}`))
      .set(auth())
      .expect(200);
    return response.body.data.stockOnHand as string;
  };

  // =========================================================================

  describe('la caché de existencias no pierde escrituras', () => {
    it('suma las diez entradas simultáneas, sin perder ninguna', async () => {
      // El motor anterior fallaba justo aquí. Cada petición leía `stockOnHand`, sumaba su
      // cantidad y escribía el total; las que leían el mismo valor de partida se pisaban
      // entre sí y el almacén acababa con menos producto del que había entrado. El ledger
      // registraba las diez entradas y la caché mostraba dos o tres: la diferencia solo
      // salía a la luz en el recuento físico.
      const { id } = await createProduct();

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => receive({ productId: id, quantity: 3, unitCost: 60 })),
      );

      expect(responses.every((response) => response.status === 201)).toBe(true);
      expect(await stockOf(id)).toBe('30.000');

      // El ledger es la fuente de verdad y la caché su suma. Que coincidan es la única
      // prueba de que no se ha perdido nada por el camino.
      expect(await ledgerBalanceOf(id)).toBe(30);
    });

    it('deja que solo una de dos salidas simultáneas se lleve las últimas unidades', async () => {
      // Las dos comprueban que hay bastante y las dos ven que sí. Sin la condición dentro
      // del `UPDATE`, ambas descontarían y el stock quedaría en negativo.
      const { id } = await createProduct({ sku: 'SH-TEST-2' });
      await receive({ productId: id, quantity: 5, unitCost: 60 }).expect(201);

      const results = await Promise.all([
        consume({ productId: id, quantity: 4 }),
        consume({ productId: id, quantity: 4 }),
      ]);

      const statuses = results.map((response) => response.status).sort();
      expect(statuses).toEqual([201, 422]);
      expect(await stockOf(id)).toBe('1.000');
    });

    it('mantiene el saldo cuadrado con entradas y salidas mezcladas', async () => {
      const { id } = await createProduct({ sku: 'SH-TEST-3' });
      await receive({ productId: id, quantity: 100, unitCost: 60 }).expect(201);

      await Promise.all([
        ...Array.from({ length: 5 }, () => receive({ productId: id, quantity: 2, unitCost: 60 })),
        ...Array.from({ length: 5 }, () => consume({ productId: id, quantity: 3 })),
      ]);

      // 100 + 10 − 15
      expect(await stockOf(id)).toBe('95.000');

      expect(await ledgerBalanceOf(id)).toBe(95);
    });
  });

  // =========================================================================

  describe('las garantías no dependen de que se pase por la aplicación', () => {
    it('PostgreSQL rechaza dejar existencias negativas por SQL directo', async () => {
      const { id } = await createProduct({ sku: 'SH-TEST-4' });

      await expect(
        inspect(() =>
          prisma.client.$executeRawUnsafe(
            `UPDATE "products" SET "stockOnHand" = -1 WHERE "id" = '${id}'`,
          ),
        ),
      ).rejects.toThrow(/products_stock_not_negative/);
    });

    it('PostgreSQL impide modificar un asiento del kardex', async () => {
      // El ledger es de solo anexión (ADR-0011). Corregir un movimiento se hace anotando el
      // contrario; que la regla viva en un trigger es lo que la hace inviolable.
      const { id } = await createProduct({ sku: 'SH-TEST-5' });
      await receive({ productId: id, quantity: 5, unitCost: 60 }).expect(201);

      await expect(
        inspect(() =>
          prisma.client.$executeRawUnsafe(
            `UPDATE "inventory_movements" SET "quantityDelta" = 999 WHERE "productId" = '${id}'`,
          ),
        ),
      ).rejects.toThrow();
    });

    it('PostgreSQL impide consumir de un lote más de lo que queda', async () => {
      const { id } = await createProduct({ sku: 'TINTE-1', tracksBatches: true });
      await receive({
        productId: id,
        quantity: 4,
        unitCost: 50,
        batchNumber: 'L-001',
      }).expect(201);

      await expect(
        inspect(() =>
          prisma.client.$executeRawUnsafe(
            `UPDATE "product_batches" SET "remainingQuantity" = -1 WHERE "productId" = '${id}'`,
          ),
        ),
      ).rejects.toThrow(/product_batches_quantities_valid/);
    });
  });

  // =========================================================================

  describe('reparto FEFO', () => {
    /** Producto trazado por lote con tres entradas de caducidad distinta. */
    const seedThreeBatches = async (): Promise<string> => {
      const { id } = await createProduct({ sku: 'TINTE-6.0', tracksBatches: true, price: 180 });

      // Se reciben en orden inverso al de caducidad a propósito: FIFO consumiría primero
      // el que llegó antes y dejaría caducar el otro en la estantería.
      await receive({
        productId: id,
        quantity: 10,
        unitCost: 70,
        batchNumber: 'L-JUNIO',
        expiresAt: isoDay(180),
      }).expect(201);

      await receive({
        productId: id,
        quantity: 10,
        unitCost: 50,
        batchNumber: 'L-MARZO',
        expiresAt: isoDay(30),
      }).expect(201);

      await receive({
        productId: id,
        quantity: 10,
        unitCost: 90,
        batchNumber: 'L-SIN-CADUCIDAD',
      }).expect(201);

      return id;
    };

    it('consume primero el lote que caduca antes, no el que llegó antes', async () => {
      const id = await seedThreeBatches();

      await consume({ productId: id, quantity: 4 }).expect(201);

      const batches = await inspect(() =>
        prisma.client.productBatch.findMany({
          where: { productId: id },
          orderBy: { batchNumber: 'asc' },
        }),
      );

      expect(
        batches.map((batch) => [batch.batchNumber, batch.remainingQuantity.toFixed(3)]),
      ).toEqual([
        ['L-JUNIO', '10.000'],
        ['L-MARZO', '6.000'],
        ['L-SIN-CADUCIDAD', '10.000'],
      ]);
    });

    it('encadena lotes y deja el que no caduca para el final', async () => {
      const id = await seedThreeBatches();

      const response = await consume({ productId: id, quantity: 25 }).expect(201);

      expect(response.body.data.movements).toHaveLength(3);
      expect(await stockOf(id)).toBe('5.000');

      const remaining = await inspect(() =>
        prisma.client.productBatch.findMany({
          where: { productId: id, remainingQuantity: { gt: 0 } },
        }),
      );
      expect(remaining.map((batch) => batch.batchNumber)).toEqual(['L-SIN-CADUCIDAD']);
    });

    it('valora la salida al coste real de cada lote', async () => {
      // 10 unidades a 50,00 más 5 a 70,00 son 850,00 exactos. Una media global daría otra
      // cifra y el margen del servicio dejaría de ser el real (ADR-0012).
      const id = await seedThreeBatches();

      const response = await consume({ productId: id, quantity: 15 }).expect(201);

      expect(response.body.data.totalCost).toBe('850.00');
      expect(response.body.data.currency).toBe('GTQ');
    });

    it('anota un asiento por lote, con su lote identificado', async () => {
      // Es lo que permite responder «qué lote se le aplicó a esta clienta» ante una
      // reacción, que exige el Reglamento (CE) 1223/2009.
      const id = await seedThreeBatches();
      await consume({ productId: id, quantity: 15 }).expect(201);

      const kardex = await request(server())
        .get(api('/inventory/kardex'))
        .query({ productId: id })
        .set(auth())
        .expect(200);

      const salidas = (
        kardex.body.data as { quantityDelta: string; batch: { batchNumber: string } | null }[]
      ).filter((entry) => Number(entry.quantityDelta) < 0);

      expect(salidas.map((entry) => entry.batch?.batchNumber)).toEqual(['L-JUNIO', 'L-MARZO']);
      expect(salidas.every((entry) => entry.batch !== null)).toBe(true);
    });

    it('bloquea el consumo de un lote caducado y explica por qué', async () => {
      const { id } = await createProduct({ sku: 'TINTE-VENC', tracksBatches: true });

      // Se recibe con caducidad futura —recibir mercancía vencida se rechaza en el
      // muelle— y se envejece por SQL, que es la única forma de simular el paso del tiempo.
      await receive({
        productId: id,
        quantity: 10,
        unitCost: 50,
        batchNumber: 'L-VIEJO',
        expiresAt: isoDay(10),
      }).expect(201);

      await inspect(() =>
        prisma.client.$executeRawUnsafe(
          `UPDATE "product_batches" SET "expiresAt" = CURRENT_DATE - 1 WHERE "productId" = '${id}'`,
        ),
      );

      const response = await consume({ productId: id, quantity: 2 }).expect(422);

      expect(response.body.detail).toMatch(/caducados/);
      expect(await stockOf(id)).toBe('10.000');
    });

    it('exige número de lote al recibir un producto trazado', async () => {
      const { id } = await createProduct({ sku: 'TINTE-TRZ', tracksBatches: true });

      const response = await receive({ productId: id, quantity: 5, unitCost: 50 }).expect(422);

      expect(response.body.detail).toMatch(/número impreso/);
    });

    it('amplía el lote existente cuando la entrega llega partida', async () => {
      const { id } = await createProduct({ sku: 'TINTE-PART', tracksBatches: true });
      const expiresAt = isoDay(120);

      await receive({
        productId: id,
        quantity: 6,
        unitCost: 50,
        batchNumber: 'L-777',
        expiresAt,
      }).expect(201);
      await receive({
        productId: id,
        quantity: 4,
        unitCost: 50,
        batchNumber: 'L-777',
        expiresAt,
      }).expect(201);

      const batches = await inspect(() =>
        prisma.client.productBatch.findMany({ where: { productId: id } }),
      );

      expect(batches).toHaveLength(1);
      expect(batches[0].initialQuantity.toFixed(3)).toBe('10.000');
      expect(await stockOf(id)).toBe('10.000');
    });

    it('rechaza reutilizar un número de lote con otro coste', async () => {
      const { id } = await createProduct({ sku: 'TINTE-DUP', tracksBatches: true });
      await receive({
        productId: id,
        quantity: 6,
        unitCost: 50,
        batchNumber: 'L-888',
      }).expect(201);

      const response = await receive({
        productId: id,
        quantity: 4,
        unitCost: 65,
        batchNumber: 'L-888',
      }).expect(409);

      expect(response.body.detail).toMatch(/coste/);
    });
  });

  // =========================================================================

  describe('coste medio y exactitud monetaria', () => {
    it('recalcula la media ponderando con las existencias previas', async () => {
      const { id } = await createProduct({ sku: 'SH-MEDIA', price: 200, costPrice: 0 });

      await receive({ productId: id, quantity: 10, unitCost: 60 }).expect(201);
      await receive({ productId: id, quantity: 10, unitCost: 80 }).expect(201);

      const response = await request(server())
        .get(api(`/products/${id}`))
        .set(auth())
        .expect(200);

      expect(response.body.data.costPrice).toBe('70.00');
      expect(response.body.data.stockValue).toBe('1400.00');
    });

    it('conserva los céntimos exactos en el viaje de ida y vuelta', async () => {
      // El importe pasa por `numeric` de PostgreSQL, `Decimal` de Prisma, `Money` del
      // dominio y una cadena JSON. Un solo `Number()` por el camino lo convertiría en
      // 12.129999999999999 (ADR-0010).
      const { id } = await createProduct({ sku: 'SH-CENT', price: 12.13, costPrice: 7.07 });

      const response = await request(server())
        .get(api(`/products/${id}`))
        .set(auth())
        .expect(200);

      expect(response.body.data.price).toBe('12.13');
      expect(response.body.data.costPrice).toBe('7.07');
      expect(typeof response.body.data.price).toBe('string');
    });

    it('oculta el coste a quien no tiene permiso para verlo', async () => {
      // Se omite el campo en lugar de ponerlo a `null`: un `null` afirma que no hay coste,
      // y lo cierto es que quien pregunta no puede verlo.
      const { id } = await createProduct({ sku: 'SH-PERM', costPrice: 42 });

      const login = await request(server())
        .post(api('/auth/login'))
        .send({ email: salonA.stylistEmail, password: TEST_PASSWORD })
        .expect(200);

      const response = await request(server())
        .get(api('/products'))
        .set({ Authorization: `Bearer ${login.body.data.accessToken}` })
        .expect(200);

      const product = (response.body.data as { id: string }[]).find((item) => item.id === id);
      expect(product).toBeDefined();
      expect(product).not.toHaveProperty('costPrice');
    });
  });

  // =========================================================================

  describe('ajustes y avisos', () => {
    it('reparte por FEFO la merma que no indica lote', async () => {
      const { id } = await createProduct({ sku: 'TINTE-MERMA', tracksBatches: true });
      await receive({
        productId: id,
        quantity: 5,
        unitCost: 50,
        batchNumber: 'L-PRONTO',
        expiresAt: isoDay(15),
      }).expect(201);
      await receive({
        productId: id,
        quantity: 5,
        unitCost: 50,
        batchNumber: 'L-TARDE',
        expiresAt: isoDay(200),
      }).expect(201);

      await request(server())
        .post(api('/inventory/adjust'))
        .set(auth())
        .send({ productId: id, quantityDelta: -7, reason: 'Recuento de marzo' })
        .expect(201);

      const batches = await inspect(() =>
        prisma.client.productBatch.findMany({
          where: { productId: id },
          orderBy: { batchNumber: 'asc' },
        }),
      );

      expect(
        batches.map((batch) => [batch.batchNumber, batch.remainingQuantity.toFixed(3)]),
      ).toEqual([
        ['L-PRONTO', '0.000'],
        ['L-TARDE', '3.000'],
      ]);
    });

    it('rechaza el ajuste que dejaría existencias negativas', async () => {
      const { id } = await createProduct({ sku: 'SH-AJUSTE' });
      await receive({ productId: id, quantity: 2, unitCost: 60 }).expect(201);

      await request(server())
        .post(api('/inventory/adjust'))
        .set(auth())
        .send({ productId: id, quantityDelta: -5, reason: 'Recuento' })
        .expect(422);

      expect(await stockOf(id)).toBe('2.000');
    });

    it('avisa de lo que hay que pedir y de lo que va a caducar', async () => {
      const { id } = await createProduct({
        sku: 'TINTE-AVISO',
        tracksBatches: true,
        reorderPoint: 20,
        reorderQuantity: 24,
      });
      await receive({
        productId: id,
        quantity: 5,
        unitCost: 50,
        batchNumber: 'L-CADUCA',
        expiresAt: isoDay(10),
      }).expect(201);

      const response = await request(server())
        .get(api('/inventory/alerts'))
        .query({ withinDays: 30 })
        .set(auth())
        .expect(200);

      const reorder = (
        response.body.data.reorder as { sku: string; missing: string; suggestedOrder: string }[]
      ).find((item) => item.sku === 'TINTE-AVISO');

      expect(reorder).toMatchObject({ missing: '15.000', suggestedOrder: '24.000' });
      expect(
        (response.body.data.expiring as { batchNumber: string }[]).map((b) => b.batchNumber),
      ).toContain('L-CADUCA');
    });

    it('filtra el catálogo por semáforo de existencias en la propia base', async () => {
      // El motor anterior se traía la tabla entera y la filtraba en JavaScript, de modo que
      // la pantalla se volvía más lenta con cada alta y los totales de paginación no
      // correspondían con lo que se veía.
      const bajo = await createProduct({ sku: 'SH-BAJO', reorderPoint: 10 });
      const sobra = await createProduct({ sku: 'SH-SOBRA', reorderPoint: 10 });
      await createProduct({ sku: 'SH-CERO' });

      await receive({ productId: bajo.id, quantity: 4, unitCost: 60 }).expect(201);
      await receive({ productId: sobra.id, quantity: 40, unitCost: 60 }).expect(201);

      const low = await request(server())
        .get(api('/products'))
        .query({ stock: 'low' })
        .set(auth())
        .expect(200);

      expect((low.body.data as { sku: string }[]).map((p) => p.sku)).toEqual(['SH-BAJO']);
      expect(low.body.meta.total).toBe(1);

      const out = await request(server())
        .get(api('/products'))
        .query({ stock: 'out' })
        .set(auth())
        .expect(200);

      expect((out.body.data as { sku: string }[]).map((p) => p.sku)).toContain('SH-CERO');
    });
  });

  // =========================================================================

  describe('el contrato que consume la interfaz', () => {
    /**
     * Estos tres tests fijan por escrito la forma exacta que lee `apps/web`.
     *
     * Toda la reconciliacion se hizo bajo una premisa —«se cambia el motor y el frontend no
     * se entera»— y una premisa que nadie comprueba dura hasta el primer refactor. Aqui los
     * campos se nombran uno a uno a proposito: un `toMatchObject` laxo pasaria aunque
     * alguien renombrase `stockStatus`, y la pantalla de inventario se quedaria en blanco
     * sin que ningun test se quejara.
     */
    it('devuelve el producto con los campos que pinta el tablero de inventario', async () => {
      const { id } = await createProduct({
        sku: 'SH-CONTRATO',
        name: 'Champú de contrato',
        brand: 'Marca',
        price: 120,
        costPrice: 60,
        reorderPoint: 5,
        reorderQuantity: 12,
      });
      await receive({ productId: id, quantity: 3, unitCost: 60 }).expect(201);

      const response = await request(server()).get(api('/products')).set(auth()).expect(200);
      const product = (response.body.data as Record<string, unknown>[]).find(
        (item) => item.id === id,
      )!;

      // `InventoryBoard` lee exactamente estos campos, y las cantidades e importes como
      // cadena: los convierte con `Number()` al pintarlos.
      expect(product).toMatchObject({
        id,
        sku: 'SH-CONTRATO',
        name: 'Champú de contrato',
        brand: 'Marca',
        price: '120.00',
        costPrice: '60.00',
        currency: 'GTQ',
        stockOnHand: '3.000',
        reorderPoint: '5.000',
        reorderQuantity: '12.000',
        stockStatus: 'LOW',
      });
    });

    it('devuelve el kardex con el producto y el lote anidados', async () => {
      const { id } = await createProduct({ sku: 'SH-KARDEX', tracksBatches: true });
      await receive({
        productId: id,
        quantity: 4,
        unitCost: 50,
        batchNumber: 'L-CONTRATO',
      }).expect(201);

      const response = await request(server())
        .get(api('/inventory/kardex'))
        .query({ productId: id })
        .set(auth())
        .expect(200);

      const entry = response.body.data[0] as Record<string, unknown>;

      expect(entry).toMatchObject({
        type: 'PURCHASE_IN',
        quantityDelta: '4.000',
        balanceAfter: '4.000',
        product: { sku: 'SH-KARDEX', name: 'Champú de prueba' },
        batch: { batchNumber: 'L-CONTRATO' },
      });
      expect(typeof entry.occurredAt).toBe('string');
      expect(entry).toHaveProperty('reason');
    });

    it('devuelve los lotes con su producto anidado', async () => {
      const { id } = await createProduct({ sku: 'SH-LOTES', tracksBatches: true });
      await receive({
        productId: id,
        quantity: 4,
        unitCost: 50,
        batchNumber: 'L-VISIBLE',
        expiresAt: isoDay(90),
      }).expect(201);

      const response = await request(server())
        .get(api('/inventory/batches'))
        .query({ productId: id })
        .set(auth())
        .expect(200);

      expect(response.body.data[0]).toMatchObject({
        batchNumber: 'L-VISIBLE',
        remainingQuantity: '4.000',
        unitCost: '50.00',
        product: { sku: 'SH-LOTES', name: 'Champú de prueba' },
      });
      expect(response.body.data[0].expiresAt).toEqual(expect.any(String));
    });
  });

  // =========================================================================

  describe('baja de producto', () => {
    it('impide dar de baja lo que aún está en la estantería', async () => {
      const { id } = await createProduct({ sku: 'SH-BAJA' });
      await receive({ productId: id, quantity: 3, unitCost: 60 }).expect(201);

      const response = await request(server())
        .delete(api(`/products/${id}`))
        .set(auth())
        .expect(422);

      expect(response.body.detail).toMatch(/quedan 3 unidades/);
    });

    it('permite darlo de baja y recuperarlo después', async () => {
      const { id } = await createProduct({ sku: 'SH-BAJA-OK' });

      await request(server())
        .delete(api(`/products/${id}`))
        .set(auth())
        .expect(204);
      await request(server())
        .get(api(`/products/${id}`))
        .set(auth())
        .expect(404);

      const restored = await request(server())
        .post(api(`/products/${id}/restore`))
        .set(auth())
        .expect(201);

      expect(restored.body.data.isActive).toBe(true);
    });

    it('deja reutilizar el SKU de un producto dado de baja avisando de que existe', async () => {
      const { id } = await createProduct({ sku: 'SH-REUSO' });
      await request(server())
        .delete(api(`/products/${id}`))
        .set(auth())
        .expect(204);

      const response = await request(server())
        .post(api('/products'))
        .set(auth())
        .send({ sku: 'SH-REUSO', name: 'Otro champú', price: 90 })
        .expect(409);

      expect(response.body.detail).toMatch(/Recupérelo/);
    });
  });
});
