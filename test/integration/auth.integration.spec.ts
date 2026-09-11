import { createHash } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';

import { api, createTestApp, resetDatabase } from './app-harness';
import { seedTwoTenants, TEST_PASSWORD, type SeededTenant } from './fixtures';

/**
 * Autenticación de extremo a extremo.
 *
 * A diferencia de la suite unitaria, aquí se ejercita **todo**: JWT firmados de verdad,
 * Argon2 real, PostgreSQL real, guards, filtro de errores e interceptor de envoltura.
 * Lo que se comprueba es que las piezas encajen, no que cada una funcione por separado.
 */
describe('Autenticación (integración)', () => {
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

  const login = (email: string, password = TEST_PASSWORD) =>
    request(app.getHttpServer()).post(api('/auth/login')).send({ email, password });

  describe('POST /auth/login', () => {
    it('devuelve tokens y perfil con credenciales correctas', async () => {
      const response = await login(salonA.ownerEmail).expect(200);

      expect(response.body.data).toMatchObject({
        tokenType: 'Bearer',
        user: { email: salonA.ownerEmail, tenantId: salonA.tenantId, roles: ['OWNER'] },
      });
      // Se comprueba con margen: `expiresIn` se calcula contra el reloj real, asi que
      // vale 899 o 900 segun caiga el milisegundo. Afirmar un valor exacto convertiria
      // este test en intermitente, que es peor que no tenerlo.
      expect(response.body.data.expiresIn).toBeGreaterThan(880);
      expect(response.body.data.expiresIn).toBeLessThanOrEqual(900);
      expect(typeof response.body.data.accessToken).toBe('string');
      expect(typeof response.body.data.refreshToken).toBe('string');
    });

    it('emite un JWT real con los claims esperados', async () => {
      const response = await login(salonA.ownerEmail).expect(200);
      const [, payload] = (response.body.data.accessToken as string).split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
        string,
        unknown
      >;

      expect(claims.sub).toBe('user-salon-a-owner');
      // El tenant viaja dentro del token firmado: es la única fuente del ámbito de salón
      // en toda la petición (ADR-0003).
      expect(claims.tenantId).toBe(salonA.tenantId);
      expect(claims.iss).toBe('appsalonbelleza');
      expect(claims.aud).toBe('appsalonbelleza-api');
      expect(Array.isArray(claims.permissions)).toBe(true);
    });

    it('responde 401 con la misma forma para correo desconocido y contraseña incorrecta', async () => {
      const unknown = await login('nadie@ninguna-parte.test').expect(401);
      const wrong = await login(salonA.ownerEmail, 'ContrasenaIncorrecta1').expect(401);

      expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
      expect(unknown.body.title).toBe(wrong.body.title);
      expect(unknown.body.detail).toBe(wrong.body.detail);
    });

    it('devuelve errores en formato Problem Details con correlationId', async () => {
      const response = await login('nadie@ninguna-parte.test').expect(401);

      expect(response.body).toMatchObject({
        type: expect.stringContaining('/errors/'),
        status: 401,
        code: 'INVALID_CREDENTIALS',
        instance: '/api/v1/auth/login',
      });
      expect(response.body.correlationId).toBeTruthy();
      // El identificador vuelve también en la cabecera, para que el cliente pueda citarlo.
      expect(response.headers['x-correlation-id']).toBe(response.body.correlationId);
    });

    it('rechaza campos no declarados en lugar de ignorarlos', async () => {
      // `forbidNonWhitelisted`: quien envía `tenantId` esperando cambiar de salón recibe
      // un 400, no un campo silenciosamente descartado que le haga creer que funcionó.
      const response = await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({
          email: salonA.ownerEmail,
          password: TEST_PASSWORD,
          tenantId: salonB.tenantId,
        })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('valida el formato del correo', async () => {
      const response = await login('esto-no-es-un-correo').expect(400);
      expect(response.body.errors).toBeDefined();
    });

    it('bloquea la cuenta tras cinco intentos fallidos', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await login(salonA.ownerEmail, 'ContrasenaIncorrecta1').expect(401);
      }

      const response = await login(salonA.ownerEmail).expect(422);
      expect(response.body.code).toBe('ACCOUNT_LOCKED');
    });
  });

  describe('POST /auth/refresh', () => {
    it('rota el token y devuelve un par nuevo', async () => {
      const first = await login(salonA.ownerEmail).expect(200);

      const second = await request(app.getHttpServer())
        .post(api('/auth/refresh'))
        .send({ refreshToken: first.body.data.refreshToken })
        .expect(200);

      expect(second.body.data.refreshToken).not.toBe(first.body.data.refreshToken);
    });

    it('detecta la reutilización y derriba la familia entera', async () => {
      const first = await login(salonA.ownerEmail).expect(200);
      const second = await request(app.getHttpServer())
        .post(api('/auth/refresh'))
        .send({ refreshToken: first.body.data.refreshToken })
        .expect(200);

      // El token viejo vuelve a presentarse: es la firma de una copia robada.
      const reuse = await request(app.getHttpServer())
        .post(api('/auth/refresh'))
        .send({ refreshToken: first.body.data.refreshToken })
        .expect(422);

      expect(reuse.body.code).toBe('REFRESH_TOKEN_REUSE_DETECTED');

      // El sucesor legítimo también queda revocado: no se puede saber cuál de los dos
      // portadores es el bueno, así que se cierran los dos.
      await request(app.getHttpServer())
        .post(api('/auth/refresh'))
        .send({ refreshToken: second.body.data.refreshToken })
        .expect(422);

      const tokens = await prisma.client.refreshToken.findMany({
        where: { userId: 'user-salon-a-owner' },
      });
      expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);
      expect(tokens.some((t) => t.revokedReason === 'REUSE_DETECTED')).toBe(true);
    });

    it('guarda el refresh token hasheado en la base de datos', async () => {
      const session = await login(salonA.ownerEmail).expect(200);

      const stored = await prisma.client.refreshToken.findFirst({
        where: { userId: 'user-salon-a-owner' },
      });

      expect(stored).not.toBeNull();
      // Un volcado de esta tabla no puede permitir suplantar a nadie (ADR-0005).
      expect(stored!.tokenHash).not.toContain(session.body.data.refreshToken);
      expect(stored!.tokenHash.startsWith('$argon2id$')).toBe(true);
    });

    it('rechaza un access token presentado como refresh token', async () => {
      const session = await login(salonA.ownerEmail).expect(200);

      // Secretos distintos para cada tipo: sin eso, un refresh de siete días podría
      // usarse como access y la ventana de 15 minutos no serviría de nada.
      await request(app.getHttpServer())
        .post(api('/auth/refresh'))
        .send({ refreshToken: session.body.data.accessToken })
        .expect(401);
    });
  });

  describe('GET /auth/me', () => {
    it('devuelve el perfil del usuario autenticado', async () => {
      const session = await login(salonA.receptionEmail).expect(200);

      const response = await request(app.getHttpServer())
        .get(api('/auth/me'))
        .set('Authorization', `Bearer ${session.body.data.accessToken}`)
        .expect(200);

      expect(response.body.data).toMatchObject({
        email: salonA.receptionEmail,
        fullName: 'Lucía Fernández',
        roles: ['RECEPTIONIST'],
        tenantId: salonA.tenantId,
      });
    });

    it('nunca expone el hash de la contraseña', async () => {
      const session = await login(salonA.ownerEmail).expect(200);
      const response = await request(app.getHttpServer())
        .get(api('/auth/me'))
        .set('Authorization', `Bearer ${session.body.data.accessToken}`)
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain('$argon2');
      expect(response.body.data.passwordHash).toBeUndefined();
    });

    it('responde 401 sin token', async () => {
      await request(app.getHttpServer()).get(api('/auth/me')).expect(401);
    });

    it('responde 401 con un token manipulado', async () => {
      const session = await login(salonA.ownerEmail).expect(200);
      const token = session.body.data.accessToken as string;
      // Se altera la firma dejando intacto el payload: es el ataque más obvio.
      const tampered = `${token.slice(0, -6)}AAAAAA`;

      await request(app.getHttpServer())
        .get(api('/auth/me'))
        .set('Authorization', `Bearer ${tampered}`)
        .expect(401);
    });

    it('responde 401 con esquema de autorización incorrecto', async () => {
      const session = await login(salonA.ownerEmail).expect(200);
      await request(app.getHttpServer())
        .get(api('/auth/me'))
        .set('Authorization', `Basic ${session.body.data.accessToken}`)
        .expect(401);
    });
  });

  describe('POST /auth/logout', () => {
    it('revoca la sesión y el token deja de servir para refrescar', async () => {
      const session = await login(salonA.ownerEmail).expect(200);

      await request(app.getHttpServer())
        .post(api('/auth/logout'))
        .set('Authorization', `Bearer ${session.body.data.accessToken}`)
        .send({ refreshToken: session.body.data.refreshToken })
        .expect(200);

      await request(app.getHttpServer())
        .post(api('/auth/refresh'))
        .send({ refreshToken: session.body.data.refreshToken })
        .expect(422);
    });

    it('funciona sin access token válido', async () => {
      const session = await login(salonA.ownerEmail).expect(200);

      // El caso real: el access token ya caducó y el cliente aun así quiere cerrar
      // sesión. Sin esto, el refresh token de siete días quedaría vivo.
      const response = await request(app.getHttpServer())
        .post(api('/auth/logout'))
        .send({ refreshToken: session.body.data.refreshToken })
        .expect(200);

      expect(response.body.data.revokedSessions).toBeGreaterThan(0);
    });

    it('es idempotente', async () => {
      const session = await login(salonA.ownerEmail).expect(200);
      const body = { refreshToken: session.body.data.refreshToken };

      await request(app.getHttpServer()).post(api('/auth/logout')).send(body).expect(200);
      // Cerrar una sesión ya cerrada no es un error: el estado que el cliente pedía ya
      // se cumple, y devolver un fallo solo lo dejaría con la sesión abierta en su lado.
      await request(app.getHttpServer()).post(api('/auth/logout')).send(body).expect(200);
    });

    it('con allDevices cierra todas las sesiones del usuario', async () => {
      const mobile = await login(salonA.ownerEmail).expect(200);
      const desktop = await login(salonA.ownerEmail).expect(200);

      await request(app.getHttpServer())
        .post(api('/auth/logout'))
        .set('Authorization', `Bearer ${mobile.body.data.accessToken}`)
        .send({ refreshToken: mobile.body.data.refreshToken, allDevices: true })
        .expect(200);

      await request(app.getHttpServer())
        .post(api('/auth/refresh'))
        .send({ refreshToken: desktop.body.data.refreshToken })
        .expect(422);
    });
  });

  describe('POST /auth/change-password', () => {
    it('cambia la contraseña y cierra todas las sesiones', async () => {
      const session = await login(salonA.ownerEmail).expect(200);

      await request(app.getHttpServer())
        .post(api('/auth/change-password'))
        .set('Authorization', `Bearer ${session.body.data.accessToken}`)
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'NuevaContrasena2026' })
        .expect(204);

      // La contraseña vieja deja de valer...
      await login(salonA.ownerEmail, TEST_PASSWORD).expect(401);
      // ...la nueva funciona...
      await login(salonA.ownerEmail, 'NuevaContrasena2026').expect(200);
      // ...y la sesión anterior ya no puede refrescarse.
      await request(app.getHttpServer())
        .post(api('/auth/refresh'))
        .send({ refreshToken: session.body.data.refreshToken })
        .expect(422);
    });

    it('exige la contraseña actual aunque la sesión esté abierta', async () => {
      const session = await login(salonA.ownerEmail).expect(200);

      // Sin esto, quien pase por delante de un ordenador de recepción con la sesión
      // abierta podría apropiarse de la cuenta.
      await request(app.getHttpServer())
        .post(api('/auth/change-password'))
        .set('Authorization', `Bearer ${session.body.data.accessToken}`)
        .send({ currentPassword: 'NoEsLaMia1', newPassword: 'NuevaContrasena2026' })
        .expect(401);
    });

    it('rechaza una contraseña que no cumple la política', async () => {
      const session = await login(salonA.ownerEmail).expect(200);

      await request(app.getHttpServer())
        .post(api('/auth/change-password'))
        .set('Authorization', `Bearer ${session.body.data.accessToken}`)
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'corta' })
        .expect(400);
    });
  });

  /**
   * Recuperación de contraseña.
   *
   * El flujo se quedó sin pruebas de backend mientras el resto de `auth` las tenía, y es
   * justo el que más se parece a una puerta trasera: quien controle un token de estos
   * entra sin credenciales. Lo que se afirma aquí es que el token no se puede reutilizar,
   * no se puede adivinar leyendo la base y no revela qué correos existen.
   *
   * Fuera de producción el endpoint devuelve `resetPath` para poder recorrer el flujo sin
   * buzón de correo; en producción se omite. Ese `if` es hoy la única razón de que la
   * funcionalidad sea utilizable, porque **no existe puerto de envío de correo**.
   */
  describe('recuperación de contraseña', () => {
    const forgot = (email: string) =>
      request(app.getHttpServer()).post(api('/auth/forgot-password')).send({ email });

    const reset = (token: string, newPassword: string) =>
      request(app.getHttpServer()).post(api('/auth/reset-password')).send({ token, newPassword });

    /** Pide el restablecimiento y extrae el token del `resetPath` de desarrollo. */
    const tokenFor = async (email: string): Promise<string> => {
      const response = await forgot(email).expect(202);
      const path = response.body.data.resetPath as string;
      return new URL(path, 'http://localhost').searchParams.get('token')!;
    };

    it('responde igual para un correo conocido y uno inexistente', async () => {
      const known = await forgot(salonA.ownerEmail).expect(202);
      const unknown = await forgot('nadie@ejemplo.com').expect(202);

      // Distinguirlos permitiría enumerar los usuarios del sistema, que es exactamente lo
      // que el login ya evita.
      expect(known.body.data.message).toBe(unknown.body.data.message);
    });

    it('no emite token para un correo inexistente', async () => {
      const response = await forgot('nadie@ejemplo.com').expect(202);

      expect(response.body.data.resetPath).toBeUndefined();
      expect(await prisma.client.passwordResetToken.count()).toBe(0);
    });

    it('guarda el token hasheado, nunca en claro', async () => {
      const token = await tokenFor(salonA.ownerEmail);
      const stored = await prisma.client.passwordResetToken.findFirstOrThrow();

      expect(stored.tokenHash).not.toBe(token);
      expect(stored.tokenHash).toHaveLength(64);
      // Quien lea la tabla no puede reconstruir el enlace: es el mismo criterio que se
      // aplica a los refresh tokens.
      expect(stored.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    });

    it('cambia la contraseña y deja de valer la anterior', async () => {
      const token = await tokenFor(salonA.ownerEmail);
      const nuevaContrasena = 'ContrasenaNueva9';

      await reset(token, nuevaContrasena).expect(204);

      await login(salonA.ownerEmail, TEST_PASSWORD).expect(401);
      await login(salonA.ownerEmail, nuevaContrasena).expect(200);
    });

    it('el token es de un solo uso', async () => {
      const token = await tokenFor(salonA.ownerEmail);
      await reset(token, 'ContrasenaNueva9').expect(204);

      await reset(token, 'OtraContrasena9x').expect(401);
      // Y el segundo intento no ha tocado nada: sigue valiendo la primera contraseña nueva.
      await login(salonA.ownerEmail, 'ContrasenaNueva9').expect(200);
    });

    it('rechaza un token caducado', async () => {
      const token = await tokenFor(salonA.ownerEmail);
      await prisma.client.passwordResetToken.updateMany({
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await reset(token, 'ContrasenaNueva9').expect(401);
      await login(salonA.ownerEmail, TEST_PASSWORD).expect(200);
    });

    it('rechaza un token que nadie ha emitido', async () => {
      await reset('f'.repeat(64), 'ContrasenaNueva9').expect(401);
    });

    it('aplica la política de contraseñas', async () => {
      const token = await tokenFor(salonA.ownerEmail);

      await reset(token, 'corta').expect(400);
      // Y el token sobrevive al intento fallido: rechazar por política no debe quemarlo.
      await reset(token, 'ContrasenaNueva9').expect(204);
    });

    it('emitir un token nuevo invalida el anterior', async () => {
      const primero = await tokenFor(salonA.ownerEmail);
      const segundo = await tokenFor(salonA.ownerEmail);

      await reset(primero, 'ContrasenaNueva9').expect(401);
      await reset(segundo, 'ContrasenaNueva9').expect(204);
    });
  });

  describe('auditoría', () => {
    it('registra accesos correctos y fallidos', async () => {
      await login(salonA.ownerEmail).expect(200);
      await login(salonA.ownerEmail, 'ContrasenaIncorrecta1').expect(401);

      const entries = await prisma.client.auditLog.findMany({ orderBy: { occurredAt: 'asc' } });
      const actions = entries.map((e) => e.action);

      expect(actions).toContain('LOGIN');
      expect(actions).toContain('LOGIN_FAILED');
    });

    it('la auditoría es append-only: la base rechaza modificarla', async () => {
      await login(salonA.ownerEmail).expect(200);
      const entry = await prisma.client.auditLog.findFirst();

      // La garantía la da un trigger de PostgreSQL, no el código: ni un caso de uso mal
      // escrito ni una consola de psql pueden reescribir el histórico (ADR-0004).
      await expect(
        prisma.client.auditLog.updateMany({
          where: { id: entry!.id },
          data: { action: 'LOGOUT' },
        }),
      ).rejects.toThrow();
    });
  });
});
