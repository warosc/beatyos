import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';

import { api, createTestApp, resetDatabase } from './app-harness';
import { seedTwoTenants, TEST_PASSWORD, type SeededTenant } from './fixtures';

/**
 * Proveedores y compras, de extremo a extremo.
 *
 * Este módulo se quedó sin pruebas mientras el resto del negocio las tenía, y no por
 * casualidad: es un servicio plano que habla con Prisma directamente, así que no hay
 * puertos que doblar y la suite unitaria no puede alcanzarlo. Mientras siga así, la
 * integración es el único sitio donde su lógica se puede afirmar.
 *
 * El foco está en lo que estuvo mal calculado durante toda la vida del módulo: los totales
 * se hacían con `number` y se guardaban con `.toFixed(2)`, de modo que una línea con
 * cantidad fraccionaria arrastraba el error binario hasta el importe que el proveedor
 * acaba cobrando. Varios de estos tests fallan contra aquella implementación.
 */

describe('Compras (integración)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let salonA: SeededTenant;
  let salonB: SeededTenant;
  let token: string;
  let tokenB: string;

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
    ({ salonA, salonB } = await seedTwoTenants(prisma));

    const login = await request(app.getHttpServer())
      .post(api('/auth/login'))
      .send({ email: salonA.ownerEmail, password: TEST_PASSWORD })
      .expect(200);

    token = login.body.data.accessToken as string;

    const loginB = await request(app.getHttpServer())
      .post(api('/auth/login'))
      .send({ email: salonB.ownerEmail, password: TEST_PASSWORD })
      .expect(200);

    tokenB = loginB.body.data.accessToken as string;
  });

  it('el listado conserva tracksBatches para recibir una compra desde la interfaz', async () => {
    const productId = await createProduct({ tracksBatches: true });
    const supplierId = await createSupplier();
    await createOrder({ supplierId, lines: [{ productId, quantity: 0.3, unitCost: 10 }] }).expect(
      201,
    );
    const response = await request(server()).get(api('/purchases')).set(auth()).expect(200);
    expect(response.body.data[0].lines[0].product.tracksBatches).toBe(true);
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => app.getHttpServer();

  const createSupplier = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const response = await request(server())
      .post(api('/suppliers'))
      .set(auth())
      .send({ code: 'PROV-1', name: 'Distribuciones de prueba', ...overrides })
      .expect(201);
    return response.body.data.id as string;
  };

  const createProduct = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const response = await request(server())
      .post(api('/products'))
      .set(auth())
      .send({ sku: 'CMP-1', name: 'Producto de compra', price: 100, ...overrides })
      .expect(201);
    return response.body.data.id as string;
  };

  const createOrder = (body: Record<string, unknown>) =>
    request(server()).post(api('/purchases')).set(auth()).send(body);

  const stockOf = async (productId: string): Promise<number> => {
    const response = await request(server())
      .get(api(`/products/${productId}`))
      .set(auth())
      .expect(200);
    return Number(response.body.data.stockOnHand);
  };

  /** Deja un pedido enviado y listo para recibir, que es el estado que exige `receive`. */
  const submittedOrder = async (
    lines: Array<Record<string, unknown>>,
  ): Promise<Record<string, never> & { id: string; lines: Array<{ id: string }> }> => {
    const supplierId = await createSupplier();
    const created = await createOrder({ supplierId, lines }).expect(201);
    const id = created.body.data.id as string;
    const submitted = await request(server())
      .post(api(`/purchases/${id}/submit`))
      .set(auth())
      .expect(201);
    return submitted.body.data;
  };

  // =========================================================================

  describe('los totales se calculan con Money, no con coma flotante', () => {
    it('suma una línea fraccionaria sin desviar un céntimo', async () => {
      const supplierId = await createSupplier();
      const productId = await createProduct({ taxRate: 12 });

      const response = await createOrder({
        supplierId,
        lines: [
          // 3 × 10,10 = 30,30 · IVA 12 % = 3,636 → 3,64 · línea 33,94
          { productId, quantity: 3, unitCost: 10.1 },
          // 2,5 × 4,05 = 10,125 → 10,13 (half-up) · IVA 12 % de 10,13 = 1,2156 → 1,22
          { productId, quantity: 2.5, unitCost: 4.05 },
        ],
      }).expect(201);

      const order = response.body.data;

      // Con la implementación anterior la segunda línea daba 11,34 y el subtotal del
      // pedido salía de sumar flotantes: 40,425, que `.toFixed(2)` truncaba a 40,42.
      expect(Number(order.lines[1].lineTotal)).toBe(11.35);
      expect(Number(order.subtotal)).toBe(40.43);
      expect(Number(order.taxTotal)).toBe(4.86);
      expect(Number(order.total)).toBe(45.29);
    });

    it('mantiene la identidad subtotal + impuestos = total', async () => {
      const supplierId = await createSupplier();
      const productId = await createProduct({ taxRate: 12 });

      const response = await createOrder({
        supplierId,
        lines: Array.from({ length: 7 }, () => ({ productId, quantity: 1.333, unitCost: 3.33 })),
      }).expect(201);

      const order = response.body.data;
      expect(Number(order.subtotal) + Number(order.taxTotal)).toBeCloseTo(Number(order.total), 10);
    });

    it('guarda los importes con dos decimales exactos', async () => {
      const supplierId = await createSupplier();
      const productId = await createProduct();

      const response = await createOrder({
        supplierId,
        lines: [{ productId, quantity: 1, unitCost: 9.99 }],
      }).expect(201);

      // La cadena que cruza la frontera JSON no debe arrastrar cola binaria (ADR-0010).
      expect(String(response.body.data.total)).toMatch(/^\d+\.\d{2}$/);
    });
  });

  describe('el tipo impositivo', () => {
    it('sale del producto cuando la línea no lo declara', async () => {
      const supplierId = await createSupplier();
      const productId = await createProduct({ taxRate: 5 });

      const response = await createOrder({
        supplierId,
        lines: [{ productId, quantity: 2, unitCost: 50 }],
      }).expect(201);

      // Antes se escribía un 12 fijo aquí, con lo que un producto exento o con tipo
      // reducido acababa facturado al tipo general.
      expect(Number(response.body.data.lines[0].taxRate)).toBe(5);
      expect(Number(response.body.data.taxTotal)).toBe(5);
      expect(Number(response.body.data.total)).toBe(105);
    });

    it('respeta el que la línea declara explícitamente', async () => {
      const supplierId = await createSupplier();
      const productId = await createProduct({ taxRate: 12 });

      const response = await createOrder({
        supplierId,
        lines: [{ productId, quantity: 1, unitCost: 100, taxRate: 0 }],
      }).expect(201);

      expect(Number(response.body.data.taxTotal)).toBe(0);
      expect(Number(response.body.data.total)).toBe(100);
    });
  });

  describe('recepción de mercancía', () => {
    it('deja el pedido parcialmente recibido y da entrada al stock', async () => {
      const productId = await createProduct();
      const order = await submittedOrder([{ productId, quantity: 10, unitCost: 5 }]);

      const response = await request(server())
        .post(api(`/purchases/${order.id}/receive`))
        .set(auth())
        .send({ lines: [{ lineId: order.lines[0].id, quantity: 4 }] })
        .expect(201);

      expect(response.body.data.status).toBe('PARTIALLY_RECEIVED');
      expect(Number(response.body.data.lines[0].receivedQuantity)).toBe(4);
      // La entrada la hace el motor de inventario, no este módulo: si esto falla, la
      // delegación en `ReceiveStockUseCase` se ha roto.
      expect(await stockOf(productId)).toBe(4);
    });

    it('lo cierra cuando se completa la última unidad pendiente', async () => {
      const productId = await createProduct();
      const order = await submittedOrder([{ productId, quantity: 10, unitCost: 5 }]);
      const lineId = order.lines[0].id;

      await request(server())
        .post(api(`/purchases/${order.id}/receive`))
        .set(auth())
        .send({ lines: [{ lineId, quantity: 6 }] })
        .expect(201);

      const response = await request(server())
        .post(api(`/purchases/${order.id}/receive`))
        .set(auth())
        .send({ lines: [{ lineId, quantity: 4 }] })
        .expect(201);

      expect(response.body.data.status).toBe('RECEIVED');
      expect(response.body.data.receivedAt).not.toBeNull();
      expect(await stockOf(productId)).toBe(10);
    });

    it('admite completar una cantidad fraccionaria pendiente', async () => {
      const productId = await createProduct();
      const order = await submittedOrder([{ productId, quantity: 0.3, unitCost: 12 }]);
      const lineId = order.lines[0].id;

      await request(server())
        .post(api(`/purchases/${order.id}/receive`))
        .set(auth())
        .send({ lines: [{ lineId, quantity: 0.1 }] })
        .expect(201);

      // 0,3 − 0,1 da 0,19999999999999998 en coma flotante, y comparar eso con 0,2
      // rechazaba una recepción perfectamente válida con INVALID_RECEIPT_QUANTITY.
      const response = await request(server())
        .post(api(`/purchases/${order.id}/receive`))
        .set(auth())
        .send({ lines: [{ lineId, quantity: 0.2 }] })
        .expect(201);

      expect(response.body.data.status).toBe('RECEIVED');
    });

    it('rechaza recibir más de lo pendiente', async () => {
      const productId = await createProduct();
      const order = await submittedOrder([{ productId, quantity: 2, unitCost: 5 }]);

      const response = await request(server())
        .post(api(`/purchases/${order.id}/receive`))
        .set(auth())
        .send({ lines: [{ lineId: order.lines[0].id, quantity: 3 }] })
        .expect(422);

      expect(response.body.detail).toContain('supera el pendiente');
      expect(await stockOf(productId)).toBe(0);
    });

    it('no admite recepción sobre un pedido en borrador', async () => {
      const supplierId = await createSupplier();
      const productId = await createProduct();
      const created = await createOrder({
        supplierId,
        lines: [{ productId, quantity: 1, unitCost: 5 }],
      }).expect(201);

      await request(server())
        .post(api(`/purchases/${created.body.data.id}/receive`))
        .set(auth())
        .send({ lines: [{ lineId: created.body.data.lines[0].id, quantity: 1 }] })
        .expect(422);
    });
  });

  describe('proveedores', () => {
    it('pagina el listado y devuelve metadatos sin cambiar el arreglo data', async () => {
      await createSupplier({ code: 'PAG-1', name: 'Proveedor A' });
      await createSupplier({ code: 'PAG-2', name: 'Proveedor B' });
      await createSupplier({ code: 'PAG-3', name: 'Proveedor C' });

      const first = await request(server())
        .get(api('/suppliers?page=1&limit=2'))
        .set(auth())
        .expect(200);
      const second = await request(server())
        .get(api('/suppliers?page=2&limit=2'))
        .set(auth())
        .expect(200);

      expect(first.body.data).toHaveLength(2);
      expect(first.body.meta).toMatchObject({
        page: 1,
        limit: 2,
        total: 3,
        totalPages: 2,
        hasNext: true,
        hasPrevious: false,
      });
      expect(second.body.data).toHaveLength(1);
      expect(second.body.meta).toMatchObject({ hasNext: false, hasPrevious: true });
    });

    it('aplica los valores por defecto del esquema al crear', async () => {
      const response = await request(server())
        .post(api('/suppliers'))
        .set(auth())
        .send({ code: 'PROV-9', name: 'Sin condiciones pactadas' })
        .expect(201);

      // Ya no se escriben en el servicio: los declara el esquema y aquí se comprueba que
      // efectivamente llegan, que es lo que justifica haberlos quitado del código.
      expect(response.body.data.country).toBe('GT');
      expect(response.body.data.paymentTermDays).toBe(30);
      expect(response.body.data.status).toBe('ACTIVE');
    });

    it('respeta el plazo de pago cuando se indica', async () => {
      const response = await request(server())
        .post(api('/suppliers'))
        .set(auth())
        .send({ code: 'PROV-10', name: 'A sesenta días', paymentTermDays: 60 })
        .expect(201);

      expect(response.body.data.paymentTermDays).toBe(60);
    });

    it('busca por nombre y por código', async () => {
      await createSupplier({ code: 'AAA-1', name: 'Química del Norte' });
      await createSupplier({ code: 'BBB-2', name: 'Tintes del Sur' });

      const porNombre = await request(server())
        .get(api('/suppliers?search=norte'))
        .set(auth())
        .expect(200);
      expect(porNombre.body.data).toHaveLength(1);

      const porCodigo = await request(server())
        .get(api('/suppliers?search=BBB'))
        .set(auth())
        .expect(200);
      expect(porCodigo.body.data).toHaveLength(1);
    });

    it('actualiza los datos de contacto', async () => {
      const id = await createSupplier();

      const response = await request(server())
        .patch(api(`/suppliers/${id}`))
        .set(auth())
        .send({ contactName: 'Rosa Méndez', email: 'rosa@proveedor.test' })
        .expect(200);

      expect(response.body.data.contactName).toBe('Rosa Méndez');
      expect(response.body.data.name).toBe('Distribuciones de prueba');
    });

    it('da de baja y restaura, y el restaurado vuelve activo', async () => {
      const id = await createSupplier();
      await request(server())
        .delete(api(`/suppliers/${id}`))
        .set(auth())
        .expect(200);

      const listado = await request(server()).get(api('/suppliers')).set(auth()).expect(200);
      expect(listado.body.data).toHaveLength(0);

      const restaurado = await request(server())
        .post(api(`/suppliers/${id}/restore`))
        .set(auth())
        .expect(201);
      expect(restaurado.body.data.status).toBe('ACTIVE');
    });

    it('devuelve 404 al actualizar o restaurar uno inexistente', async () => {
      const fantasma = '11111111-1111-7111-8111-999999999999';

      await request(server())
        .patch(api(`/suppliers/${fantasma}`))
        .set(auth())
        .send({ name: 'Da igual' })
        .expect(404);
      await request(server())
        .delete(api(`/suppliers/${fantasma}`))
        .set(auth())
        .expect(404);
    });
  });

  describe('reglas del pedido', () => {
    it('pagina y ordena los pedidos por número', async () => {
      const productId = await createProduct();
      const supplierId = await createSupplier();
      const lines = [{ productId, quantity: 1, unitCost: 5 }];
      await createOrder({ supplierId, lines }).expect(201);
      await createOrder({ supplierId, lines }).expect(201);
      await createOrder({ supplierId, lines }).expect(201);

      const response = await request(server())
        .get(api('/purchases?page=1&limit=2&sort=number:asc'))
        .set(auth())
        .expect(200);

      expect(response.body.data).toHaveLength(2);
      expect(response.body.data[0].number).toMatch(/000001$/);
      expect(response.body.data[1].number).toMatch(/000002$/);
      expect(response.body.meta).toMatchObject({ total: 3, totalPages: 2, hasNext: true });
    });

    it('exige un proveedor activo', async () => {
      const supplierId = await createSupplier();
      const productId = await createProduct();
      await request(server())
        .delete(api(`/suppliers/${supplierId}`))
        .set(auth())
        .expect(200);

      await createOrder({
        supplierId,
        lines: [{ productId, quantity: 1, unitCost: 5 }],
      }).expect(404);
    });

    it('rechaza un producto inexistente', async () => {
      const supplierId = await createSupplier();

      await createOrder({
        supplierId,
        lines: [{ productId: salonA.clientId, quantity: 1, unitCost: 5 }],
      }).expect(404);
    });

    it('numera los pedidos de forma correlativa dentro del año', async () => {
      const supplierId = await createSupplier();
      const productId = await createProduct();
      const line = [{ productId, quantity: 1, unitCost: 5 }];

      const first = await createOrder({ supplierId, lines: line }).expect(201);
      const second = await createOrder({ supplierId, lines: line }).expect(201);

      const year = new Date().getFullYear();
      expect(first.body.data.number).toBe(`OC-${year}-000001`);
      expect(second.body.data.number).toBe(`OC-${year}-000002`);
    });

    it('no deja cancelar un pedido ya recibido', async () => {
      const productId = await createProduct();
      const order = await submittedOrder([{ productId, quantity: 1, unitCost: 5 }]);
      await request(server())
        .post(api(`/purchases/${order.id}/receive`))
        .set(auth())
        .send({ lines: [{ lineId: order.lines[0].id, quantity: 1 }] })
        .expect(201);

      await request(server())
        .post(api(`/purchases/${order.id}/cancel`))
        .set(auth())
        .send({ reason: 'Ya no hace falta' })
        .expect(422);
    });
  });

  // =========================================================================

  describe('aislamiento entre salones', () => {
    const authB = () => ({ Authorization: 'Bearer ' + tokenB });

    it('un salon no ve los proveedores del otro', async () => {
      await createSupplier({ code: 'SOLO-A', name: 'Proveedor del salon A' });

      const ajeno = await request(server()).get(api('/suppliers')).set(authB()).expect(200);
      expect(ajeno.body.data).toHaveLength(0);
    });

    it('un salon no ve los pedidos del otro', async () => {
      const productId = await createProduct();
      const supplierId = await createSupplier();
      await createOrder({
        supplierId,
        lines: [{ productId, quantity: 1, unitCost: 5 }],
      }).expect(201);

      const ajeno = await request(server()).get(api('/purchases')).set(authB()).expect(200);
      expect(ajeno.body.data).toHaveLength(0);
    });

    it('pedir por id un pedido de otro salon devuelve 404, no 403', async () => {
      const productId = await createProduct();
      const supplierId = await createSupplier();
      const created = await createOrder({
        supplierId,
        lines: [{ productId, quantity: 1, unitCost: 5 }],
      }).expect(201);

      // Un 403 confirmaria que el pedido existe, que ya es una fuga (ADR-0008).
      await request(server())
        .get(api('/purchases/' + created.body.data.id))
        .set(authB())
        .expect(404);
    });

    it('no se puede pedir a un proveedor de otro salon', async () => {
      const supplierId = await createSupplier();

      const productoB = await request(server())
        .post(api('/products'))
        .set(authB())
        .send({ sku: 'B-1', name: 'Producto del salon B', price: 10 })
        .expect(201);

      await request(server())
        .post(api('/purchases'))
        .set(authB())
        .send({
          supplierId,
          lines: [{ productId: productoB.body.data.id, quantity: 1, unitCost: 5 }],
        })
        .expect(404);
    });

    it('no se puede recibir mercancia de un pedido de otro salon', async () => {
      const productId = await createProduct();
      const order = await submittedOrder([{ productId, quantity: 5, unitCost: 5 }]);

      await request(server())
        .post(api('/purchases/' + order.id + '/receive'))
        .set(authB())
        .send({ lines: [{ lineId: order.lines[0].id, quantity: 1 }] })
        .expect(422);

      // Y sobre todo: el stock del salon A no se ha movido.
      expect(await stockOf(productId)).toBe(0);
    });

    it('cada salon numera su propia serie desde el uno', async () => {
      const productId = await createProduct();
      const supplierId = await createSupplier();
      await createOrder({
        supplierId,
        lines: [{ productId, quantity: 1, unitCost: 5 }],
      }).expect(201);

      const supplierB = await request(server())
        .post(api('/suppliers'))
        .set(authB())
        .send({ code: 'PROV-B', name: 'Proveedor del salon B' })
        .expect(201);
      const productoB = await request(server())
        .post(api('/products'))
        .set(authB())
        .send({ sku: 'B-2', name: 'Otro producto', price: 10 })
        .expect(201);

      const pedidoB = await request(server())
        .post(api('/purchases'))
        .set(authB())
        .send({
          supplierId: supplierB.body.data.id,
          lines: [{ productId: productoB.body.data.id, quantity: 1, unitCost: 5 }],
        })
        .expect(201);

      const year = new Date().getFullYear();
      expect(pedidoB.body.data.number).toBe('OC-' + year + '-000001');
    });
  });

  // =========================================================================

  describe('atomicidad', () => {
    /**
     * La recepcion escribe en dos sitios: el inventario y la linea del pedido. Si la
     * segunda linea de una misma peticion es invalida, la entrada de la primera tiene que
     * deshacerse: un almacen con unidades que ningun documento explica es peor que una
     * recepcion rechazada.
     */
    it('revierte la entrada de inventario cuando una linea posterior es invalida', async () => {
      const primero = await createProduct({ sku: 'ROLL-1', name: 'Primero' });
      const segundo = await createProduct({ sku: 'ROLL-2', name: 'Segundo' });
      const order = await submittedOrder([
        { productId: primero, quantity: 5, unitCost: 3 },
        { productId: segundo, quantity: 5, unitCost: 3 },
      ]);

      await request(server())
        .post(api('/purchases/' + order.id + '/receive'))
        .set(auth())
        .send({
          lines: [
            { lineId: order.lines[0].id, quantity: 5 },
            { lineId: order.lines[1].id, quantity: 99 },
          ],
        })
        .expect(422);

      expect(await stockOf(primero)).toBe(0);
      expect(await stockOf(segundo)).toBe(0);

      const sinTocar = await request(server())
        .get(api('/purchases/' + order.id))
        .set(auth())
        .expect(200);
      expect(sinTocar.body.data.status).toBe('SUBMITTED');
      expect(Number(sinTocar.body.data.lines[0].receivedQuantity)).toBe(0);
    });
  });

  // =========================================================================

  describe('concurrencia', () => {
    it('cierra la orden cuando dos recepciones simultáneas completan líneas distintas', async () => {
      const primero = await createProduct({ sku: 'CONC-1', name: 'Primero concurrente' });
      const segundo = await createProduct({ sku: 'CONC-2', name: 'Segundo concurrente' });
      const order = await submittedOrder([
        { productId: primero, quantity: 1, unitCost: 3 },
        { productId: segundo, quantity: 1, unitCost: 4 },
      ]);

      const responses = await Promise.all(
        order.lines.map((line) =>
          request(server())
            .post(api('/purchases/' + order.id + '/receive'))
            .set(auth())
            .send({ lines: [{ lineId: line.id, quantity: 1 }] }),
        ),
      );

      expect(responses.map((response) => response.status)).toEqual([201, 201]);

      const final = await request(server())
        .get(api('/purchases/' + order.id))
        .set(auth())
        .expect(200);
      expect(final.body.data.status).toBe('RECEIVED');
      expect(final.body.data.receivedAt).not.toBeNull();
      expect(
        final.body.data.lines.map((line: { receivedQuantity: string }) =>
          Number(line.receivedQuantity),
        ),
      ).toEqual([1, 1]);
      expect(await stockOf(primero)).toBe(1);
      expect(await stockOf(segundo)).toBe(1);
    });

    it('mantiene consistentes la orden y el stock si cancelar compite con recibir', async () => {
      const productId = await createProduct({ sku: 'CONC-3', name: 'Carrera cancelar' });
      const order = await submittedOrder([{ productId, quantity: 1, unitCost: 5 }]);

      const [receipt, cancellation] = await Promise.all([
        request(server())
          .post(api('/purchases/' + order.id + '/receive'))
          .set(auth())
          .send({ lines: [{ lineId: order.lines[0].id, quantity: 1 }] }),
        request(server())
          .post(api('/purchases/' + order.id + '/cancel'))
          .set(auth())
          .send({ reason: 'Cancelación concurrente' }),
      ]);

      const final = await request(server())
        .get(api('/purchases/' + order.id))
        .set(auth())
        .expect(200);
      const stock = await stockOf(productId);

      if (receipt.status === 201) {
        expect(cancellation.status).toBe(422);
        expect(final.body.data.status).toBe('RECEIVED');
        expect(stock).toBe(1);
      } else {
        expect(receipt.status).toBe(422);
        expect(cancellation.status).toBe(201);
        expect(final.body.data.status).toBe('CANCELLED');
        expect(stock).toBe(0);
      }
    });
  });

  // =========================================================================

  describe('trazabilidad por lote', () => {
    it('crea el lote al recibir un producto trazado, delegando en inventario', async () => {
      const productId = await createProduct({ sku: 'TINTE-1', tracksBatches: true });
      const order = await submittedOrder([{ productId, quantity: 6, unitCost: 20 }]);

      await request(server())
        .post(api('/purchases/' + order.id + '/receive'))
        .set(auth())
        .send({
          lines: [
            {
              lineId: order.lines[0].id,
              quantity: 6,
              batchNumber: 'L-2026-01',
              expiresAt: '2027-01-31T00:00:00.000Z',
            },
          ],
        })
        .expect(201);

      const lotes = await request(server())
        .get(api('/inventory/batches?productId=' + productId))
        .set(auth())
        .expect(200);

      expect(lotes.body.data).toHaveLength(1);
      expect(lotes.body.data[0].batchNumber).toBe('L-2026-01');
      expect(Number(lotes.body.data[0].remainingQuantity)).toBe(6);
    });
  });
});
