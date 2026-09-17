import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';
import { QueryScopeStore } from '@shared/infrastructure/persistence/prisma/query-scope';

import { api, createTestApp, resetDatabase } from './app-harness';
import { seedTwoTenants, TEST_PASSWORD, type SeededTenant } from './fixtures';

/**
 * Metas e incentivos, de extremo a extremo.
 *
 * Es el único módulo de negocio que llegó sin esta suite (ADR-0018): los unitarios prueban
 * el cálculo con el ámbito ya resuelto a mano, pero nada probaba, contra HTTP real y
 * Postgres real, que `ownScopeFor()` lo resuelve correctamente desde un JWT de verdad ni
 * que la extensión de Prisma aísla `goals` entre salones igual que al resto de módulos.
 */
describe('Metas e incentivos (integración)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let salonA: SeededTenant;
  let salonB: SeededTenant;
  let ownerToken: string;

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
    ownerToken = login.body.data.accessToken as string;
  });

  const server = () => app.getHttpServer();
  const auth = (token = ownerToken) => ({ Authorization: `Bearer ${token}` });
  const inspect = <T>(work: () => Promise<T>): Promise<T> => QueryScopeStore.crossTenant(work);

  const loginAs = async (email: string): Promise<string> => {
    const res = await request(server())
      .post(api('/auth/login'))
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  };

  // Periodo amplio y estable: no depende de cuándo se ejecute la suite.
  const WIDE_PERIOD = {
    periodStart: '2020-01-01T00:00:00.000Z',
    periodEnd: '2099-01-01T00:00:00.000Z',
  };

  const createGoal = (overrides: Record<string, unknown> = {}, token = ownerToken) =>
    request(server())
      .post(api('/goals'))
      .set(auth(token))
      .send({
        stylistId: salonA.stylistId,
        metric: 'SERVICE_REVENUE',
        targetAmount: 50,
        rewardDescription: 'Bono Q200 en Walmart',
        ...WIDE_PERIOD,
        ...overrides,
      });

  // El servicio del seed vale 25,00 con 21 % de IVA: 30,25 al cobro, 25,00 de base imponible.
  const sellService = (stylistId = salonA.stylistId) =>
    request(server())
      .post(api('/sales'))
      .set(auth())
      .send({
        clientId: salonA.clientId,
        lines: [{ kind: 'SERVICE', itemId: salonA.serviceId, quantity: 1, stylistId }],
        payments: [{ method: 'CARD', amount: 30.25 }],
      });

  describe('progreso', () => {
    it('empieza en cero y sube al vender', async () => {
      const created = await createGoal().expect(201);
      expect(created.body.data).toMatchObject({
        progress: '0.00',
        percentage: 0,
        status: 'ACTIVE',
        achievedAt: null,
      });

      await sellService().expect(201);

      const list = await request(server()).get(api('/goals')).set(auth()).expect(200);
      const goal = (list.body.data as Array<{ id: string }>).find(
        (g) => g.id === (created.body.data.id as string),
      );
      expect(goal).toMatchObject({ progress: '25.00', percentage: 50, status: 'ACTIVE' });
    });

    it('se marca cumplida al alcanzar el objetivo, y una venta anulada después no la retira', async () => {
      const created = await createGoal({ targetAmount: 25 }).expect(201);
      const sale = await sellService().expect(201);

      const afterSale = await request(server()).get(api('/goals')).set(auth()).expect(200);
      const achieved = (
        afterSale.body.data as Array<{ id: string; status: string; achievedAt: string | null }>
      ).find((g) => g.id === (created.body.data.id as string))!;
      expect(achieved.status).toBe('ACHIEVED');
      expect(achieved.achievedAt).not.toBeNull();

      // Se anula la factura directamente en base, igual que hace la suite de informes: no hay
      // reembolso que orquestar aquí, solo comprobar que el progreso deja de contarla y que
      // eso no "des-cumple" una meta ya lograda (ADR-0018, decisión 6).
      await inspect(() =>
        prisma.client.invoice.updateMany({
          where: { id: sale.body.data.id as string },
          data: { status: 'VOID', paidTotal: '0.00' },
        }),
      );

      const afterVoid = await request(server()).get(api('/goals')).set(auth()).expect(200);
      const stillAchieved = (
        afterVoid.body.data as Array<{
          id: string;
          status: string;
          achievedAt: string | null;
          progress: string;
        }>
      ).find((g) => g.id === (created.body.data.id as string))!;
      expect(stillAchieved.progress).toBe('0.00');
      expect(stillAchieved.status).toBe('ACHIEVED');
      expect(stillAchieved.achievedAt).toBe(achieved.achievedAt);
    });
  });

  describe('ámbito propio', () => {
    it('la profesional solo ve sus propias metas', async () => {
      const otherStylist = await request(server())
        .post(api('/stylists'))
        .set(auth())
        .send({ firstName: 'Marta', lastName: 'Delgado' })
        .expect(201);

      await createGoal().expect(201);
      await createGoal({ stylistId: otherStylist.body.data.id as string }).expect(201);

      const stylistToken = await loginAs(salonA.stylistEmail);
      const response = await request(server())
        .get(api('/goals'))
        .set(auth(stylistToken))
        .expect(200);

      expect(response.body.meta.total).toBe(1);
      expect(response.body.data[0].stylistId).toBe(salonA.stylistId);
    });

    it('pedir las metas de otra profesional no amplía el alcance', async () => {
      const otherStylist = await request(server())
        .post(api('/stylists'))
        .set(auth())
        .send({ firstName: 'Marta', lastName: 'Delgado' })
        .expect(201);
      await createGoal({ stylistId: otherStylist.body.data.id as string }).expect(201);

      const stylistToken = await loginAs(salonA.stylistEmail);
      const response = await request(server())
        .get(api('/goals'))
        .query({ stylistId: otherStylist.body.data.id as string })
        .set(auth(stylistToken))
        .expect(200);

      expect(response.body.meta.total).toBe(0);
    });

    it('una profesional no puede definir metas para sí misma', async () => {
      const stylistToken = await loginAs(salonA.stylistEmail);
      await createGoal({}, stylistToken).expect(403);
    });
  });

  describe('permisos', () => {
    it('recepción no tiene acceso a las metas', async () => {
      const receptionToken = await loginAs(salonA.receptionEmail);
      await request(server()).get(api('/goals')).set(auth(receptionToken)).expect(403);
    });
  });

  describe('aislamiento entre salones', () => {
    it('no se ven las metas de otro salón', async () => {
      await createGoal().expect(201);

      const otherOwnerToken = await loginAs(salonB.ownerEmail);
      const response = await request(server())
        .get(api('/goals'))
        .set(auth(otherOwnerToken))
        .expect(200);

      expect(response.body.meta.total).toBe(0);
    });

    it('no se puede cancelar la meta de otro salón', async () => {
      const created = await createGoal().expect(201);

      const otherOwnerToken = await loginAs(salonB.ownerEmail);
      await request(server())
        .delete(api(`/goals/${created.body.data.id as string}`))
        .set(auth(otherOwnerToken))
        .expect(404);
    });
  });
});
