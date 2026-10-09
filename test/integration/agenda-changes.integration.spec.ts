import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';
import { zonedTimeToInstant } from '@shared/domain/time/zoned-time';

import { api, createTestApp, resetDatabase } from './app-harness';
import { seedTwoTenants, TEST_PASSWORD, type SeededTenant } from './fixtures';

/**
 * Agenda: cambios que pide la profesional, bloqueos, recordatorios y enlace de la clienta.
 *
 * Lo que aquí importa son los **permisos** y el **aislamiento**: que la profesional no
 * pueda mover su cita sin la encargada, que recepción no decida por la encargada, que
 * nadie se salte el horario sin permiso, y que un enlace de confirmación solo abra su cita
 * y en su salón.
 */
const SALON_TZ = process.env.DEFAULT_TIMEZONE ?? 'America/Guatemala';

describe('Agenda: cambios, bloqueos y recordatorios (integración)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let salonA: SeededTenant;
  let salonB: SeededTenant;
  let owner: string;
  let reception: string;
  let stylist: string;

  /** Jueves futuro estable. */
  const at = (hour: number, minute = 0): string =>
    zonedTimeToInstant(
      { year: 2037, month: 9, day: 10 },
      hour * 60 + minute,
      SALON_TZ,
    ).toISOString();

  const login = async (email: string) =>
    (
      await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email, password: TEST_PASSWORD })
        .expect(200)
    ).body.data.accessToken as string;

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    ({ salonA, salonB } = await seedTwoTenants(prisma));
    owner = await login(salonA.ownerEmail);
    reception = await login(salonA.receptionEmail);
    stylist = await login(salonA.stylistEmail);

    await request(app.getHttpServer())
      .put(api(`/stylists/${salonA.stylistId}/schedule`))
      .set(as(owner))
      .send({ blocks: [{ dayOfWeek: 4, start: '09:00', end: '20:00' }] })
      .expect(200);
  });

  const book = (startsAt: string, token = reception, extra: Record<string, unknown> = {}) =>
    request(app.getHttpServer())
      .post(api('/appointments'))
      .set(as(token))
      .send({
        clientId: salonA.clientId,
        stylistId: salonA.stylistId,
        startsAt,
        serviceIds: [salonA.serviceId],
        ...extra,
      });

  it('el calendario trae profesional, servicios y teléfono ya resueltos', async () => {
    await book(at(10)).expect(201);
    const calendar = await request(app.getHttpServer())
      .get(api('/appointments/calendar'))
      .query({ from: at(8), to: at(20) })
      .set(as(reception))
      .expect(200);

    expect(calendar.body.data[0]).toMatchObject({
      stylistName: 'Sara',
      clientPhone: '+34600111222',
      services: [expect.objectContaining({ name: 'Corte de señora' })],
      pendingChange: null,
      lastReminder: null,
    });
  });

  describe('la profesional pide, la encargada decide', () => {
    it('pedir no mueve la cita; aprobar la mueve y la profesional ve la respuesta', async () => {
      const booked = (await book(at(10)).expect(201)).body.data;

      const asked = await request(app.getHttpServer())
        .post(api(`/appointments/${booked.id}/change-requests`))
        .set(as(stylist))
        .send({ startsAt: at(15), reason: 'La clienta sale tarde del trabajo' })
        .expect(201);
      expect(asked.body.data).toMatchObject({ status: 'PENDING', clientName: 'Rosa Iglesias' });

      const count = await request(app.getHttpServer())
        .get(api('/agenda/change-requests/pending-count'))
        .set(as(owner))
        .expect(200);
      expect(count.body.data.count).toBe(1);

      const still = await request(app.getHttpServer())
        .get(api(`/appointments/${booked.id}`))
        .set(as(owner))
        .expect(200);
      expect(still.body.data).toMatchObject({
        startsAt: at(10),
        pendingChange: expect.objectContaining({ proposedStartsAt: at(15) }),
      });

      await request(app.getHttpServer())
        .patch(api(`/agenda/change-requests/${asked.body.data.id}/approve`))
        .set(as(owner))
        .send({ note: 'Hecho' })
        .expect(200);

      const moved = await request(app.getHttpServer())
        .get(api(`/appointments/${booked.id}`))
        .set(as(owner))
        .expect(200);
      expect(moved.body.data).toMatchObject({ startsAt: at(15), pendingChange: null });

      const mine = await request(app.getHttpServer())
        .get(api('/agenda/change-requests'))
        .set(as(stylist))
        .expect(200);
      expect(mine.body.data).toEqual([
        expect.objectContaining({ status: 'APPROVED', decisionNote: 'Hecho' }),
      ]);
    });

    it('la profesional no puede mover su cita directamente ni saltarse el horario', async () => {
      const booked = (await book(at(10)).expect(201)).body.data;

      await request(app.getHttpServer())
        .patch(api(`/appointments/${booked.id}/reschedule`))
        .set(as(stylist))
        .send({ startsAt: at(15) })
        .expect(403);

      const forced = await book(at(21), stylist, { force: true }).expect(403);
      expect(forced.body.code).toBe('FORBIDDEN_ACTION');
    });

    it('recepción puede forzar el horario, pero no decide sobre los cambios del equipo', async () => {
      await book(at(21), reception, { force: true }).expect(201);
      const booked = (await book(at(10)).expect(201)).body.data;
      const asked = await request(app.getHttpServer())
        .post(api(`/appointments/${booked.id}/change-requests`))
        .set(as(stylist))
        .send({ startsAt: at(15) })
        .expect(201);

      await request(app.getHttpServer())
        .patch(api(`/agenda/change-requests/${asked.body.data.id}/approve`))
        .set(as(reception))
        .send({})
        .expect(403);
      await request(app.getHttpServer())
        .get(api('/agenda/change-requests/pending-count'))
        .set(as(reception))
        .expect(403);
    });

    it('como mucho una petición pendiente por cita', async () => {
      const booked = (await book(at(10)).expect(201)).body.data;
      const ask = (startsAt: string) =>
        request(app.getHttpServer())
          .post(api(`/appointments/${booked.id}/change-requests`))
          .set(as(stylist))
          .send({ startsAt });

      await ask(at(15)).expect(201);
      const second = await ask(at(16)).expect(409);
      expect(second.body.code).toBe('CHANGE_REQUEST_ALREADY_PENDING');
    });
  });

  it('la disponibilidad de la profesional se limita a su agenda', async () => {
    const slots = await request(app.getHttpServer())
      .get(api('/appointments/availability'))
      .query({ date: '2037-09-10', serviceIds: salonA.serviceId })
      .set(as(stylist))
      .expect(200);

    expect(slots.body.data.length).toBeGreaterThan(0);
    expect(new Set(slots.body.data.map((slot: { stylistId: string }) => slot.stylistId))).toEqual(
      new Set([salonA.stylistId]),
    );
  });

  describe('bloqueos', () => {
    it('no tapan citas, se ven en la jornada y se pueden quitar', async () => {
      await book(at(10)).expect(201);
      const block = (startsAt: string, endsAt: string) =>
        request(app.getHttpServer())
          .post(api('/agenda/blocks'))
          .set(as(owner))
          .send({ stylistId: salonA.stylistId, startsAt, endsAt, reason: 'Comida' });

      expect((await block(at(10), at(11)).expect(409)).body.code).toBe(
        'BLOCK_OVERLAPS_APPOINTMENTS',
      );
      const created = await block(at(13), at(14)).expect(201);

      const shifts = await request(app.getHttpServer())
        .get(api('/agenda/shifts'))
        .query({ from: '2037-09-10', to: '2037-09-10' })
        .set(as(reception))
        .expect(200);
      expect(shifts.body.data[0].blocks).toEqual([
        expect.objectContaining({ id: created.body.data.id, reason: 'Comida' }),
      ]);

      await request(app.getHttpServer())
        .delete(api(`/agenda/blocks/${salonA.stylistId}/${created.body.data.id}`))
        .set(as(owner))
        .expect(204);
    });

    it('recepción no gestiona horarios', async () => {
      await request(app.getHttpServer())
        .post(api('/agenda/blocks'))
        .set(as(reception))
        .send({ stylistId: salonA.stylistId, startsAt: at(13), endsAt: at(14) })
        .expect(403);
    });
  });

  describe('recordatorio y enlace de la clienta', () => {
    const tokenOf = (message: string) => /\/cita\/([\w-]+)/.exec(message)![1];

    it('el enlace confirma la cita sin sesión, y solo esa cita', async () => {
      const booked = (await book(at(10)).expect(201)).body.data;
      const prepared = await request(app.getHttpServer())
        .post(api(`/appointments/${booked.id}/reminder`))
        .set(as(reception))
        .expect(201);
      expect(prepared.body.data.whatsappUrl).toMatch(/^https:\/\/wa\.me\/34600111222\?text=/);
      const token = tokenOf(prepared.body.data.message);

      const view = await request(app.getHttpServer())
        .get(api(`/public/appointment-links/${token}`))
        .expect(200);
      expect(view.body.data).toMatchObject({
        clientFirstName: 'Rosa',
        status: 'SCHEDULED',
        canConfirm: true,
      });
      // Lo que ve la clienta no incluye datos internos.
      expect(view.body.data).not.toHaveProperty('clientPhone');
      expect(view.body.data).not.toHaveProperty('internalNotes');

      await request(app.getHttpServer())
        .post(api(`/public/appointment-links/${token}/confirm`))
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(api(`/appointments/${booked.id}`))
        .set(as(owner))
        .expect(200);
      expect(after.body.data).toMatchObject({
        status: 'CONFIRMED',
        lastReminder: expect.objectContaining({ channel: 'MANUAL', status: 'SENT' }),
      });
    });

    it('un enlace inventado o sustituido no abre nada', async () => {
      const booked = (await book(at(10)).expect(201)).body.data;
      const first = tokenOf(
        (
          await request(app.getHttpServer())
            .post(api(`/appointments/${booked.id}/reminder`))
            .set(as(reception))
            .expect(201)
        ).body.data.message,
      );
      await request(app.getHttpServer())
        .post(api(`/appointments/${booked.id}/reminder`))
        .set(as(reception))
        .expect(201);

      await request(app.getHttpServer())
        .get(api(`/public/appointment-links/${first}`))
        .expect(404);
      await request(app.getHttpServer())
        .get(api('/public/appointment-links/inventadoinventadoinventado'))
        .expect(404);
    });

    it('cancelar desde el enlace libera el hueco y queda el motivo', async () => {
      const booked = (await book(at(10)).expect(201)).body.data;
      const token = tokenOf(
        (
          await request(app.getHttpServer())
            .post(api(`/appointments/${booked.id}/reminder`))
            .set(as(reception))
            .expect(201)
        ).body.data.message,
      );

      await request(app.getHttpServer())
        .post(api(`/public/appointment-links/${token}/cancel`))
        .send({ reason: 'Me salió un viaje' })
        .expect(200);

      const after = await request(app.getHttpServer())
        .get(api(`/appointments/${booked.id}`))
        .set(as(owner))
        .expect(200);
      expect(after.body.data.status).toBe('CANCELLED');
      expect(after.body.data.cancellationReason).toContain('Me salió un viaje');
      await book(at(10)).expect(201);
    });

    it('el otro salón no ve las peticiones de este', async () => {
      const booked = (await book(at(10)).expect(201)).body.data;
      await request(app.getHttpServer())
        .post(api(`/appointments/${booked.id}/change-requests`))
        .set(as(stylist))
        .send({ startsAt: at(15) })
        .expect(201);

      const rival = await login(salonB.ownerEmail);
      const list = await request(app.getHttpServer())
        .get(api('/agenda/change-requests'))
        .set(as(rival))
        .expect(200);
      expect(list.body.data).toEqual([]);
    });
  });
});
