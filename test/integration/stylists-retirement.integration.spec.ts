import type { INestApplication } from '@nestjs/common';
import type { AppointmentStatus } from '@prisma/client';
import request from 'supertest';

import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';
import { QueryScopeStore } from '@shared/infrastructure/persistence/prisma/query-scope';

import { api, createTestApp, resetDatabase } from './app-harness';
import { seedTwoTenants, TEST_PASSWORD, type SeededTenant } from './fixtures';

/**
 * Dar de baja a una profesional, de extremo a extremo (ADR-0027).
 *
 * Lo que solo se ve con la base real: que lo pendiente se cuente en las tablas de agenda,
 * cola y comandas; que la baja apague su acceso en la misma transacción; que su nombre siga
 * en las ventas pasadas aunque las lecturas normales ya no la vean; y que guardar los roles
 * de su usuario no la devuelva al equipo por la puerta de atrás.
 */
describe('Baja de profesionales (integración)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let salonA: SeededTenant;
  let token: string;

  const HOUR = 60 * 60 * 1000;

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
    token = await loginAs(salonA.ownerEmail);
  });

  const server = () => app.getHttpServer();
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const inspect = <T>(work: () => Promise<T>): Promise<T> => QueryScopeStore.crossTenant(work);

  const login = (email: string) =>
    request(server()).post(api('/auth/login')).send({ email, password: TEST_PASSWORD });
  const loginAs = async (email: string) =>
    (await login(email).expect(200)).body.data.accessToken as string;

  const retirement = () =>
    request(server())
      .get(api(`/stylists/${salonA.stylistId}/retirement`))
      .set(auth());
  const retire = () =>
    request(server())
      .delete(api(`/stylists/${salonA.stylistId}`))
      .set(auth());
  const restore = () =>
    request(server())
      .post(api(`/stylists/${salonA.stylistId}/restore`))
      .set(auth());

  const appointmentIn = (hoursFromNow: number, status: AppointmentStatus = 'CONFIRMED') =>
    inspect(() =>
      prisma.client.appointment.create({
        data: {
          tenantId: salonA.tenantId,
          clientId: salonA.clientId,
          stylistId: salonA.stylistId,
          startsAt: new Date(Date.now() + hoursFromNow * HOUR),
          endsAt: new Date(Date.now() + (hoursFromNow + 1) * HOUR),
          status,
          services: {
            create: {
              tenantId: salonA.tenantId,
              serviceId: salonA.serviceId,
              durationMinutes: 45,
              price: '30.25',
            },
          },
        },
      }),
    );

  const queueTurn = (data: {
    number: number;
    status: 'WAITING' | 'IN_SERVICE';
    stylistId?: string;
    preferredStylistId?: string;
  }) =>
    inspect(() =>
      prisma.client.queueTurn.create({
        data: {
          tenantId: salonA.tenantId,
          businessDate: new Date(new Date().toISOString().slice(0, 10)),
          clientName: 'Eva',
          serviceIds: [salonA.serviceId],
          ...data,
        },
      }),
    );

  const sellService = () =>
    request(server())
      .post(api('/sales'))
      .set(auth())
      .send({
        clientId: salonA.clientId,
        lines: [
          { kind: 'SERVICE', itemId: salonA.serviceId, quantity: 1, stylistId: salonA.stylistId },
        ],
        payments: [{ method: 'CARD', amount: 30.25 }],
      });

  describe('lo que la impide', () => {
    it('sin pendientes, se puede y avisa que su acceso se apagará', async () => {
      const response = await retirement().expect(200);

      expect(response.body.data).toMatchObject({
        stylistId: salonA.stylistId,
        blocked: false,
        appointmentsTotal: 0,
        pendingTicketsTotal: 0,
        activeQueueTurns: [],
        hasAccount: true,
        accountWillBeDeactivated: true,
      });
    });

    it('una cita futura la bloquea y sale en la lista', async () => {
      await appointmentIn(48);
      // Una cita pasada ya atendida no cuenta.
      await appointmentIn(-48, 'COMPLETED');

      const check = await retirement().expect(200);
      expect(check.body.data).toMatchObject({ blocked: true, appointmentsTotal: 1 });
      expect(check.body.data.appointments[0]).toMatchObject({
        clientName: 'Rosa Iglesias',
        serviceNames: ['Corte de señora'],
        status: 'CONFIRMED',
      });

      const rejected = await retire().expect(422);
      expect(rejected.body.code).toBe('STYLIST_HAS_PENDING_WORK');
      expect(rejected.body.detail).toContain('1 cita pendiente');

      // Sigue en el equipo.
      await request(server())
        .get(api(`/stylists/${salonA.stylistId}`))
        .set(auth())
        .expect(200);
    });

    it('una comanda sin cobrar la bloquea', async () => {
      await inspect(() =>
        prisma.client.serviceTicket.create({
          data: {
            tenantId: salonA.tenantId,
            stylistId: salonA.stylistId,
            clientName: 'Rosa Iglesias',
          },
        }),
      );

      const check = await retirement().expect(200);
      expect(check.body.data).toMatchObject({ blocked: true, pendingTicketsTotal: 1 });
      expect((await retire().expect(422)).body.detail).toContain('1 comanda sin cobrar');
    });

    it('un turno en curso la bloquea; una clienta que la pidió no', async () => {
      await queueTurn({ number: 1, status: 'IN_SERVICE', stylistId: salonA.stylistId });

      const check = await retirement().expect(200);
      expect(check.body.data.activeQueueTurns).toEqual([
        expect.objectContaining({ number: 1, clientName: 'Eva', status: 'IN_SERVICE' }),
      ]);
      expect((await retire().expect(422)).body.detail).toContain('1 turno en curso');
    });
  });

  describe('la baja', () => {
    it('la saca del equipo, conserva su historial y apaga su acceso', async () => {
      const sale = await sellService().expect(201);
      const waiting = await queueTurn({
        number: 2,
        status: 'WAITING',
        preferredStylistId: salonA.stylistId,
      });
      expect((await retirement().expect(200)).body.data.waitingPreferences).toBe(1);

      await retire().expect(204);

      // Ya no está en el equipo...
      const team = await request(server()).get(api('/stylists')).set(auth()).expect(200);
      expect((team.body.data as { id: string }[]).map((s) => s.id)).not.toContain(salonA.stylistId);
      // ...pero la dueña la ve entre las dadas de baja.
      const withRetired = await request(server())
        .get(api('/stylists'))
        .query({ includeDeleted: true })
        .set(auth())
        .expect(200);
      const retired = (withRetired.body.data as { id: string; deletedAt?: string }[]).find(
        (s) => s.id === salonA.stylistId,
      );
      expect(retired?.deletedAt).toBeDefined();

      // La clienta que la pidió pasa a la fila general.
      const turn = await inspect(() =>
        prisma.client.queueTurn.findFirst({ where: { id: waiting.id } }),
      );
      expect(turn?.preferredStylistId).toBeNull();

      // Su venta pasada conserva el nombre, con la marca.
      const detail = await request(server())
        .get(api(`/sales/${sale.body.data.id as string}`))
        .set(auth())
        .expect(200);
      expect(detail.body.data.lines[0].stylistName).toBe('Sara Molina (dada de baja)');

      // No se le puede cobrar nada nuevo a su nombre.
      const blocked = await sellService().expect(422);
      expect(blocked.body.code).toBe('STYLIST_NOT_AVAILABLE');

      // Y ya no entra al sistema.
      const denied = await login(salonA.stylistEmail);
      expect(denied.status).not.toBe(200);
    });

    it('guardar los roles de su usuario no la devuelve al equipo', async () => {
      await retire().expect(204);
      const user = await inspect(() =>
        prisma.client.user.findFirst({
          where: { email: salonA.stylistEmail },
          include: { roles: true },
        }),
      );

      await request(server())
        .put(api(`/users/${user!.id}/roles`))
        .set(auth())
        .send({ roleIds: user!.roles.map((role) => role.roleId) })
        .expect(200);

      await request(server())
        .get(api(`/stylists/${salonA.stylistId}`))
        .set(auth())
        .expect(404);
    });

    it('al reactivarla vuelve al equipo y puede entrar otra vez', async () => {
      await retire().expect(204);

      const restored = await restore().expect(201);
      expect(restored.body.data.id).toBe(salonA.stylistId);

      await request(server())
        .get(api(`/stylists/${salonA.stylistId}`))
        .set(auth())
        .expect(200);
      await login(salonA.stylistEmail).expect(200);
      await sellService().expect(201);
    });

    it('no se le pueden poner metas nuevas', async () => {
      await retire().expect(204);

      const response = await request(server())
        .post(api('/goals'))
        .set(auth())
        .send({
          stylistId: salonA.stylistId,
          metric: 'SERVICE_REVENUE',
          targetAmount: 100,
          periodStart: new Date().toISOString(),
          periodEnd: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
          rewardDescription: 'Bono',
        })
        .expect(422);
      expect(response.body.code).toBe('STYLIST_NOT_AVAILABLE');
    });
  });
});
