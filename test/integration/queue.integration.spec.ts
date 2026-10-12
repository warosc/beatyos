import type { INestApplication, MessageEvent } from '@nestjs/common';
import { firstValueFrom, filter, take, type Observable } from 'rxjs';
import request from 'supertest';

import { InMemoryAgendaEvents } from '@salon/appointments/infrastructure/realtime/in-memory-agenda-events';
import { PublicQueueDisplayController } from '@salon/queue/infrastructure/http/public-queue-display.controller';
import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';
import { QueryScopeStore } from '@shared/infrastructure/persistence/prisma/query-scope';

import { api, createTestApp, resetDatabase } from './app-harness';
import { seedTwoTenants, TEST_PASSWORD, type SeededTenant } from './fixtures';

/**
 * Fila de espera de extremo a extremo (ADR-0024).
 *
 * Lo que los unitarios no pueden probar: que la migración y sus invariantes existen, que el
 * ámbito `.own` se resuelve desde un JWT real, que dos «llamar siguiente» simultáneos no se
 * llevan a la misma clienta, que la numeración del día no se repite bajo concurrencia y que
 * la pantalla pública solo enseña lo de su salón.
 */
describe('Fila de espera (integración)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let salonA: SeededTenant;
  let salonB: SeededTenant;
  let ownerToken: string;
  let receptionToken: string;
  let stylistToken: string;

  /** Segunda profesional del salón A, sin cuenta: la maneja recepción. */
  const VALERIA = '11110009-0000-7000-8000-000000000009';
  /** Un segundo servicio que Valeria no hace. */
  const COLOR = '11110008-0000-7000-8000-000000000008';
  const TOTAL = '30.25';

  beforeAll(async () => {
    const context = await createTestApp();
    app = context.app;
    prisma = context.prisma;
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const inspect = <T>(work: () => Promise<T>): Promise<T> => QueryScopeStore.crossTenant(work);

  const loginAs = async (email: string): Promise<string> => {
    const res = await request(server())
      .post(api('/auth/login'))
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  };

  /** Usuario del salón A con un rol a medida, para probar combinaciones de permisos. */
  const userWith = async (local: string, codes: string[]): Promise<string> => {
    const email = `${local}@salon-a.test`;
    await inspect(async () => {
      const owner = await prisma.client.user.findFirstOrThrow({
        where: { email: salonA.ownerEmail },
      });
      const permissions = await prisma.client.permission.findMany({
        where: { code: { in: codes } },
      });
      const role = await prisma.client.role.create({
        data: {
          tenantId: salonA.tenantId,
          code: `custom-${local}`,
          name: `A medida ${local}`,
          permissions: { create: permissions.map((p) => ({ permissionId: p.id })) },
        },
      });
      await prisma.client.user.create({
        data: {
          tenantId: salonA.tenantId,
          email,
          passwordHash: owner.passwordHash,
          firstName: 'Prueba',
          lastName: local,
          status: 'ACTIVE',
          roles: { create: { roleId: role.id } },
        },
      });
    });
    return loginAs(email);
  };

  beforeEach(async () => {
    await resetDatabase(prisma);
    ({ salonA, salonB } = await seedTwoTenants(prisma));
    ownerToken = await loginAs(salonA.ownerEmail);
    receptionToken = await loginAs(salonA.receptionEmail);
    stylistToken = await loginAs(salonA.stylistEmail);

    await inspect(async () => {
      const service = await prisma.client.service.findFirstOrThrow({
        where: { id: salonA.serviceId },
      });
      await prisma.client.service.create({
        data: {
          id: COLOR,
          tenantId: salonA.tenantId,
          categoryId: service.categoryId,
          code: 'TIN-C',
          name: 'Tinte completo',
          durationMinutes: 90,
          price: '60.50',
          taxRate: '21.00',
        },
      });
      await prisma.client.stylist.create({
        data: {
          id: VALERIA,
          tenantId: salonA.tenantId,
          firstName: 'Valeria',
          lastName: 'Paz',
          commissionRate: '10.00',
          // Solo corta: el tinte no es suyo.
          skills: { create: { tenantId: salonA.tenantId, serviceId: salonA.serviceId } },
        },
      });
    });
  });

  const walkIn = (body: Record<string, unknown> = {}, token = receptionToken) =>
    request(server())
      .post(api('/queue'))
      .set(auth(token))
      .send({ clientName: 'Clienta de paso', serviceIds: [salonA.serviceId], ...body });

  const next = (token = stylistToken, body: Record<string, unknown> = {}) =>
    request(server()).post(api('/queue/next')).set(auth(token)).send(body);

  const act = (id: string, action: string, token = stylistToken, body = {}) =>
    request(server())
      .post(api(`/queue/${id}/${action}`))
      .set(auth(token))
      .send(body);

  const board = (token = receptionToken) =>
    request(server()).get(api('/queue')).set(auth(token)).expect(200);

  const issueDisplayLink = async (token = ownerToken): Promise<string> =>
    (await request(server()).post(api('/queue/display-link')).set(auth(token)).expect(201)).body
      .data.token as string;

  // ===========================================================================

  it('recepción anota, la estilista llama a la siguiente y la pantalla la anuncia', async () => {
    const first = await walkIn({ clientId: salonA.clientId }).expect(201);
    const second = await walkIn({ clientName: 'Marta López' }).expect(201);

    expect(first.body.data).toMatchObject({
      number: 1,
      status: 'WAITING',
      clientName: 'Rosa Iglesias',
      serviceNames: ['Corte de señora'],
      position: 1,
    });
    expect(second.body.data).toMatchObject({ number: 2, position: 2 });

    const called = await next().expect(200);
    expect(called.body.data.turn).toMatchObject({
      id: first.body.data.id,
      status: 'CALLED',
      stylistName: 'Sara',
      callCount: 1,
      position: null,
    });

    const token = await issueDisplayLink();
    const screen = await request(server())
      .get(api(`/public/queue-display/${token}`))
      .expect(200);
    expect(screen.body.data).toMatchObject({
      salonName: 'Salón salon-a',
      called: [{ number: 1, publicName: 'Rosa I.', stylistName: 'Sara', callCount: 1 }],
      waiting: [2],
      waitingCount: 1,
    });
    // La pantalla es pública: nada que no se vea ya en la sala.
    expect(JSON.stringify(screen.body)).not.toContain('Iglesias');
    expect(JSON.stringify(screen.body)).not.toContain(salonA.clientId);
  });

  it('terminar crea la comanda que caja cobra y cierra el turno con ella', async () => {
    const turn = (await walkIn({ clientId: salonA.clientId }).expect(201)).body.data;
    await next().expect(200);
    await act(turn.id, 'start').expect(200);

    const finished = await act(turn.id, 'finish', stylistToken, {
      serviceIds: [salonA.serviceId],
      notes: 'Puntas',
    }).expect(200);

    expect(finished.body.data.turn).toMatchObject({ status: 'DONE' });
    expect(finished.body.data.ticket).toMatchObject({
      status: 'PENDING',
      stylistId: salonA.stylistId,
      clientId: salonA.clientId,
      total: TOTAL,
      notes: 'Puntas',
    });
    expect(finished.body.data.turn.serviceTicketId).toBe(finished.body.data.ticket.id);

    const pending = await request(server())
      .get(api('/service-tickets?status=PENDING'))
      .set(auth(receptionToken))
      .expect(200);
    expect(pending.body.data.map((t: { id: string }) => t.id)).toEqual([
      finished.body.data.ticket.id,
    ]);
  });

  it('si la comanda no se puede registrar, el turno sigue en atención', async () => {
    const turn = (await walkIn().expect(201)).body.data;
    await next().expect(200);

    // Sara no tiene el tinte entre sus habilidades una vez que se le asignan solo cortes.
    await inspect(() =>
      prisma.client.stylistService.create({
        data: {
          tenantId: salonA.tenantId,
          stylistId: salonA.stylistId,
          serviceId: salonA.serviceId,
        },
      }),
    );
    await act(turn.id, 'finish', stylistToken, { serviceIds: [COLOR] }).expect(422);

    const row = await inspect(() =>
      prisma.client.queueTurn.findUniqueOrThrow({ where: { id: turn.id } }),
    );
    expect(row).toMatchObject({ status: 'CALLED', serviceTicketId: null });
    expect(await inspect(() => prisma.client.serviceTicket.count())).toBe(0);
  });

  it('dos «siguiente» a la vez se llevan clientas distintas', async () => {
    await walkIn({ clientName: 'Primera' }).expect(201);
    await walkIn({ clientName: 'Segunda' }).expect(201);

    const [sara, valeria] = await Promise.all([
      next(stylistToken).expect(200),
      next(receptionToken, { stylistId: VALERIA }).expect(200),
    ]);

    const names = [sara.body.data.turn.clientName, valeria.body.data.turn.clientName].sort();
    expect(names).toEqual(['Primera', 'Segunda']);
  });

  it('con una sola en la fila, una se la lleva y la otra se queda sin nadie', async () => {
    await walkIn().expect(201);

    const results = await Promise.all([
      next(stylistToken).expect(200),
      next(receptionToken, { stylistId: VALERIA }).expect(200),
    ]);

    expect(results.filter((res) => res.body.data.turn !== null)).toHaveLength(1);
  });

  it('una profesional no tiene dos clientas a la vez, ni aunque se salte la aplicación', async () => {
    await walkIn({ clientName: 'Primera' }).expect(201);
    const second = (await walkIn({ clientName: 'Segunda' }).expect(201)).body.data;
    await next().expect(200);

    const busy = await next().expect(409);
    expect(busy.body.code).toBe('QUEUE_STYLIST_BUSY');

    // La garantía es de la base: el índice único parcial rechaza la escritura directa.
    await expect(
      inspect(() =>
        prisma.client.queueTurn.update({
          where: { id: second.id },
          data: { status: 'CALLED', stylistId: salonA.stylistId, calledAt: new Date() },
        }),
      ),
    ).rejects.toThrow();
  });

  it('la numeración del día no se repite aunque se anote a la vez desde varios sitios', async () => {
    const created = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        walkIn({ clientName: `Clienta ${index}` }).expect(201),
      ),
    );

    const numbers = created.map((res) => res.body.data.number as number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('la base rechaza estados incoherentes', async () => {
    const turn = (await walkIn().expect(201)).body.data;

    // Atendida sin comanda, o cerrada sin fecha de cierre.
    await expect(
      inspect(() =>
        prisma.client.queueTurn.update({
          where: { id: turn.id },
          data: { status: 'DONE', stylistId: salonA.stylistId, closedAt: new Date() },
        }),
      ),
    ).rejects.toThrow(/queue_turns_done_ck/);
    await expect(
      inspect(() =>
        prisma.client.queueTurn.update({ where: { id: turn.id }, data: { status: 'CANCELLED' } }),
      ),
    ).rejects.toThrow(/queue_turns_closed_ck/);
  });

  it('no anota dos veces a la misma clienta', async () => {
    await walkIn({ clientId: salonA.clientId }).expect(201);
    const again = await walkIn({ clientId: salonA.clientId }).expect(409);
    expect(again.body.code).toBe('QUEUE_CLIENT_ALREADY_WAITING');
  });

  it('recepción asigna a otra profesional, vuelve a llamar, devuelve a la fila y cancela', async () => {
    const turn = (await walkIn({ preferredStylistId: salonA.stylistId }).expect(201)).body.data;
    expect(turn.preferredStylistName).toBe('Sara');

    // Valeria no se la lleva con «siguiente»: la clienta pidió a Sara.
    expect(
      (await next(receptionToken, { stylistId: VALERIA }).expect(200)).body.data.turn,
    ).toBeNull();

    const called = await act(turn.id, 'call', receptionToken, { stylistId: VALERIA }).expect(200);
    expect(called.body.data).toMatchObject({ status: 'CALLED', stylistName: 'Valeria' });

    const recalled = await act(turn.id, 'recall', receptionToken).expect(200);
    expect(recalled.body.data.callCount).toBe(2);

    const back = await act(turn.id, 'requeue', receptionToken).expect(200);
    expect(back.body.data).toMatchObject({ status: 'WAITING', stylistId: null, position: 1 });

    const cancelled = await act(turn.id, 'cancel', receptionToken, { reason: 'Se fue' }).expect(
      200,
    );
    expect(cancelled.body.data).toMatchObject({
      status: 'CANCELLED',
      cancellationReason: 'Se fue',
      position: null,
    });

    const audit = await inspect(() =>
      prisma.client.auditLog.count({ where: { entityType: 'QueueTurn', entityId: turn.id } }),
    );
    expect(audit).toBe(5);
  });

  it('recepción no asigna un servicio que la profesional no hace', async () => {
    const turn = (await walkIn({ serviceIds: [COLOR] }).expect(201)).body.data;
    const res = await act(turn.id, 'call', receptionToken, { stylistId: VALERIA }).expect(422);
    expect(res.body.code).toBe('SERVICE_NOT_ASSIGNED');
  });

  it('la estilista ve solo lo que puede atender, y no anota, asigna ni cancela', async () => {
    await walkIn({ clientName: 'Pide a Valeria', preferredStylistId: VALERIA }).expect(201);
    const mine = (await walkIn({ clientName: 'Para cualquiera' }).expect(201)).body.data;

    const view = await board(stylistToken);
    expect(view.body.data.turns.map((t: { clientName: string }) => t.clientName)).toEqual([
      'Para cualquiera',
    ]);
    expect(view.body.data.turns[0].position).toBe(2);

    await walkIn({}, stylistToken).expect(403);
    await act(mine.id, 'call', stylistToken, { stylistId: salonA.stylistId }).expect(403);
    await act(mine.id, 'cancel', stylistToken).expect(403);
  });

  it('la estilista llama siempre a su nombre y no toca los turnos de otra', async () => {
    await walkIn({ clientName: 'Primera' }).expect(201);
    const forValeria = (await walkIn({ clientName: 'Segunda' }).expect(201)).body.data;

    const mine = await next(stylistToken, { stylistId: VALERIA }).expect(200);
    expect(mine.body.data.turn.stylistId).toBe(salonA.stylistId);

    await act(forValeria.id, 'call', receptionToken, { stylistId: VALERIA }).expect(200);
    await act(forValeria.id, 'no-show', stylistToken).expect(404);
    await act(forValeria.id, 'finish', stylistToken, { serviceIds: [salonA.serviceId] }).expect(
      404,
    );

    // La de Valeria la cierra recepción.
    const absent = await act(forValeria.id, 'no-show', receptionToken).expect(200);
    expect(absent.body.data.status).toBe('NO_SHOW');
  });

  it('terminar exige poder registrar comandas', async () => {
    const caller = await userWith('llamadora', ['queue.read', 'queue.attend']);
    const turn = (await walkIn().expect(201)).body.data;
    await next(caller, { stylistId: VALERIA }).expect(200);

    const res = await act(turn.id, 'finish', caller, { serviceIds: [salonA.serviceId] }).expect(
      403,
    );
    expect(res.body.code).toBe('FORBIDDEN_ACTION');

    // Recepción sí, a nombre de la profesional que la atendió.
    const done = await act(turn.id, 'finish', receptionToken, {
      serviceIds: [salonA.serviceId],
    }).expect(200);
    expect(done.body.data.ticket.stylistId).toBe(VALERIA);
  });

  it('una cuenta `.own` sin ficha profesional no ve la fila ni llama', async () => {
    const orphan = await userWith('sin-ficha', ['queue.read.own', 'queue.attend.own']);
    await walkIn().expect(201);

    expect((await board(orphan)).body.data.turns).toEqual([]);
    const res = await next(orphan).expect(403);
    expect(res.body.detail).toMatch(/ficha profesional/);
  });

  it('quien atiende en nombre de todas tiene que decir con quién', async () => {
    await walkIn().expect(201);

    const res = await next(receptionToken).expect(400);
    expect(res.body.detail).toMatch(/profesional/);
  });

  it('el enlace de la pantalla: solo con permiso, se sustituye y uno inventado no abre nada', async () => {
    await request(server()).get(api('/queue/display-link')).set(auth(receptionToken)).expect(403);
    await request(server()).post(api('/queue/display-link')).set(auth(receptionToken)).expect(403);

    const status = () =>
      request(server()).get(api('/queue/display-link')).set(auth(ownerToken)).expect(200);
    expect((await status()).body.data).toEqual({ active: false });

    const first = await issueDisplayLink();
    expect((await status()).body.data).toEqual({ active: true });
    const second = await issueDisplayLink();

    await request(server())
      .get(api(`/public/queue-display/${first}`))
      .expect(404);
    await request(server())
      .get(api(`/public/queue-display/${second}`))
      .expect(200);
    await request(server()).get(api('/public/queue-display/corto')).expect(404);
    await request(server()).get(api('/public/queue-display/AAAAAAAAAAAAAAAAAAAAAAAA')).expect(404);

    const stored = await inspect(() =>
      prisma.client.tenant.findUniqueOrThrow({ where: { id: salonA.tenantId } }),
    );
    expect(stored.queueDisplayTokenHash).not.toBe(second);
    expect(stored.queueDisplayTokenHash).toHaveLength(64);
  });

  it('un salón suspendido no enseña su fila aunque tenga enlace', async () => {
    const token = await issueDisplayLink();
    await inspect(() =>
      prisma.client.tenant.update({
        where: { id: salonA.tenantId },
        data: { status: 'SUSPENDED' },
      }),
    );

    await request(server())
      .get(api(`/public/queue-display/${token}`))
      .expect(404);
  });

  it('otro salón no ve, ni llama, ni enseña en su pantalla la fila ajena', async () => {
    const turn = (await walkIn({ clientName: 'Clienta de A' }).expect(201)).body.data;
    const receptionB = await loginAs(salonB.receptionEmail);
    const ownerB = await loginAs(salonB.ownerEmail);

    expect((await board(receptionB)).body.data.turns).toEqual([]);
    await act(turn.id, 'call', receptionB, { stylistId: salonB.stylistId }).expect(404);
    await act(turn.id, 'cancel', receptionB).expect(404);

    const tokenB = await issueDisplayLink(ownerB);
    const screenB = await request(server())
      .get(api(`/public/queue-display/${tokenB}`))
      .expect(200);
    expect(screenB.body.data).toMatchObject({ salonName: 'Salón salon-b', waitingCount: 0 });
  });

  it('el canal de la pantalla avisa cuando cambia la fila, y solo de su salón', async () => {
    await issueDisplayLink();
    const controller = app.get(PublicQueueDisplayController);
    const events = app.get(InMemoryAgendaEvents);

    // El salón lo resuelve el guard del enlace; aquí se le pasa ya resuelto.
    const stream: Observable<MessageEvent> = controller.stream({
      tenantId: salonA.tenantId,
      name: 'Salón salon-a',
    });
    const firstQueueSignal = firstValueFrom(
      stream.pipe(
        filter((event) => (event.data as { kind: string }).kind === 'queue'),
        take(1),
      ),
    );

    // Lo de otro salón y lo que no es de la fila no llega.
    events.publish({ tenantId: salonB.tenantId, kind: 'queue', stylistIds: [], at: new Date() });
    events.publish({
      tenantId: salonA.tenantId,
      kind: 'appointment',
      stylistIds: [],
      at: new Date(),
    });
    await walkIn().expect(201);

    await expect(firstQueueSignal).resolves.toMatchObject({ data: { kind: 'queue' } });
  });

  it('un enlace retirado no abre el canal: es un 404, no un canal que se corta', async () => {
    const first = await issueDisplayLink();
    await issueDisplayLink();

    // Si el canal llegara a abrirse, la petición no terminaría nunca y el test se colgaría.
    for (const token of [first, 'inventado-pero-largo-de-verdad', 'corto']) {
      const res = await request(server())
        .get(api(`/public/queue-display/${token}/stream`))
        .set('Accept', 'text/event-stream')
        .expect(404);
      expect(res.headers['content-type']).toContain('json');
    }
  });
});
