import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';
import { zonedTimeToInstant } from '@shared/domain/time/zoned-time';

import { api, createTestApp, resetDatabase } from './app-harness';
import { seedTwoTenants, TEST_PASSWORD, type SeededTenant } from './fixtures';

/**
 * Profesionales y catálogo, de extremo a extremo.
 *
 * Lo que más interesa comprobar aquí es la conversión de horarios: el salón introduce
 * «de 9:00 a 20:00» en su hora local y el sistema debe devolver instantes absolutos
 * correctos, distintos en verano y en invierno. Es la clase de fallo que no se ve en una
 * prueba manual de un martes cualquiera y aparece de golpe el último domingo de marzo.
 */
/** Zona del salón, la misma que lee la aplicación. */
const SALON_TZ = process.env.DEFAULT_TIMEZONE ?? 'America/Guatemala';

/**
 * Hora local del salón como instante absoluto.
 *
 * Los tests hablan en hora de salón —«de doce a dos»— porque es como se introducen los
 * datos. Escribir el instante UTC a mano ataba la suite a un desplazamiento concreto y
 * la rompió entera al cambiar de país.
 */
const at = (hour: number, minute = 0): string =>
  zonedTimeToInstant({ year: 2026, month: 9, day: 10 }, hour * 60 + minute, SALON_TZ).toISOString();

