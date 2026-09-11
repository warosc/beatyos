import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';
import { QueryScopeStore } from '@shared/infrastructure/persistence/prisma/query-scope';

import { api, createTestApp, resetDatabase } from './app-harness';
import { seedTwoTenants, TEST_PASSWORD, type SeededTenant } from './fixtures';

/**
 * Informes, de extremo a extremo.
 *
 * Un informe es la pantalla que más se mira y la que menos se revisa: si una cifra sale mal,
 * nadie lo nota hasta que alguien la contrasta con la caja. Estos tests contrastan.
 *
 * Lo más importante que se comprueba aquí es que **el panel y el arqueo dicen lo mismo**. La
 * versión anterior calculaba el efectivo esperado con su propia fórmula —la tercera copia de
 * la misma cuenta en el sistema— y bastaba con que una de las tres olvidara un tipo de
 * movimiento para que las dos pantallas discreparan sin que nadie supiera cuál creer.
 */

describe('Informes (integración)', () => {
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

    await inspect(() =>
      prisma.client.service.updateMany({
        where: { id: salonA.serviceId },
        data: { price: '100.00', taxRate: '12.00', commissionRate: '20.00' },
      }),
    );
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => app.getHttpServer();
  const inspect = <T>(work: () => Promise<T>): Promise<T> => QueryScopeStore.crossTenant(work);

  /** Una venta de un servicio a 100,00 + 12 % = 112,00. */
  const sellService = (method = 'CARD') =>
    request(server())
      .post(api('/sales'))
      .set(auth())
      .send({
        clientId: salonA.clientId,
        lines: [
          { kind: 'SERVICE', itemId: salonA.serviceId, quantity: 1, stylistId: salonA.stylistId },
        ],
        payments: [{ method, amount: 112 }],
      });

  const executive = (query: Record<string, string> = {}) =>
    request(server()).get(api('/reports/executive')).query(query).set(auth());

  const dashboard = () => request(server()).get(api('/reports/dashboard')).set(auth());

  // =========================================================================

  describe('indicadores', () => {
    it('suma la facturación y calcula el ticket medio', async () => {
      await sellService().expect(201);
      await sellService().expect(201);

      const response = await executive().expect(200);

      expect(response.body.data).toMatchObject({
        sales: '224.00',
        tickets: 2,
        averageTicket: '112.00',
        currency: 'GTQ',
      });
    });

    it('devuelve el periodo y la zona sobre los que se ha medido', async () => {
      // Una cifra como «retención del 34 %» no significa nada sin saber sobre qué ventana se
      // ha medido, y la serie diaria está agrupada en hora del salón, no en UTC.
      const response = await executive().expect(200);

      expect(response.body.data.timeZone).toBe('America/Guatemala');
      expect(response.body.data.period.from).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(response.body.data.period.to).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('no cuenta las facturas anuladas', async () => {
      const sale = await sellService().expect(201);
      await inspect(() =>
        prisma.client.invoice.updateMany({
          where: { id: sale.body.data.id },
          data: { status: 'VOID', paidTotal: '0.00' },
        }),
      );

      const response = await executive().expect(200);

      expect(response.body.data.sales).toBe('0.00');
      expect(response.body.data.tickets).toBe(0);
    });

    it('atribuye la facturación y la comisión al profesional', async () => {
      await sellService().expect(201);

      const response = await executive().expect(200);
      const stylist = response.body.data.topStylists[0];

      expect(stylist.revenue).toBe('100.00');
      // La comisión es el 20 % de la base imponible, no del total con IVA: 20,00 y no 22,40.
      expect(stylist.commission).toBe('20.00');
      expect(response.body.data.commissionTotal).toBe('20.00');
    });

    it('mide la retención dentro del periodo', async () => {
      await sellService().expect(201);
      await sellService().expect(201);

      // Una sola clienta con dos visitas: el 100 % ha repetido.
      expect((await executive().expect(200)).body.data.retentionRate).toBe(100);
    });

    it('devuelve la serie diaria completa, con los días sin ventas a cero', async () => {
      const response = await executive({
        from: '2026-09-01T06:00:00.000Z',
        to: '2026-09-04T06:00:00.000Z',
      }).expect(200);

      expect(response.body.data.dailySales.map((item: { date: string }) => item.date)).toEqual([
        '2026-09-01',
        '2026-09-02',
        '2026-09-03',
      ]);
    });

    it('rechaza un rango invertido', async () => {
      await executive({ from: '2026-09-10', to: '2026-09-01' }).expect(400);
    });

    it('rechaza un rango mayor de un año', async () => {
      await executive({ from: '2024-01-01', to: '2026-01-01' }).expect(400);
    });
  });

  // =========================================================================

  describe('panel del día', () => {
    it('cuenta los productos por debajo del punto de pedido', async () => {
      await request(server())
        .post(api('/products'))
        .set(auth())
        .send({ sku: 'REPO-1', name: 'Producto a reponer', price: 50, reorderPoint: 10 })
        .expect(201);

      const response = await dashboard().expect(200);

      expect(response.body.data.lowStockCount).toBeGreaterThanOrEqual(1);
    });

    it('devuelve las próximas citas con los nombres ya resueltos', async () => {
      // El panel de `apps/web` lee `upcoming` con estos campos exactos y pinta el nombre
      // de la clienta y del profesional sin volver a preguntar. Este test fija ese contrato.
      const response = await dashboard().expect(200);

      expect(Array.isArray(response.body.data.upcoming)).toBe(true);

      for (const item of response.body.data.upcoming as Record<string, unknown>[]) {
        expect(item).toHaveProperty('id');
        expect(item).toHaveProperty('startsAt');
        expect(item).toHaveProperty('status');
        expect(typeof item.client).toBe('string');
        expect(typeof item.stylist).toBe('string');
        expect(typeof item.service).toBe('string');
      }
    });

    it('no lista como próxima una cita ya cancelada', async () => {
      await inspect(() =>
        prisma.client.appointment.updateMany({
          where: { tenantId: salonA.tenantId },
          data: { status: 'CANCELLED' },
        }),
      );

      const response = await dashboard().expect(200);

      expect(response.body.data.upcoming).toEqual([]);
    });

    it('informa de la caja cerrada sin inventarse cifras', async () => {
      const response = await dashboard().expect(200);

      expect(response.body.data.cash).toMatchObject({
        isOpen: false,
        openedAt: null,
        expected: '0.00',
      });
    });

    it('el efectivo esperado del panel coincide con el de la caja', async () => {
      // Es la prueba de que la fórmula está en un solo sitio. Si el panel y el arqueo usaran
      // cuentas distintas, este test las separaría.
      await request(server())
        .post(api('/cash/open'))
        .set(auth())
        .send({ openingFloat: 500 })
        .expect(201);
      await sellService('CASH').expect(201);
      await request(server())
        .post(api('/cash/movements'))
        .set(auth())
        .send({ type: 'EXPENSE', amount: 30, concept: 'Café' })
        .expect(201);

      const [panel, caja] = await Promise.all([
        dashboard().expect(200),
        request(server()).get(api('/cash/current')).set(auth()).expect(200),
      ]);

      // 500 de fondo + 112 cobrados − 30 de gasto.
      expect(panel.body.data.cash.expected).toBe('582.00');
      expect(panel.body.data.cash.expected).toBe(caja.body.data.expectedAmount);
      expect(panel.body.data.cash.cashSales).toBe(caja.body.data.cashSales);
    });
  });

  // =========================================================================

  describe('aislamiento entre salones', () => {
    it('no suma la facturación del otro salón', async () => {
      await sellService().expect(201);

      const otherLogin = await request(server())
        .post(api('/auth/login'))
        .send({ email: 'owner@salon-b.test', password: TEST_PASSWORD })
        .expect(200);

      const response = await request(server())
        .get(api('/reports/executive'))
        .set({ Authorization: `Bearer ${otherLogin.body.data.accessToken}` })
        .expect(200);

      expect(response.body.data.sales).toBe('0.00');
      expect(response.body.data.tickets).toBe(0);
    });
  });
});
