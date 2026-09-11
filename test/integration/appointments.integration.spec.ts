import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';
import { zonedTimeToInstant } from '@shared/domain/time/zoned-time';

import { api, createTestApp, resetDatabase } from './app-harness';
import { seedTwoTenants, TEST_PASSWORD, type SeededTenant } from './fixtures';

/**
 * Agenda, de extremo a extremo.
 *
 * Los tests que más valen aquí son los de **solapamiento**. La comprobación del dominio
 * da un buen mensaje, pero la garantía real la da una restricción `EXCLUDE` de PostgreSQL,
 * y es la única capa capaz de resistir dos recepcionistas reservando el mismo hueco a la
 * vez. Eso solo se puede probar contra una base de datos de verdad.
 */
/** Zona del salón, la misma que lee la aplicación. */
const SALON_TZ = process.env.DEFAULT_TIMEZONE ?? 'America/Guatemala';

describe('Agenda (integración)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let salonA: SeededTenant;
  let salonB: SeededTenant;
  let token: string;

  /** Jueves futuro estable: evita que la suite caduque al avanzar el calendario real. */
  const THURSDAY = '2037-09-10';

  /**
   * Hora local del salón como instante absoluto.
   *
   * Se calcula con el mismo conversor que usa el dominio, en lugar de restar a mano el
   * desplazamiento. La primera versión hacía `hour - 2` —el UTC+2 de Madrid en verano— y
   * dejó de valer en cuanto el salón pasó a Guatemala: doce tests se cayeron a la vez.
   * Así el test describe «las diez de la mañana en el salón» y no depende de dónde esté.
   */
  const at = (hour: number, minute = 0): string =>
    zonedTimeToInstant(
      { year: 2037, month: 9, day: 10 },
      hour * 60 + minute,
      SALON_TZ,
    ).toISOString();

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

    // Jornada de 9 a 20, hora local del salón.
    await request(app.getHttpServer())
      .put(api(`/stylists/${salonA.stylistId}/schedule`))
      .set(auth())
      .send({ blocks: [{ dayOfWeek: 4, start: '09:00', end: '20:00' }] })
      .expect(200);
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  const book = (startsAt: string, extra: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post(api('/appointments'))
      .set(auth())
      .send({
        clientId: salonA.clientId,
        stylistId: salonA.stylistId,
        startsAt,
        serviceIds: [salonA.serviceId],
        ...extra,
      });

  describe('reserva', () => {
    it('agenda y calcula la duración con el margen de limpieza', async () => {
      const response = await book(at(10)).expect(201);

      // El servicio del seed dura 45 minutos y tiene 10 de margen: la agenda bloquea 55.
      expect(response.body.data).toMatchObject({
        status: 'SCHEDULED',
        isBlocking: true,
        durationMinutes: 55,
        estimatedTotal: '25.00',
      });
      expect(response.body.data.endsAt).toBe(at(10, 55));
    });

    it('congela el precio del servicio', async () => {
      const appointment = await book(at(10)).expect(201);

      await request(app.getHttpServer())
        .patch(api(`/services/${salonA.serviceId}`))
        .set(auth())
        .send({ price: '99.00' })
        .expect(200);

      const reloaded = await request(app.getHttpServer())
        .get(api(`/appointments/${appointment.body.data.id as string}`))
        .set(auth())
        .expect(200);

      // Subir la tarifa no puede cambiar lo que se le dijo a la clienta al reservar.
      expect(reloaded.body.data.estimatedTotal).toBe('25.00');
      expect(reloaded.body.data.services[0].price).toBe('25.00');
    });

    it('rechaza reservar fuera del horario', async () => {
      const response = await book(at(21)).expect(422);
      expect(response.body.code).toBe('OUTSIDE_WORKING_HOURS');
    });

    it('permite forzar fuera de horario dejando constancia', async () => {
      await book(at(21), { force: true }).expect(201);

      const audit = await prisma.client.auditLog.findFirst({
        where: { entityType: 'Appointment', action: 'CREATE' },
      });

      expect((audit!.after as Record<string, unknown>).forcedOutsideSchedule).toBe(true);
    });

    it('rechaza reservar en el pasado', async () => {
      const response = await book('2020-01-01T10:00:00.000Z').expect(422);
      expect(response.body.code).toBe('APPOINTMENT_IN_THE_PAST');
    });

    it('rechaza un servicio retirado del catálogo', async () => {
      await request(app.getHttpServer())
        .patch(api(`/services/${salonA.serviceId}`))
        .set(auth())
        .send({ isActive: false })
        .expect(200);

      const response = await book(at(10)).expect(422);
      expect(response.body.code).toBe('SERVICE_NOT_BOOKABLE');
    });

    it('rechaza un profesional que no realiza el servicio', async () => {
      const otherService = await request(app.getHttpServer())
        .post(api('/services'))
        .set(auth())
        .send({ code: 'MAN-I', name: 'Manicura', durationMinutes: 30, price: '18.00' })
        .expect(201);

      // Se declaran habilidades: a partir de ahí solo puede hacer las suyas.
      await request(app.getHttpServer())
        .put(api(`/stylists/${salonA.stylistId}/skills`))
        .set(auth())
        .send({ skills: [{ serviceId: salonA.serviceId }] })
        .expect(200);

      const response = await request(app.getHttpServer())
        .post(api('/appointments'))
        .set(auth())
        .send({
          clientId: salonA.clientId,
          stylistId: salonA.stylistId,
          startsAt: at(10),
          serviceIds: [otherService.body.data.id as string],
        })
        .expect(422);

      expect(response.body.code).toBe('STYLIST_CANNOT_PERFORM_SERVICE');
    });

    it('usa la duración propia del profesional cuando la tiene', async () => {
      await request(app.getHttpServer())
        .put(api(`/stylists/${salonA.stylistId}/skills`))
        .set(auth())
        .send({ skills: [{ serviceId: salonA.serviceId, durationMinutes: 30 }] })
        .expect(200);

      const response = await book(at(10)).expect(201);

      // 30 propios + 10 de margen del catálogo.
      expect(response.body.data.durationMinutes).toBe(40);
    });
  });

  describe('solapamiento', () => {
    it('rechaza una cita que pisa otra', async () => {
      await book(at(10)).expect(201);

      const response = await book(at(10, 30)).expect(409);

      expect(response.body.code).toBe('APPOINTMENT_OVERLAP');
    });

    it('acepta dos citas consecutivas', async () => {
      // 10:00-10:55 y 11:00-11:55. Es la reserva más frecuente de una peluquería, y con
      // intervalos cerrados el sistema la rechazaría.
      await book(at(10)).expect(201);
      await book(at(11)).expect(201);
    });

    it('una cita cancelada libera el hueco', async () => {
      const first = await book(at(10)).expect(201);

      await request(app.getHttpServer())
        .patch(api(`/appointments/${first.body.data.id as string}/cancel`))
        .set(auth())
        .send({ reason: 'La clienta ha avisado' })
        .expect(200);

      await book(at(10)).expect(201);
    });

    it('la BASE DE DATOS impide el solapamiento aunque se salte la aplicación', async () => {
      await book(at(10)).expect(201);

      // Se escribe directamente con SQL, esquivando toda la lógica del dominio: es lo que
      // haría una petición simultánea que pasara la comprobación previa antes de que la
      // primera confirmase. Solo la restricción EXCLUDE puede cerrar esa ventana.
      await expect(
        prisma.client.$executeRaw`
          INSERT INTO appointments (id, "tenantId", "clientId", "stylistId", "startsAt", "endsAt", status, source, "estimatedTotal", currency, "createdAt", "updatedAt")
          VALUES (gen_random_uuid()::text, ${salonA.tenantId}, ${salonA.clientId}, ${salonA.stylistId},
                  ${new Date(at(10, 30))}, ${new Date(at(11, 30))}, 'SCHEDULED', 'PHONE', 0, 'GTQ', NOW(), NOW())
        `,
      ).rejects.toThrow();
    });

    it('dos profesionales pueden tener cita a la misma hora', async () => {
      const second = await request(app.getHttpServer())
        .post(api('/stylists'))
        .set(auth())
        .send({ firstName: 'Marta', lastName: 'Delgado' })
        .expect(201);

      await request(app.getHttpServer())
        .put(api(`/stylists/${second.body.data.id as string}/schedule`))
        .set(auth())
        .send({ blocks: [{ dayOfWeek: 4, start: '09:00', end: '20:00' }] })
        .expect(200);

      await book(at(10)).expect(201);

      // La restricción es por profesional, no por salón: dos sillones trabajan a la vez.
      await request(app.getHttpServer())
        .post(api('/appointments'))
        .set(auth())
        .send({
          clientId: salonA.clientId,
          stylistId: second.body.data.id as string,
          startsAt: at(10),
          serviceIds: [salonA.serviceId],
        })
        .expect(201);
    });
  });

  describe('ciclo de vida', () => {
    it('recorre confirmar, empezar y completar', async () => {
      const created = await book(at(10)).expect(201);
      const id = created.body.data.id as string;

      const confirmed = await request(app.getHttpServer())
        .patch(api(`/appointments/${id}/confirm`))
        .set(auth())
        .expect(200);
      expect(confirmed.body.data.status).toBe('CONFIRMED');

      await request(app.getHttpServer())
        .patch(api(`/appointments/${id}/start`))
        .set(auth())
        .expect(200);

      const completed = await request(app.getHttpServer())
        .patch(api(`/appointments/${id}/complete`))
        .set(auth())
        .expect(200);

      expect(completed.body.data.status).toBe('COMPLETED');
      expect(completed.body.data.isFinished).toBe(true);
      expect(completed.body.data.isBlocking).toBe(false);
    });

    it('rechaza una transición imposible con 422', async () => {
      const created = await book(at(10)).expect(201);
      const id = created.body.data.id as string;

      await request(app.getHttpServer())
        .patch(api(`/appointments/${id}/cancel`))
        .set(auth())
        .send({ reason: 'Imprevisto' })
        .expect(200);

      const response = await request(app.getHttpServer())
        .patch(api(`/appointments/${id}/confirm`))
        .set(auth())
        .expect(422);

      expect(response.body.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('mover una cita confirmada la devuelve a pendiente', async () => {
      const created = await book(at(10)).expect(201);
      const id = created.body.data.id as string;

      await request(app.getHttpServer())
        .patch(api(`/appointments/${id}/confirm`))
        .set(auth())
        .expect(200);

      const moved = await request(app.getHttpServer())
        .patch(api(`/appointments/${id}/reschedule`))
        .set(auth())
        .send({ startsAt: at(15) })
        .expect(200);

      // La clienta confirmó *aquella* hora.
      expect(moved.body.data.status).toBe('SCHEDULED');
      expect(moved.body.data.confirmedAt).toBeNull();
      expect(moved.body.data.startsAt).toBe(at(15));
    });

    it('mover una cita no choca consigo misma', async () => {
      const created = await book(at(10)).expect(201);

      // Sin excluirla de la comprobación, mover una cita cinco minutos chocaría siempre.
      await request(app.getHttpServer())
        .patch(api(`/appointments/${created.body.data.id as string}/reschedule`))
        .set(auth())
        .send({ startsAt: at(10, 5) })
        .expect(200);
    });

    it('la auditoría registra el cambio de estado', async () => {
      const created = await book(at(10)).expect(201);

      await request(app.getHttpServer())
        .patch(api(`/appointments/${created.body.data.id as string}/confirm`))
        .set(auth())
        .expect(200);

      const entries = await prisma.client.auditLog.findMany({
        where: { entityType: 'Appointment', action: 'UPDATE' },
      });

      expect(entries).toHaveLength(1);
      expect((entries[0].after as Record<string, unknown>).status).toBe('CONFIRMED');
    });
  });

  describe('disponibilidad', () => {
    it('ofrece huecos alineados a la rejilla', async () => {
      const response = await request(app.getHttpServer())
        .get(api('/appointments/availability'))
        .query({
          stylistId: salonA.stylistId,
          date: THURSDAY,
          serviceIds: salonA.serviceId,
          granularityMinutes: 60,
        })
        .set(auth())
        .expect(200);

      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body.data[0].startsAt).toBe(at(9));
      expect(response.body.data[0].durationMinutes).toBe(55);
    });

    it('descuenta las citas ya reservadas', async () => {
      const before = await request(app.getHttpServer())
        .get(api('/appointments/availability'))
        .query({
          stylistId: salonA.stylistId,
          date: THURSDAY,
          serviceIds: salonA.serviceId,
          granularityMinutes: 60,
        })
        .set(auth())
        .expect(200);

      await book(at(10)).expect(201);

      const after = await request(app.getHttpServer())
        .get(api('/appointments/availability'))
        .query({
          stylistId: salonA.stylistId,
          date: THURSDAY,
          serviceIds: salonA.serviceId,
          granularityMinutes: 60,
        })
        .set(auth())
        .expect(200);

      expect(after.body.data.length).toBeLessThan(before.body.data.length);
      expect(after.body.data.some((slot: { startsAt: string }) => slot.startsAt === at(10))).toBe(
        false,
      );
    });

    it('descuenta las ausencias', async () => {
      await request(app.getHttpServer())
        .post(api(`/stylists/${salonA.stylistId}/time-off`))
        .set(auth())
        .send({ startsAt: at(12), endsAt: at(14), reason: 'Formación' })
        .expect(201);

      const response = await request(app.getHttpServer())
        .get(api('/appointments/availability'))
        .query({
          stylistId: salonA.stylistId,
          date: THURSDAY,
          serviceIds: salonA.serviceId,
          granularityMinutes: 60,
        })
        .set(auth())
        .expect(200);

      expect(
        response.body.data.some((slot: { startsAt: string }) => slot.startsAt === at(12)),
      ).toBe(false);
    });

    it('un día sin horario no tiene huecos', async () => {
      const response = await request(app.getHttpServer())
        .get(api('/appointments/availability'))
        .query({
          stylistId: salonA.stylistId,
          // Viernes: el horario solo cubre los jueves.
          date: '2037-09-11',
          serviceIds: salonA.serviceId,
        })
        .set(auth())
        .expect(200);

      expect(response.body.data).toEqual([]);
    });
  });

  describe('ámbito propio', () => {
    it('la estilista solo ve sus propias citas', async () => {
      const otherStylist = await request(app.getHttpServer())
        .post(api('/stylists'))
        .set(auth())
        .send({ firstName: 'Marta', lastName: 'Delgado' })
        .expect(201);

      await request(app.getHttpServer())
        .put(api(`/stylists/${otherStylist.body.data.id as string}/schedule`))
        .set(auth())
        .send({ blocks: [{ dayOfWeek: 4, start: '09:00', end: '20:00' }] })
        .expect(200);

      await book(at(10)).expect(201); // de la estilista del seed
      await request(app.getHttpServer())
        .post(api('/appointments'))
        .set(auth())
        .send({
          clientId: salonA.clientId,
          stylistId: otherStylist.body.data.id as string,
          startsAt: at(10),
          serviceIds: [salonA.serviceId],
        })
        .expect(201);

      const stylistLogin = await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email: salonA.stylistEmail, password: TEST_PASSWORD })
        .expect(200);

      const response = await request(app.getHttpServer())
        .get(api('/appointments'))
        .set({ Authorization: `Bearer ${stylistLogin.body.data.accessToken as string}` })
        .expect(200);

      // Hay dos citas en el salón; ella solo ve la suya.
      expect(response.body.meta.total).toBe(1);
      expect(response.body.data[0].stylistId).toBe(salonA.stylistId);
    });

    it('pedir la agenda de otra persona no amplía el alcance', async () => {
      const otherStylist = await request(app.getHttpServer())
        .post(api('/stylists'))
        .set(auth())
        .send({ firstName: 'Marta', lastName: 'Delgado' })
        .expect(201);

      const stylistLogin = await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email: salonA.stylistEmail, password: TEST_PASSWORD })
        .expect(200);

      // El filtro del servidor se impone al que envía el cliente.
      const response = await request(app.getHttpServer())
        .get(api('/appointments'))
        .query({ stylistId: otherStylist.body.data.id as string })
        .set({ Authorization: `Bearer ${stylistLogin.body.data.accessToken as string}` })
        .expect(200);

      expect(response.body.meta.total).toBe(0);
    });

    it('la estilista no puede abrir una cita ajena', async () => {
      const otherStylist = await request(app.getHttpServer())
        .post(api('/stylists'))
        .set(auth())
        .send({ firstName: 'Marta', lastName: 'Delgado' })
        .expect(201);

      await request(app.getHttpServer())
        .put(api(`/stylists/${otherStylist.body.data.id as string}/schedule`))
        .set(auth())
        .send({ blocks: [{ dayOfWeek: 4, start: '09:00', end: '20:00' }] })
        .expect(200);

      const foreign = await request(app.getHttpServer())
        .post(api('/appointments'))
        .set(auth())
        .send({
          clientId: salonA.clientId,
          stylistId: otherStylist.body.data.id as string,
          startsAt: at(10),
          serviceIds: [salonA.serviceId],
        })
        .expect(201);

      const stylistLogin = await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email: salonA.stylistEmail, password: TEST_PASSWORD })
        .expect(200);

      await request(app.getHttpServer())
        .get(api(`/appointments/${foreign.body.data.id as string}`))
        .set({ Authorization: `Bearer ${stylistLogin.body.data.accessToken as string}` })
        .expect(403);
    });

    it('la propietaria ve toda la agenda del salón', async () => {
      await book(at(10)).expect(201);

      const response = await request(app.getHttpServer())
        .get(api('/appointments'))
        .set(auth())
        .expect(200);

      expect(response.body.meta.total).toBe(1);
    });
  });

  describe('aislamiento entre salones', () => {
    it('no se ven citas de otro salón', async () => {
      await book(at(10)).expect(201);

      const loginB = await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email: salonB.ownerEmail, password: TEST_PASSWORD })
        .expect(200);

      const response = await request(app.getHttpServer())
        .get(api('/appointments'))
        .set({ Authorization: `Bearer ${loginB.body.data.accessToken as string}` })
        .expect(200);

      expect(response.body.meta.total).toBe(0);
    });

    it('no se puede agendar con un profesional de otro salón', async () => {
      await request(app.getHttpServer())
        .post(api('/appointments'))
        .set(auth())
        .send({
          clientId: salonA.clientId,
          stylistId: salonB.stylistId,
          startsAt: at(10),
          serviceIds: [salonA.serviceId],
        })
        .expect(404);
    });
  });
});
