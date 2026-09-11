import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';
import { QueryScopeStore } from '@shared/infrastructure/persistence/prisma/query-scope';

import { api, createTestApp, resetDatabase } from './app-harness';
import { seedTwoTenants, TEST_PASSWORD, type SeededTenant } from './fixtures';

/**
 * Ventas y caja, de extremo a extremo.
 *
 * Lo que se comprueba aquí es la costura entre módulos, que es donde estaba el defecto más
 * caro de la versión anterior: la venta descontaba existencias por su cuenta, escribiendo
 * `stockOnHand` y creando el movimiento a mano. Había, por tanto, **dos motores de
 * inventario** en el mismo sistema, y el de ventas se saltaba los lotes por completo: un
 * tinte trazado se vendía sin tocar ningún lote y la trazabilidad quedaba rota justo en la
 * operación que entrega el producto a la clienta.
 *
 * También se comprueba que el arqueo cuadre. Un cobro en efectivo tiene que aparecer en la
 * caja del día, y esa es la clase de enlace que ningún test unitario puede afirmar.
 */

describe('Ventas y caja (integración)', () => {
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
  const inspect = <T>(work: () => Promise<T>): Promise<T> => QueryScopeStore.crossTenant(work);

  const openCash = (openingFloat = 500) =>
    request(server()).post(api('/cash/open')).set(auth()).send({ openingFloat });

  const sell = (body: Record<string, unknown>) =>
    request(server()).post(api('/sales')).set(auth()).send(body);

  const createProduct = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const response = await request(server())
      .post(api('/products'))
      .set(auth())
      .send({ sku: 'VENTA-1', name: 'Producto de venta', price: 100, ...overrides })
      .expect(201);
    return response.body.data.id as string;
  };

  const receive = (body: Record<string, unknown>) =>
    request(server()).post(api('/inventory/receive')).set(auth()).send(body);

  // =========================================================================

  describe('emisión y cobro', () => {
    it('emite la factura con el IVA de Guatemala y la deja pagada', async () => {
      // El servicio sembrado cuesta 35,00. Con el 12 % son 4,20 de impuesto y 39,20 en total.
      await inspect(() =>
        prisma.client.service.updateMany({
          where: { id: salonA.serviceId },
          data: { price: '35.00', taxRate: '12.00' },
        }),
      );

      const response = await sell({
        lines: [{ kind: 'SERVICE', itemId: salonA.serviceId, quantity: 1 }],
        payments: [{ method: 'CARD', amount: 39.2 }],
      }).expect(201);

      expect(response.body.data).toMatchObject({
        status: 'PAID',
        subtotal: '35.00',
        taxTotal: '4.20',
        total: '39.20',
        paidTotal: '39.20',
        balanceDue: '0.00',
        currency: 'GTQ',
      });
      expect(response.body.data.number).toMatch(/^F-2026-\d{6}$/);
    });

    it('rechaza el cobro que no cuadra con el total, sin tolerancia', async () => {
      // La versión anterior admitía un céntimo de diferencia. Esa tolerancia era la
      // confesión de que las cifras no cuadraban por hacer la aritmética en coma flotante,
      // y un céntimo por venta son decenas de quetzales al año que nadie sabe explicar.
      await inspect(() =>
        prisma.client.service.updateMany({
          where: { id: salonA.serviceId },
          data: { price: '35.00', taxRate: '12.00' },
        }),
      );

      const response = await sell({
        lines: [{ kind: 'SERVICE', itemId: salonA.serviceId, quantity: 1 }],
        payments: [{ method: 'CARD', amount: 39.19 }],
      }).expect(422);

      expect(response.body.detail).toMatch(/39\.19.*39\.20|39\.20.*39\.19/);
    });

    it('numera las facturas de forma consecutiva y sin huecos', async () => {
      // Un salto entre la 41 y la 43 hay que explicarlo en una inspección; un número
      // repetido, todavía más.
      const numbers: string[] = [];

      for (let i = 0; i < 3; i += 1) {
        const response = await sell({
          lines: [{ kind: 'SERVICE', itemId: salonA.serviceId, quantity: 1 }],
          payments: [{ method: 'CARD', amount: Number(await totalFor(salonA.serviceId)) }],
        }).expect(201);
        numbers.push(response.body.data.number as string);
      }

      expect(numbers).toEqual(['F-2026-000001', 'F-2026-000002', 'F-2026-000003']);
    });

    it('no factura dos veces la misma cita', async () => {
      const appointmentId = await inspect(async () => {
        const row = await prisma.client.appointment.findFirst({
          where: { tenantId: salonA.tenantId },
        });
        return row?.id ?? null;
      });

      if (!appointmentId) return;

      const total = Number(await totalFor(salonA.serviceId));
      const body = {
        appointmentId,
        lines: [{ kind: 'SERVICE', itemId: salonA.serviceId, quantity: 1 }],
        payments: [{ method: 'CARD', amount: total }],
      };

      await sell(body).expect(201);
      const second = await sell(body).expect(409);

      expect(second.body.detail).toMatch(/ya se facturó/);
    });

    it('agrupa: rechaza el mismo artículo en dos líneas', async () => {
      const response = await sell({
        lines: [
          { kind: 'SERVICE', itemId: salonA.serviceId, quantity: 1 },
          { kind: 'SERVICE', itemId: salonA.serviceId, quantity: 1 },
        ],
        payments: [{ method: 'CARD', amount: 10 }],
      }).expect(409);

      expect(response.body.detail).toMatch(/una sola línea/);
    });

    it('congela precio e impuesto en la factura', async () => {
      // Una factura es un documento histórico: si mañana sube el precio, la de hoy tiene
      // que seguir diciendo lo que se cobró hoy.
      await inspect(() =>
        prisma.client.service.updateMany({
          where: { id: salonA.serviceId },
          data: { price: '35.00', taxRate: '12.00' },
        }),
      );

      const sale = await sell({
        lines: [{ kind: 'SERVICE', itemId: salonA.serviceId, quantity: 1 }],
        payments: [{ method: 'CARD', amount: 39.2 }],
      }).expect(201);

      await inspect(() =>
        prisma.client.service.updateMany({
          where: { id: salonA.serviceId },
          data: { price: '99.00' },
        }),
      );

      const reread = await request(server())
        .get(api(`/sales/${sale.body.data.id}`))
        .set(auth())
        .expect(200);

      expect(reread.body.data.lines[0].unitPrice).toBe('35.00');
      expect(reread.body.data.total).toBe('39.20');
    });
  });

  // =========================================================================

  describe('la venta usa el motor de inventario, no uno propio', () => {
    it('descuenta por FEFO el lote que caduca antes', async () => {
      const productId = await createProduct({
        sku: 'TINTE-VENTA',
        tracksBatches: true,
        price: 100,
      });

      await receive({
        productId,
        quantity: 5,
        unitCost: 40,
        batchNumber: 'L-TARDE',
        expiresAt: isoDay(200),
      }).expect(201);
      await receive({
        productId,
        quantity: 5,
        unitCost: 40,
        batchNumber: 'L-PRONTO',
        expiresAt: isoDay(20),
      }).expect(201);

      await sell({
        lines: [{ kind: 'PRODUCT', itemId: productId, quantity: 3 }],
        payments: [{ method: 'CARD', amount: 336 }],
      }).expect(201);

      const batches = await inspect(() =>
        prisma.client.productBatch.findMany({
          where: { productId },
          orderBy: { batchNumber: 'asc' },
        }),
      );

      expect(
        batches.map((batch) => [batch.batchNumber, batch.remainingQuantity.toFixed(3)]),
      ).toEqual([
        ['L-PRONTO', '2.000'],
        ['L-TARDE', '5.000'],
      ]);
    });

    it('deja el movimiento del kardex apuntando a la factura y al lote', async () => {
      const productId = await createProduct({
        sku: 'TINTE-TRAZA',
        tracksBatches: true,
        price: 100,
      });
      await receive({
        productId,
        quantity: 5,
        unitCost: 40,
        batchNumber: 'L-TRAZA',
        expiresAt: isoDay(90),
      }).expect(201);

      const sale = await sell({
        lines: [{ kind: 'PRODUCT', itemId: productId, quantity: 2 }],
        payments: [{ method: 'CARD', amount: 224 }],
      }).expect(201);

      const movement = await inspect(() =>
        prisma.client.inventoryMovement.findFirst({
          where: { productId, type: 'SALE_OUT' },
        }),
      );

      expect(movement).not.toBeNull();
      expect(movement!.sourceType).toBe('INVOICE');
      expect(movement!.sourceId).toBe(sale.body.data.id);
      expect(movement!.batchId).not.toBeNull();
      // El coste es el real del lote (40,00), no una media: es de lo que depende el margen.
      expect(movement!.unitCost?.toFixed(2)).toBe('40.00');
    });

    it('rechaza la venta sin existencias suficientes y no emite la factura', async () => {
      const productId = await createProduct({ sku: 'SIN-STOCK', price: 100 });
      await receive({ productId, quantity: 1, unitCost: 40 }).expect(201);

      await sell({
        lines: [{ kind: 'PRODUCT', itemId: productId, quantity: 5 }],
        payments: [{ method: 'CARD', amount: 560 }],
      }).expect(422);

      // La transacción revierte entera: ni factura, ni número de serie consumido.
      const invoices = await inspect(() => prisma.client.invoice.count());
      expect(invoices).toBe(0);
    });

    it('no exige existencias a un producto que no las lleva', async () => {
      // Hay artículos que se facturan y no se inventarían: un bono, una tarjeta regalo.
      const productId = await createProduct({
        sku: 'BONO-10',
        price: 100,
        trackStock: false,
      });

      await sell({
        lines: [{ kind: 'PRODUCT', itemId: productId, quantity: 1 }],
        payments: [{ method: 'CARD', amount: 112 }],
      }).expect(201);
    });
  });

  // =========================================================================

  describe('caja', () => {
    it('exige caja abierta para cobrar en efectivo', async () => {
      const response = await sell({
        lines: [{ kind: 'SERVICE', itemId: salonA.serviceId, quantity: 1 }],
        payments: [{ method: 'CASH', amount: Number(await totalFor(salonA.serviceId)) }],
      }).expect(422);

      expect(response.body.detail).toMatch(/Abra la caja/);
    });

    it('imputa el cobro en efectivo a la caja abierta', async () => {
      await openCash(500).expect(201);
      const total = Number(await totalFor(salonA.serviceId));

      await sell({
        lines: [{ kind: 'SERVICE', itemId: salonA.serviceId, quantity: 1 }],
        payments: [{ method: 'CASH', amount: total }],
      }).expect(201);

      const current = await request(server()).get(api('/cash/current')).set(auth()).expect(200);

      expect(current.body.data.cashSales).toBe(total.toFixed(2));
      expect(current.body.data.expectedAmount).toBe((500 + total).toFixed(2));
    });

    it('no imputa a la caja lo cobrado con tarjeta', async () => {
      await openCash(500).expect(201);

      await sell({
        lines: [{ kind: 'SERVICE', itemId: salonA.serviceId, quantity: 1 }],
        payments: [{ method: 'CARD', amount: Number(await totalFor(salonA.serviceId)) }],
      }).expect(201);

      const current = await request(server()).get(api('/cash/current')).set(auth()).expect(200);

      expect(current.body.data.cashSales).toBe('0.00');
      expect(current.body.data.expectedAmount).toBe('500.00');
    });

    it('impide abrir dos cajas a la vez', async () => {
      await openCash(500).expect(201);
      const second = await openCash(300).expect(422);

      expect(second.body.detail).toMatch(/Ya hay una caja abierta/);
    });

    it('la restricción de una sola caja abierta la impone PostgreSQL', async () => {
      // La comprobación del caso de uso da el mensaje útil; el índice único parcial es lo
      // que impide de verdad que dos peticiones simultáneas abran dos cajas y repartan los
      // cobros del día entre ambas.
      await openCash(500).expect(201);

      await expect(
        inspect(() =>
          prisma.client.$executeRawUnsafe(
            `INSERT INTO "cash_sessions" ("id","tenantId","openedById","status","openingFloat","currency","createdAt","updatedAt")
             SELECT gen_random_uuid(), "tenantId", "openedById", 'OPEN', 0, 'GTQ', now(), now()
             FROM "cash_sessions" LIMIT 1`,
          ),
        ),
        // PostgreSQL rechaza la segunda fila con un 23505 sobre `tenantId`. Prisma no
        // repite el nombre del índice en el mensaje, así que se comprueba lo observable:
        // que la clave duplicada es el salón, que es exactamente lo que el índice parcial
        // `cash_sessions_one_open_per_tenant` hace único mientras la caja está abierta.
      ).rejects.toThrow(/Key \("tenantId"\).*already exists/);
    });

    it('anota movimientos y los refleja en lo esperado', async () => {
      await openCash(500).expect(201);

      await request(server())
        .post(api('/cash/movements'))
        .set(auth())
        .send({ type: 'CASH_IN', amount: 100, concept: 'Cambio del banco' })
        .expect(201);

      const salida = await request(server())
        .post(api('/cash/movements'))
        .set(auth())
        .send({ type: 'EXPENSE', amount: 30, concept: 'Café para el equipo' })
        .expect(201);

      expect(salida.body.data.session.expectedAmount).toBe('570.00');
      expect(salida.body.data.session.netMovements).toBe('70.00');
    });

    it('impide sacar más efectivo del que hay', async () => {
      await openCash(100).expect(201);

      const response = await request(server())
        .post(api('/cash/movements'))
        .set(auth())
        .send({ type: 'WITHDRAWAL', amount: 150, concept: 'Retirada' })
        .expect(422);

      expect(response.body.detail).toMatch(/No se pueden sacar/);
    });

    it('cierra cuadrando cuando el recuento coincide', async () => {
      await openCash(500).expect(201);
      const total = Number(await totalFor(salonA.serviceId));

      await sell({
        lines: [{ kind: 'SERVICE', itemId: salonA.serviceId, quantity: 1 }],
        payments: [{ method: 'CASH', amount: total }],
      }).expect(201);

      const closed = await request(server())
        .post(api('/cash/close'))
        .set(auth())
        .send({ countedAmount: 500 + total })
        .expect(201);

      expect(closed.body.data.status).toBe('CLOSED');
      expect(closed.body.data.difference).toBe('0.00');
    });

    it('registra el descuadre en lugar de rechazarlo', async () => {
      await openCash(500).expect(201);

      const closed = await request(server())
        .post(api('/cash/close'))
        .set(auth())
        .send({ countedAmount: 480 })
        .expect(201);

      expect(closed.body.data.difference).toBe('-20.00');
    });

    it('congela lo esperado al cerrar', async () => {
      await openCash(500).expect(201);
      await request(server())
        .post(api('/cash/close'))
        .set(auth())
        .send({ countedAmount: 500 })
        .expect(201);

      const history = await request(server()).get(api('/cash/history')).set(auth()).expect(200);

      expect(history.body.data[0]).toMatchObject({
        status: 'CLOSED',
        expectedAmount: '500.00',
        countedAmount: '500.00',
        difference: '0.00',
      });
    });

    it('no deja anotar movimientos con la caja cerrada', async () => {
      await openCash(500).expect(201);
      await request(server())
        .post(api('/cash/close'))
        .set(auth())
        .send({ countedAmount: 500 })
        .expect(201);

      await request(server())
        .post(api('/cash/movements'))
        .set(auth())
        .send({ type: 'CASH_IN', amount: 10, concept: 'Tarde' })
        .expect(404);
    });
  });

  // =========================================================================

  describe('consulta de facturas', () => {
    it('lista, filtra por clienta y devuelve el detalle con sus cobros', async () => {
      const total = Number(await totalFor(salonA.serviceId));
      const sale = await sell({
        clientId: salonA.clientId,
        lines: [{ kind: 'SERVICE', itemId: salonA.serviceId, quantity: 1 }],
        payments: [{ method: 'CARD', amount: total }],
      }).expect(201);

      const listado = await request(server())
        .get(api('/sales'))
        .query({ clientId: salonA.clientId })
        .set(auth())
        .expect(200);

      expect(listado.body.data).toHaveLength(1);
      expect(listado.body.meta.total).toBe(1);

      // El listado no trae los cobros —serian tantas consultas como facturas—; el detalle si.
      expect(listado.body.data[0]).not.toHaveProperty('payments');

      const detalle = await request(server())
        .get(api(`/sales/${sale.body.data.id}`))
        .set(auth())
        .expect(200);

      expect(detalle.body.data.payments).toHaveLength(1);
      expect(detalle.body.data.payments[0]).toMatchObject({
        method: 'CARD',
        status: 'COMPLETED',
        amount: total.toFixed(2),
      });
    });

    it('filtra por estado y por profesional', async () => {
      const total = Number(await totalFor(salonA.serviceId));
      await sell({
        lines: [
          { kind: 'SERVICE', itemId: salonA.serviceId, quantity: 1, stylistId: salonA.stylistId },
        ],
        payments: [{ method: 'CARD', amount: total }],
      }).expect(201);

      const pagadas = await request(server())
        .get(api('/sales'))
        .query({ status: 'PAID', stylistId: salonA.stylistId })
        .set(auth())
        .expect(200);
      expect(pagadas.body.data).toHaveLength(1);

      // El filtro por profesional mira la linea, no la factura: el trabajo es de quien lo hizo.
      const deOtro = await request(server())
        .get(api('/sales'))
        .query({ stylistId: salonA.clientId })
        .set(auth())
        .expect(200);
      expect(deOtro.body.data).toHaveLength(0);
    });

    it('filtra por rango de fechas', async () => {
      const total = Number(await totalFor(salonA.serviceId));
      await sell({
        lines: [{ kind: 'SERVICE', itemId: salonA.serviceId, quantity: 1 }],
        payments: [{ method: 'CARD', amount: total }],
      }).expect(201);

      const fuera = await request(server())
        .get(api('/sales'))
        .query({ from: '2020-01-01T00:00:00.000Z', to: '2020-12-31T00:00:00.000Z' })
        .set(auth())
        .expect(200);

      expect(fuera.body.data).toHaveLength(0);
    });

    it('devuelve 404 para una factura que no existe', async () => {
      await request(server())
        .get(api('/sales/11111111-1111-7111-8111-999999999999'))
        .set(auth())
        .expect(404);
    });
  });

  // =========================================================================

  describe('anulación', () => {
    it('impide anular una factura cobrada', async () => {
      const total = Number(await totalFor(salonA.serviceId));
      const sale = await sell({
        lines: [{ kind: 'SERVICE', itemId: salonA.serviceId, quantity: 1 }],
        payments: [{ method: 'CARD', amount: total }],
      }).expect(201);

      const response = await request(server())
        .post(api(`/sales/${sale.body.data.id}/void`))
        .set(auth())
        .send({ reason: 'Cobrada a la clienta equivocada' })
        .expect(422);

      expect(response.body.detail).toMatch(/Devuelva el importe/);
    });
  });

  // =========================================================================

  /** Total con impuesto del servicio sembrado, tal y como lo calcula el dominio. */
  const totalFor = async (serviceId: string): Promise<string> => {
    const service = await inspect(() =>
      prisma.client.service.findFirst({ where: { id: serviceId } }),
    );
    const base = Number(service!.price);
    return (base * (1 + Number(service!.taxRate) / 100)).toFixed(2);
  };
});

const DAY = 86_400_000;
const isoDay = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
