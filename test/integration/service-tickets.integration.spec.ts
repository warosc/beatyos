import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';
import { QueryScopeStore } from '@shared/infrastructure/persistence/prisma/query-scope';

import { api, createTestApp, resetDatabase } from './app-harness';
import { seedTwoTenants, TEST_PASSWORD, type SeededTenant } from './fixtures';

/**
 * Comandas de servicio de extremo a extremo (ADR-0019).
 *
 * Lo que los unitarios no pueden probar: que la migración y sus invariantes existen, que el
 * ámbito `.own` se resuelve desde un JWT real, que factura y comanda se confirman en la
 * misma transacción y que dos cobros simultáneos no facturan dos veces.
 */
describe('Comandas de servicio (integración)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let salonA: SeededTenant;
  let salonB: SeededTenant;
  let stylistToken: string;
  let receptionToken: string;

  // El servicio del seed vale 30,25 con el IVA dentro: 25,00 de base más el 21 %.
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

  beforeEach(async () => {
    await resetDatabase(prisma);
    ({ salonA, salonB } = await seedTwoTenants(prisma));
    stylistToken = await loginAs(salonA.stylistEmail);
    receptionToken = await loginAs(salonA.receptionEmail);
  });

  const registerTicket = (token = stylistToken, body: Record<string, unknown> = {}) =>
    request(server())
      .post(api('/service-tickets'))
      .set(auth(token))
      .send({ clientId: salonA.clientId, serviceIds: [salonA.serviceId], ...body });

  const charge = (ticketId: string, token = receptionToken) =>
    request(server())
      .post(api(`/service-tickets/${ticketId}/charge`))
      .set(auth(token))
      .send({ payments: [{ method: 'CARD', amount: Number(TOTAL) }] });

  it('la estilista registra lo que hizo y caja lo ve pendiente con su importe', async () => {
    const created = await registerTicket().expect(201);

    expect(created.body.data).toMatchObject({
      status: 'PENDING',
      stylistId: salonA.stylistId,
      total: TOTAL,
    });

    const pending = await request(server())
      .get(api('/service-tickets?status=PENDING'))
      .set(auth(receptionToken))
      .expect(200);

    expect(pending.body.data).toHaveLength(1);
    expect(pending.body.data[0].lines[0].lineTotal).toBe(TOTAL);
  });

  it('la estilista solo declara a su nombre, aunque envíe otra profesional', async () => {
    const created = await registerTicket(stylistToken, {
      stylistId: '01999999-9999-7999-8999-999999999999',
    }).expect(201);

    expect(created.body.data.stylistId).toBe(salonA.stylistId);
  });

  it('cobrar emite la factura con la comisión de la estilista y cierra la comanda', async () => {
    const ticket = (await registerTicket().expect(201)).body.data;

    const charged = await charge(ticket.id).expect(201);

    expect(charged.body.data).toMatchObject({ status: 'CHARGED', total: TOTAL });
    const invoice = await inspect(() =>
      prisma.client.invoice.findFirstOrThrow({
        where: { id: charged.body.data.invoiceId },
        include: { lines: true },
      }),
    );
    expect(invoice.status).toBe('PAID');
    expect(invoice.lines[0].stylistId).toBe(salonA.stylistId);

    const stored = await inspect(() =>
      prisma.client.serviceTicket.findFirstOrThrow({ where: { id: ticket.id } }),
    );
    expect(stored.invoiceId).toBe(invoice.id);
  });

  it('dos cobros simultáneos de la misma comanda facturan una sola vez', async () => {
    const ticket = (await registerTicket().expect(201)).body.data;

    const results = await Promise.all([charge(ticket.id), charge(ticket.id)]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const invoices = await inspect(() =>
      prisma.client.invoice.count({ where: { tenantId: salonA.tenantId } }),
    );
    expect(invoices).toBe(1);
  });

  it('la estilista no cobra: cobrar es de caja', async () => {
    const ticket = (await registerTicket().expect(201)).body.data;

    await charge(ticket.id, stylistToken).expect(403);
  });

  it('la estilista tampoco vende por el punto de venta', async () => {
    // Declarar lo hecho y recibir el dinero son de personas distintas: ese reparto es el
    // control. Sin esto, la profesional cobraba desde Ventas saltándose la caja.
    await request(server())
      .post(api('/sales'))
      .set(auth(stylistToken))
      .send({
        lines: [{ kind: 'SERVICE', itemId: salonA.serviceId, quantity: 1 }],
        payments: [{ method: 'CARD', amount: Number(TOTAL) }],
      })
      .expect(403);
  });

  it('recepción registra a nombre de la estilista y la comisión es de ella', async () => {
    const ticket = (
      await registerTicket(receptionToken, { stylistId: salonA.stylistId }).expect(201)
    ).body.data;
    expect(ticket.stylistId).toBe(salonA.stylistId);

    const charged = (await charge(ticket.id).expect(201)).body.data;
    const line = await inspect(() =>
      prisma.client.invoiceLine.findFirst({ where: { invoiceId: charged.invoiceId } }),
    );
    expect(line!.stylistId).toBe(salonA.stylistId);
  });

  it('un importe distinto del total no se cobra', async () => {
    const ticket = (await registerTicket().expect(201)).body.data;

    await request(server())
      .post(api(`/service-tickets/${ticket.id}/charge`))
      .set(auth(receptionToken))
      .send({ payments: [{ method: 'CARD', amount: 10 }] })
      .expect(422);
  });

  it('la estilista anula su comanda pendiente con motivo y ya no se puede cobrar', async () => {
    const ticket = (await registerTicket().expect(201)).body.data;

    await request(server())
      .post(api(`/service-tickets/${ticket.id}/cancel`))
      .set(auth(stylistToken))
      .send({ reason: 'Clienta equivocada' })
      .expect(201);

    await charge(ticket.id).expect(409);
  });

  it('otro salón no ve ni cobra las comandas ajenas', async () => {
    const ticket = (await registerTicket().expect(201)).body.data;
    const otherReception = await loginAs(salonB.receptionEmail);

    const list = await request(server())
      .get(api('/service-tickets'))
      .set(auth(otherReception))
      .expect(200);
    expect(list.body.data).toHaveLength(0);

    await charge(ticket.id, otherReception).expect(404);
  });

  it('ofrece a la estilista los servicios activos que puede registrar', async () => {
    const res = await request(server())
      .get(api('/service-tickets/assignable-services'))
      .set(auth(stylistToken))
      .expect(200);

    expect(res.body.data.map((s: { id: string }) => s.id)).toContain(salonA.serviceId);
  });
});