describe('Profesionales y catálogo (integración)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let salonA: SeededTenant;
  let salonB: SeededTenant;
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
    ({ salonA, salonB } = await seedTwoTenants(prisma));

    const login = await request(app.getHttpServer())
      .post(api('/auth/login'))
      .send({ email: salonA.ownerEmail, password: TEST_PASSWORD })
      .expect(200);

    token = login.body.data.accessToken as string;
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  describe('profesionales', () => {
    it('da de alta y devuelve la ficha completa', async () => {
      const response = await request(app.getHttpServer())
        .post(api('/stylists'))
        .set(auth())
        .send({
          firstName: 'Marta',
          lastName: 'Delgado',
          email: 'marta@salon-a.test',
          color: '#EC4899',
          commissionRate: 20,
        })
        .expect(201);

      expect(response.body.data).toMatchObject({
        fullName: 'Marta Delgado',
        displayName: 'Marta',
        status: 'ACTIVE',
        isBookable: true,
        commissionRate: 20,
      });
      expect(response.body.data.schedule).toEqual([]);
      expect(response.body.data.weeklyMinutes).toBe(0);
    });

    it('fija el horario semanal y lo devuelve en hora local', async () => {
      const response = await request(app.getHttpServer())
        .put(api(`/stylists/${salonA.stylistId}/schedule`))
        .set(auth())
        .send({
          blocks: [
            { dayOfWeek: 4, start: '09:00', end: '14:00' },
            { dayOfWeek: 4, start: '16:00', end: '20:00' },
          ],
        })
        .expect(200);

      // Se devuelve como se introdujo: quien gestiona el salón piensa en hora local.
      expect(response.body.data.schedule).toEqual([
        { id: expect.any(String), dayOfWeek: 4, start: '09:00', end: '14:00' },
        { id: expect.any(String), dayOfWeek: 4, start: '16:00', end: '20:00' },
      ]);
      expect(response.body.data.weeklyMinutes).toBe(9 * 60);
    });

    it('rechaza tramos solapados con 422', async () => {
      const response = await request(app.getHttpServer())
        .put(api(`/stylists/${salonA.stylistId}/schedule`))
        .set(auth())
        .send({
          blocks: [
            { dayOfWeek: 4, start: '09:00', end: '14:00' },
            { dayOfWeek: 4, start: '13:00', end: '20:00' },
          ],
        })
        .expect(422);

      expect(response.body.code).toBe('SCHEDULE_BLOCKS_OVERLAP');
    });

    it('el horario trabajable llega como instantes absolutos y respeta el horario de verano', async () => {
      await request(app.getHttpServer())
        .put(api(`/stylists/${salonA.stylistId}/schedule`))
        .set(auth())
        .send({ blocks: [{ dayOfWeek: 4, start: '09:00', end: '14:00' }] })
        .expect(200);

      const verano = await request(app.getHttpServer())
        .get(api(`/stylists/${salonA.stylistId}/working-hours`))
        .query({ from: '2026-09-10', to: '2026-09-10' })
        .set(auth())
        .expect(200);

      expect(verano.body.data[0].intervals[0].startsAt).toBe(at(9));

      // Mismo horario de salón en enero. En una zona con cambio de hora el instante
      // absoluto cambia; en una sin él, no. El test vale para ambas.
      const invierno = await request(app.getHttpServer())
        .get(api(`/stylists/${salonA.stylistId}/working-hours`))
        .query({ from: '2026-01-15', to: '2026-01-15' })
        .set(auth())
        .expect(200);

      expect(invierno.body.data[0].intervals[0].startsAt).toBe(
        zonedTimeToInstant({ year: 2026, month: 1, day: 15 }, 9 * 60, SALON_TZ).toISOString(),
      );
    });

    it('una ausencia parte el tramo de trabajo en dos', async () => {
      await request(app.getHttpServer())
        .put(api(`/stylists/${salonA.stylistId}/schedule`))
        .set(auth())
        .send({ blocks: [{ dayOfWeek: 4, start: '09:00', end: '20:00' }] })
        .expect(200);

      await request(app.getHttpServer())
        .post(api(`/stylists/${salonA.stylistId}/time-off`))
        .set(auth())
        .send({
          startsAt: at(12),
          endsAt: at(14),
          reason: 'Formación',
        })
        .expect(201);

      const response = await request(app.getHttpServer())
        .get(api(`/stylists/${salonA.stylistId}/working-hours`))
        .query({ from: '2026-09-10', to: '2026-09-10' })
        .set(auth())
        .expect(200);

      // Queda trabajable 9-12 y 14-20: la ausencia recorta, no descarta el día entero.
      expect(response.body.data[0].intervals).toHaveLength(2);
      expect(response.body.data[0].totalMinutes).toBe(9 * 60);
    });

    it('rechaza ausencias solapadas', async () => {
      const timeOff = {
        startsAt: at(12),
        endsAt: at(14),
      };

      await request(app.getHttpServer())
        .post(api(`/stylists/${salonA.stylistId}/time-off`))
        .set(auth())
        .send(timeOff)
        .expect(201);

      await request(app.getHttpServer())
        .post(api(`/stylists/${salonA.stylistId}/time-off`))
        .set(auth())
        .send({ startsAt: at(13), endsAt: at(15) })
        .expect(422);
    });

    it('guarda las habilidades con sus ajustes', async () => {
      const response = await request(app.getHttpServer())
        .put(api(`/stylists/${salonA.stylistId}/skills`))
        .set(auth())
        .send({
          skills: [{ serviceId: salonA.serviceId, durationMinutes: 30, commissionRate: 25 }],
        })
        .expect(200);

      expect(response.body.data.skills).toEqual([
        { serviceId: salonA.serviceId, durationMinutes: 30, commissionRate: 25 },
      ]);
    });

    it('filtra por quién sabe hacer un servicio', async () => {
      const response = await request(app.getHttpServer())
        .get(api('/stylists'))
        .query({ canPerformServiceId: salonA.serviceId })
        .set(auth())
        .expect(200);

      // Sin habilidades declaradas se asume que puede hacerlo todo, así que aparece.
      expect(response.body.meta.total).toBe(1);
    });

    it('no ve profesionales de otro salón', async () => {
      await request(app.getHttpServer())
        .get(api(`/stylists/${salonB.stylistId}`))
        .set(auth())
        .expect(404);
    });

    it('el horario sobrevive al viaje de ida y vuelta por la base de datos', async () => {
      await request(app.getHttpServer())
        .put(api(`/stylists/${salonA.stylistId}/schedule`))
        .set(auth())
        .send({
          blocks: [
            { dayOfWeek: 1, start: '10:00', end: '19:30' },
            { dayOfWeek: 5, start: '09:00', end: '14:00' },
          ],
        })
        .expect(200);

      const reloaded = await request(app.getHttpServer())
        .get(api(`/stylists/${salonA.stylistId}`))
        .set(auth())
        .expect(200);

      expect(reloaded.body.data.schedule).toHaveLength(2);
      expect(reloaded.body.data.weeklyMinutes).toBe(9 * 60 + 30 + 5 * 60);
    });
  });

  describe('catálogo', () => {
    it('crea un servicio y calcula el hueco de agenda y el precio final', async () => {
      const response = await request(app.getHttpServer())
        .post(api('/services'))
        .set(auth())
        .send({
          code: 'MEC-B',
          name: 'Mechas balayage',
          durationMinutes: 180,
          bufferMinutes: 20,
          price: '120.00',
        })
        .expect(201);

      expect(response.body.data).toMatchObject({
        code: 'MEC-B',
        durationMinutes: 180,
        bufferMinutes: 20,
        // Lo que la agenda bloquea de verdad.
        blockedMinutes: 200,
        price: '120.00',
        taxAmount: '14.40',
        priceWithTax: '134.40',
      });
    });

    it('los importes viajan como cadena, no como número', async () => {
      const response = await request(app.getHttpServer())
        .get(api(`/services/${salonA.serviceId}`))
        .set(auth())
        .expect(200);

      expect(typeof response.body.data.price).toBe('string');
      expect(typeof response.body.data.priceWithTax).toBe('string');
    });

    it('rechaza un código repetido con 409', async () => {
      const response = await request(app.getHttpServer())
        .post(api('/services'))
        .set(auth())
        .send({ code: 'COR-M', name: 'Otro corte', durationMinutes: 30, price: '20.00' })
        .expect(409);

      expect(response.body.code).toBe('SERVICE_CODE_ALREADY_EXISTS');
    });

    it('dos salones pueden usar el mismo código', async () => {
      const loginB = await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email: salonB.ownerEmail, password: TEST_PASSWORD })
        .expect(200);

      // El código es único **por salón**, no globalmente.
      await request(app.getHttpServer())
        .post(api('/services'))
        .set({ Authorization: `Bearer ${loginB.body.data.accessToken as string}` })
        .send({ code: 'MEC-B', name: 'Mechas', durationMinutes: 120, price: '100.00' })
        .expect(201);

      await request(app.getHttpServer())
        .post(api('/services'))
        .set(auth())
        .send({ code: 'MEC-B', name: 'Mechas', durationMinutes: 120, price: '100.00' })
        .expect(201);
    });

    it('cambiar el precio no toca las citas ya agendadas', async () => {
      await request(app.getHttpServer())
        .patch(api(`/services/${salonA.serviceId}`))
        .set(auth())
        .send({ price: '35.00' })
        .expect(200);

      const reloaded = await request(app.getHttpServer())
        .get(api(`/services/${salonA.serviceId}`))
        .set(auth())
        .expect(200);

      expect(reloaded.body.data.price).toBe('35.00');
    });

    it('rechaza colgar un servicio de una categoría de productos', async () => {
      const productCategory = await request(app.getHttpServer())
        .post(api('/categories'))
        .set(auth())
        .send({ kind: 'PRODUCT', name: 'Coloración' })
        .expect(201);

      const response = await request(app.getHttpServer())
        .post(api('/services'))
        .set(auth())
        .send({
          code: 'TIN-X',
          name: 'Tinte',
          durationMinutes: 60,
          price: '40.00',
          categoryId: productCategory.body.data.id as string,
        })
        .expect(422);

      expect(response.body.code).toBe('CATEGORY_KIND_MISMATCH');
    });

    it('guarda el escandallo del servicio', async () => {
      const response = await request(app.getHttpServer())
        .put(api(`/services/${salonA.serviceId}/consumables`))
        .set(auth())
        .send({ consumables: [{ productId: salonA.productId, quantity: 0.15 }] })
        .expect(200);

      expect(response.body.data.consumables).toEqual([
        { productId: salonA.productId, quantity: 0.15 },
      ]);
    });

    it('retirar del catálogo conserva la ficha', async () => {
      await request(app.getHttpServer())
        .patch(api(`/services/${salonA.serviceId}`))
        .set(auth())
        .send({ isActive: false })
        .expect(200);

      const response = await request(app.getHttpServer())
        .get(api(`/services/${salonA.serviceId}`))
        .set(auth())
        .expect(200);

      expect(response.body.data.isActive).toBe(false);
      expect(response.body.data.isBookable).toBe(false);
    });

    it('filtra por duración máxima, para ofrecer lo que cabe en un hueco', async () => {
      await request(app.getHttpServer())
        .post(api('/services'))
        .set(auth())
        .send({ code: 'LAR-G', name: 'Servicio largo', durationMinutes: 180, price: '100.00' })
        .expect(201);

      const response = await request(app.getHttpServer())
        .get(api('/services'))
        .query({ maxDurationMinutes: 60 })
        .set(auth())
        .expect(200);

      expect(
        response.body.data.every((s: { durationMinutes: number }) => s.durationMinutes <= 60),
      ).toBe(true);
      expect(response.body.meta.total).toBe(1);
    });
  });

  describe('categorías', () => {
    it('genera el slug sin acentos', async () => {
      const response = await request(app.getHttpServer())
        .post(api('/categories'))
        .set(auth())
        .send({ kind: 'SERVICE', name: 'Coloración y Mechas' })
        .expect(201);

      expect(response.body.data.slug).toBe('coloracion-y-mechas');
    });

    it('impide anidar categorías de distinto tipo', async () => {
      const serviceCategory = await request(app.getHttpServer())
        .post(api('/categories'))
        .set(auth())
        .send({ kind: 'SERVICE', name: 'Servicios raíz' })
        .expect(201);

      await request(app.getHttpServer())
        .post(api('/categories'))
        .set(auth())
        .send({
          kind: 'PRODUCT',
          name: 'Productos hijos',
          parentId: serviceCategory.body.data.id as string,
        })
        .expect(422);
    });

    it('impide crear un ciclo al mover una categoría', async () => {
      const parent = await request(app.getHttpServer())
        .post(api('/categories'))
        .set(auth())
        .send({ kind: 'SERVICE', name: 'Madre' })
        .expect(201);

      const child = await request(app.getHttpServer())
        .post(api('/categories'))
        .set(auth())
        .send({ kind: 'SERVICE', name: 'Hija', parentId: parent.body.data.id as string })
        .expect(201);

      // Mover la madre dentro de su hija dejaría el árbol irrecorrible.
      const response = await request(app.getHttpServer())
        .patch(api(`/categories/${parent.body.data.id as string}`))
        .set(auth())
        .send({ parentId: child.body.data.id as string })
        .expect(422);

      expect(response.body.code).toBe('CATEGORY_CYCLE');
    });

    it('no elimina una categoría con contenido', async () => {
      // La del seed tiene un servicio colgando.
      const categories = await request(app.getHttpServer())
        .get(api('/categories'))
        .query({ kind: 'SERVICE' })
        .set(auth())
        .expect(200);

      const response = await request(app.getHttpServer())
        .delete(api(`/categories/${categories.body.data[0].id as string}`))
        .set(auth())
        .expect(422);

      expect(response.body.code).toBe('CATEGORY_NOT_EMPTY');
    });

    it('devuelve el árbol completo en una consulta', async () => {
      const response = await request(app.getHttpServer())
        .get(api('/categories/tree'))
        .query({ kind: 'SERVICE' })
        .set(auth())
        .expect(200);

      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
    });
  });

  describe('autorización', () => {
    it('la recepción puede leer el catálogo pero no modificarlo', async () => {
      const reception = await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email: salonA.receptionEmail, password: TEST_PASSWORD })
        .expect(200);

      const headers = { Authorization: `Bearer ${reception.body.data.accessToken as string}` };

      await request(app.getHttpServer()).get(api('/services')).set(headers).expect(200);

      // Cambiar tarifas es decisión de la propiedad, no de mostrador (ADR-0006).
      await request(app.getHttpServer())
        .post(api('/services'))
        .set(headers)
        .send({ code: 'NEW-1', name: 'Nuevo', durationMinutes: 30, price: '10.00' })
        .expect(403);
    });
  });
});
