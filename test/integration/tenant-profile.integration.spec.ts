import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';

import { api, createTestApp, resetDatabase } from './app-harness';
import { seedTwoTenants, TEST_PASSWORD, type SeededTenant } from './fixtures';

/**
 * Datos del salón que salen en los comprobantes: los lee cualquiera que cobre y solo los
 * cambia quien administra el salón.
 */
describe('Datos del salón (integración)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let salonA: SeededTenant;
  let salonB: SeededTenant;

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
  });

  const login = async (email: string) => {
    const response = await request(app.getHttpServer())
      .post(api('/auth/login'))
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    return { Authorization: `Bearer ${response.body.data.accessToken as string}` };
  };

  it('la propietaria completa NIT y dirección, y recepción los lee', async () => {
    const owner = await login(salonA.ownerEmail);
    const updated = await request(app.getHttpServer())
      .patch(api('/tenant/profile'))
      .set(owner)
      .send({ legalName: 'Salón A, S.A.', taxId: '1234567-8', addressLine: '6a avenida 1-23' })
      .expect(200);
    expect(updated.body.data).toMatchObject({ taxId: '1234567-8', legalName: 'Salón A, S.A.' });

    const reception = await login(salonA.receptionEmail);
    const read = await request(app.getHttpServer())
      .get(api('/tenant/profile'))
      .set(reception)
      .expect(200);
    expect(read.body.data).toMatchObject({ id: salonA.tenantId, taxId: '1234567-8' });
  });

  it('guarda un campo vaciado como ausente, no como texto vacío', async () => {
    const owner = await login(salonA.ownerEmail);
    await request(app.getHttpServer())
      .patch(api('/tenant/profile'))
      .set(owner)
      .send({ taxId: '999' })
      .expect(200);
    const cleared = await request(app.getHttpServer())
      .patch(api('/tenant/profile'))
      .set(owner)
      .send({ taxId: '   ' })
      .expect(200);
    expect(cleared.body.data.taxId).toBeNull();
  });

  it('guarda los colores del salón y la línea libre del comprobante', async () => {
    const owner = await login(salonA.ownerEmail);
    const initial = await request(app.getHttpServer())
      .get(api('/tenant/profile'))
      .set(owner)
      .expect(200);
    expect(initial.body.data).toMatchObject({ brandTheme: 'terracota', receiptNote: null });

    const updated = await request(app.getHttpServer())
      .patch(api('/tenant/profile'))
      .set(owner)
      .send({ brandTheme: 'menta-rosa', receiptNote: 'Síguenos en @mariansalon' })
      .expect(200);
    expect(updated.body.data).toMatchObject({
      brandTheme: 'menta-rosa',
      receiptNote: 'Síguenos en @mariansalon',
    });

    // Una paleta que la interfaz no sabe pintar no se guarda.
    await request(app.getHttpServer())
      .patch(api('/tenant/profile'))
      .set(owner)
      .send({ brandTheme: 'fosforito' })
      .expect(400);
  });

  it('recepción no puede cambiarlos', async () => {
    const reception = await login(salonA.receptionEmail);
    await request(app.getHttpServer())
      .patch(api('/tenant/profile'))
      .set(reception)
      .send({ taxId: '1' })
      .expect(403);
  });

  it('cada salón ve y cambia solo los suyos', async () => {
    const ownerB = await login(salonB.ownerEmail);
    await request(app.getHttpServer())
      .patch(api('/tenant/profile'))
      .set(ownerB)
      .send({ taxId: 'B-1' })
      .expect(200);

    const ownerA = await login(salonA.ownerEmail);
    const profileA = await request(app.getHttpServer())
      .get(api('/tenant/profile'))
      .set(ownerA)
      .expect(200);
    expect(profileA.body.data).toMatchObject({ id: salonA.tenantId, taxId: null });
  });
});
