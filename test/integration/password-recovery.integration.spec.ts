import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';
import { QueryScopeStore } from '@shared/infrastructure/persistence/prisma/query-scope';

import { api, createTestApp, resetDatabase } from './app-harness';
import { seedTwoTenants, TEST_PASSWORD, type SeededTenant } from './fixtures';

/**
 * Recuperación de acceso a través de la propietaria.
 *
 * Sin proveedor de correo, «olvidé mi contraseña» solo devuelve el acceso si alguien con
 * autoridad lo atiende: el aviso llega a la propietaria del salón y ella asigna una
 * contraseña nueva. Lo que se afirma es que el aviso llega a quien debe y a nadie más, y
 * que asignar una contraseña es tan seguro como cambiarla uno mismo: cierra sesiones, no
 * cruza salones y no sirve para saltarse la contraseña actual de la propia cuenta.
 */
describe('Contraseña asignada por la propietaria (integración)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let salonA: SeededTenant;
  let salonB: SeededTenant;

  const NEW_PASSWORD = 'TemporalSalon2026';

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

  const server = () => app.getHttpServer();
  const userId = (salon: SeededTenant, local: 'owner' | 'reception' | 'stylist') =>
    `user-${salon.slug}-${local}`;
  const login = (email: string, password = TEST_PASSWORD) =>
    request(server()).post(api('/auth/login')).send({ email, password });
  const tokenFor = async (email: string): Promise<string> =>
    (await login(email).expect(200)).body.data.accessToken as string;
  const forgot = (email: string) =>
    request(server()).post(api('/auth/forgot-password')).send({ email }).expect(202);
  const pending = (token: string) =>
    request(server()).get(api('/password-reset-requests')).set('Authorization', `Bearer ${token}`);
  const assign = (token: string, id: string, newPassword = NEW_PASSWORD) =>
    request(server())
      .post(api(`/users/${id}/password`))
      .set('Authorization', `Bearer ${token}`)
      .send({ newPassword });
  const dismiss = (token: string, id: string) =>
    request(server())
      .post(api(`/password-reset-requests/${id}/dismiss`))
      .set('Authorization', `Bearer ${token}`);
  const storedRequests = () =>
    QueryScopeStore.crossTenant(() =>
      prisma.client.passwordResetRequest.findMany({ orderBy: { createdAt: 'asc' } }),
    );

  describe('olvidé mi contraseña', () => {
    it('avisa a la propietaria de su salón y a la de otro no', async () => {
      await forgot(salonA.stylistEmail);

      const response = await pending(await tokenFor(salonA.ownerEmail)).expect(200);
      expect(response.body.data).toEqual([
        expect.objectContaining({
          userId: userId(salonA, 'stylist'),
          email: salonA.stylistEmail,
          fullName: 'Sara Molina',
        }),
      ]);
      const ajena = await pending(await tokenFor(salonB.ownerEmail)).expect(200);
      expect(ajena.body.data).toEqual([]);
    });

    it('pedirla varias veces deja un solo aviso', async () => {
      await forgot(salonA.stylistEmail);
      await forgot(salonA.stylistEmail);
      await forgot(salonA.stylistEmail);

      expect(await storedRequests()).toHaveLength(1);
    });

    it('un correo inexistente no deja aviso y responde igual', async () => {
      const unknown = await forgot('nadie@ejemplo.com');
      const known = await forgot(salonA.stylistEmail);

      expect(unknown.body.data.message).toBe(known.body.data.message);
      expect(await storedRequests()).toHaveLength(1);
    });

    it('no avisa por un usuario desactivado', async () => {
      await prisma.client.user.update({
        where: { id: userId(salonA, 'stylist') },
        data: { status: 'INACTIVE' },
      });

      await forgot(salonA.stylistEmail);

      expect(await storedRequests()).toHaveLength(0);
    });

    it('solo ve los avisos quien puede asignar contraseñas', async () => {
      await forgot(salonA.stylistEmail);

      await pending(await tokenFor(salonA.receptionEmail)).expect(403);
    });
  });

  describe('POST /users/:id/password', () => {
    it('asigna la contraseña, cierra las sesiones del usuario y resuelve su aviso', async () => {
      const stylistSession = await login(salonA.stylistEmail).expect(200);
      await forgot(salonA.stylistEmail);
      const owner = await tokenFor(salonA.ownerEmail);

      await assign(owner, userId(salonA, 'stylist')).expect(204);

      await login(salonA.stylistEmail).expect(401);
      await login(salonA.stylistEmail, NEW_PASSWORD).expect(200);
      // Quien tuviera abierta la sesión con la contraseña anterior queda fuera: el refresh
      // token revocado se rechaza igual que tras cambiarla uno mismo.
      await request(server())
        .post(api('/auth/refresh'))
        .send({ refreshToken: stylistSession.body.data.refreshToken })
        .expect(422);
      expect((await pending(owner).expect(200)).body.data).toEqual([]);
      const [stored] = await storedRequests();
      expect(stored).toMatchObject({ status: 'RESOLVED', resolvedBy: userId(salonA, 'owner') });
    });

    it('desbloquea la cuenta bloqueada por intentos fallidos', async () => {
      await prisma.client.user.update({
        where: { id: userId(salonA, 'stylist') },
        data: { failedLoginAttempts: 5, lockedUntil: new Date(Date.now() + 15 * 60_000) },
      });

      await assign(await tokenFor(salonA.ownerEmail), userId(salonA, 'stylist')).expect(204);

      await login(salonA.stylistEmail, NEW_PASSWORD).expect(200);
    });

    it('funciona aunque el usuario no lo haya pedido', async () => {
      await assign(await tokenFor(salonA.ownerEmail), userId(salonA, 'reception')).expect(204);

      await login(salonA.receptionEmail, NEW_PASSWORD).expect(200);
    });

    it('queda en la auditoría sin la contraseña', async () => {
      await assign(await tokenFor(salonA.ownerEmail), userId(salonA, 'stylist')).expect(204);

      const entry = await QueryScopeStore.crossTenant(() =>
        prisma.client.auditLog.findFirstOrThrow({
          where: { entityId: userId(salonA, 'stylist'), action: 'UPDATE' },
        }),
      );
      expect(entry.metadata).toMatchObject({ field: 'password', resetByAdmin: true });
      expect(JSON.stringify(entry)).not.toContain(NEW_PASSWORD);
    });

    it('aplica la política de contraseñas', async () => {
      const owner = await tokenFor(salonA.ownerEmail);

      await assign(owner, userId(salonA, 'stylist'), 'corta').expect(400);
      await assign(owner, userId(salonA, 'stylist'), 'sinmayusculas2026').expect(422);
      await login(salonA.stylistEmail).expect(200);
    });

    it('no sirve para la propia contraseña, que exige la actual', async () => {
      await assign(await tokenFor(salonA.ownerEmail), userId(salonA, 'owner')).expect(403);

      await login(salonA.ownerEmail).expect(200);
    });

    it('no alcanza a usuarios de otro salón', async () => {
      await assign(await tokenFor(salonA.ownerEmail), userId(salonB, 'stylist')).expect(404);

      await login(salonB.stylistEmail).expect(200);
    });

    it('exige el permiso, que solo tiene la propiedad', async () => {
      await assign(await tokenFor(salonA.receptionEmail), userId(salonA, 'stylist')).expect(403);

      await login(salonA.stylistEmail).expect(200);
    });
  });

  describe('POST /password-reset-requests/:id/dismiss', () => {
    it('descarta el aviso sin tocar la contraseña', async () => {
      await forgot(salonA.stylistEmail);
      const owner = await tokenFor(salonA.ownerEmail);
      const [aviso] = (await pending(owner).expect(200)).body.data as Array<{ id: string }>;

      await dismiss(owner, aviso.id).expect(204);

      expect((await pending(owner).expect(200)).body.data).toEqual([]);
      await login(salonA.stylistEmail).expect(200);
      // Descartado, el usuario puede volver a pedirla.
      await forgot(salonA.stylistEmail);
      expect((await pending(owner).expect(200)).body.data).toHaveLength(1);
    });

    it('no descarta avisos de otro salón', async () => {
      await forgot(salonA.stylistEmail);
      const [aviso] = await storedRequests();

      await dismiss(await tokenFor(salonB.ownerEmail), aviso.id).expect(404);

      expect((await storedRequests())[0]).toMatchObject({ status: 'PENDING' });
    });
  });
});
