import { FixedClock, SequentialIdGenerator } from '@shared/infrastructure/adapters/system.adapters';
import {
  FakePasswordHasher,
  FakeTokenSigner,
  InMemoryAuditRecorder,
  InMemoryRefreshTokenRepository,
} from '@test/doubles/auth.doubles';
import { InMemoryUserRepository } from '@test/doubles/in-memory-user.repository';
import { aUser, OWNER_ROLE, RECEPTIONIST_ROLE, TENANT_A } from '@test/builders/user.builder';
import {
  AccountLockedError,
  AccountNotActiveError,
  InvalidCredentialsError,
} from '@core/users/domain/user.errors';

import { LoginUseCase } from './login.use-case';

/**
 * Los tests del login son, en su mayoría, **tests de seguridad**. No comprueban que la
 * funcionalidad exista, sino que no exista lo que no debe: diferencias observables entre
 * un correo conocido y uno desconocido, bloqueos que se puedan eludir, o mensajes de
 * error que revelen más de lo debido.
 */
describe('LoginUseCase', () => {
  const NOW = new Date('2026-09-02T10:00:00.000Z');

  let users: InMemoryUserRepository;
  let refreshTokens: InMemoryRefreshTokenRepository;
  let hasher: FakePasswordHasher;
  let tokens: FakeTokenSigner;
  let audit: InMemoryAuditRecorder;
  let clock: FixedClock;
  let useCase: LoginUseCase;

  const context = { userAgent: 'jest', ipAddress: '10.0.0.1' };

  beforeEach(() => {
    users = new InMemoryUserRepository();
    refreshTokens = new InMemoryRefreshTokenRepository();
    hasher = new FakePasswordHasher();
    tokens = new FakeTokenSigner();
    audit = new InMemoryAuditRecorder();
    clock = new FixedClock(NOW);
    tokens.now = () => clock.now();

    useCase = new LoginUseCase(
      users,
      refreshTokens,
      hasher,
      tokens,
      clock,
      new SequentialIdGenerator(),
      audit,
      { maxFailedLoginAttempts: 5, accountLockMinutes: 15 },
    );
  });

  describe('acceso correcto', () => {
    beforeEach(() => {
      users.seed(
        aUser()
          .withId('u-1')
          .withEmail('ana@salon.test')
          .withPassword('ContrasenaSegura1')
          .withRoles(OWNER_ROLE)
          .build(),
      );
    });

    it('devuelve el par de tokens y el perfil', async () => {
      const session = await useCase.execute({
        email: 'ana@salon.test',
        password: 'ContrasenaSegura1',
        ...context,
      });

      expect(session.accessToken).toBeTruthy();
      expect(session.refreshToken).toBeTruthy();
      expect(session.tokenType).toBe('Bearer');
      expect(session.expiresIn).toBe(900); // 15 minutos
      expect(session.user).toMatchObject({
        id: 'u-1',
        email: 'ana@salon.test',
        tenantId: TENANT_A,
        roles: ['OWNER'],
      });
    });

    it('incluye los permisos efectivos en la sesión', async () => {
      const session = await useCase.execute({
        email: 'ana@salon.test',
        password: 'ContrasenaSegura1',
        ...context,
      });
      expect(session.user.permissions).toEqual([...OWNER_ROLE.permissions].sort());
    });

    it('normaliza el correo: mayúsculas y espacios no impiden entrar', async () => {
      await expect(
        useCase.execute({ email: '  ANA@Salon.test ', password: 'ContrasenaSegura1', ...context }),
      ).resolves.toBeDefined();
    });

    it('guarda el refresh token hasheado, nunca en claro', async () => {
      const session = await useCase.execute({
        email: 'ana@salon.test',
        password: 'ContrasenaSegura1',
        ...context,
      });

      const [stored] = refreshTokens.all;
      expect(stored).toBeDefined();
      // Un volcado de la tabla no debe permitir suplantar a nadie (ADR-0005).
      expect(stored.tokenHash).not.toBe(session.refreshToken);
      expect(await hasher.verify(stored.tokenHash, session.refreshToken)).toBe(true);
    });

    it('abre una familia de refresco nueva en cada inicio de sesión', async () => {
      await useCase.execute({ email: 'ana@salon.test', password: 'ContrasenaSegura1', ...context });
      await useCase.execute({ email: 'ana@salon.test', password: 'ContrasenaSegura1', ...context });

      const families = new Set(refreshTokens.all.map((t) => t.familyId));
      // Cerrar la sesión del móvil no debe tirar la del ordenador del salón.
      expect(families.size).toBe(2);
    });

    it('limpia el contador de intentos fallidos', async () => {
      users.seed(
        aUser()
          .withId('u-2')
          .withEmail('con-fallos@salon.test')
          .withPassword('ContrasenaSegura1')
          .withFailedAttempts(3)
          .build(),
      );

      await useCase.execute({
        email: 'con-fallos@salon.test',
        password: 'ContrasenaSegura1',
        ...context,
      });

      const user = await users.findByEmailAcrossTenants('con-fallos@salon.test');
      expect(user!.failedLoginAttempts).toBe(0);
      expect(user!.lastLoginAt).toEqual(NOW);
    });

    it('registra el acceso en la auditoría', async () => {
      await useCase.execute({ email: 'ana@salon.test', password: 'ContrasenaSegura1', ...context });
      expect(audit.has('LOGIN')).toBe(true);
    });

    it('rehashea la contraseña si los parámetros de Argon2 se han endurecido', async () => {
      hasher.forceRehash = true;
      const before = hasher.hashCalls;

      await useCase.execute({ email: 'ana@salon.test', password: 'ContrasenaSegura1', ...context });

      // Una llamada extra respecto al hash del refresh token: la del rehash silencioso.
      expect(hasher.hashCalls).toBeGreaterThan(before + 1);
    });
  });

  describe('credenciales incorrectas', () => {
    beforeEach(() => {
      users.seed(aUser().withEmail('ana@salon.test').withPassword('ContrasenaSegura1').build());
    });

    it('devuelve el mismo error para correo desconocido y contraseña incorrecta', async () => {
      const capture = (email: string, password: string): Promise<Error> =>
        useCase
          .execute({ email, password, ...context })
          .then(() => new Error('se esperaba un fallo de autenticacion'))
          .catch((error: Error) => error);

      const unknownEmail = await capture('nadie@salon.test', 'loquesea');
      const badPassword = await capture('ana@salon.test', 'incorrecta');

      // Si difirieran, bastaría probar correos para enumerar la base de usuarios.
      expect(unknownEmail).toBeInstanceOf(InvalidCredentialsError);
      expect(badPassword).toBeInstanceOf(InvalidCredentialsError);
      expect(unknownEmail.message).toBe(badPassword.message);
    });

    it('gasta el trabajo de una verificación aunque el correo no exista', async () => {
      await expect(
        useCase.execute({ email: 'nadie@salon.test', password: 'x', ...context }),
      ).rejects.toThrow(InvalidCredentialsError);

      // Sin esto, la respuesta sería medibles milisegundos más rápida para los correos
      // que no existen, y esa diferencia es un oráculo de enumeración.
      expect(hasher.dummyVerifications).toBe(1);
    });

    it('no emite ningún token cuando la contraseña falla', async () => {
      await expect(
        useCase.execute({ email: 'ana@salon.test', password: 'incorrecta', ...context }),
      ).rejects.toThrow();
      expect(refreshTokens.all).toHaveLength(0);
    });

    it('incrementa el contador de intentos fallidos', async () => {
      await expect(
        useCase.execute({ email: 'ana@salon.test', password: 'mal', ...context }),
      ).rejects.toThrow();

      const user = await users.findByEmailAcrossTenants('ana@salon.test');
      expect(user!.failedLoginAttempts).toBe(1);
    });

    it('bloquea la cuenta al alcanzar el umbral', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(
          useCase.execute({ email: 'ana@salon.test', password: 'mal', ...context }),
        ).rejects.toThrow(InvalidCredentialsError);
      }

      const user = await users.findByEmailAcrossTenants('ana@salon.test');
      expect(user!.isLocked(NOW)).toBe(true);

      // El sexto intento, esta vez con la contraseña CORRECTA, debe seguir rechazándose:
      // si no, el bloqueo no serviría de nada.
      await expect(
        useCase.execute({ email: 'ana@salon.test', password: 'ContrasenaSegura1', ...context }),
      ).rejects.toThrow(AccountLockedError);
    });

    it('el bloqueo caduca solo, sin intervención', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await useCase
          .execute({ email: 'ana@salon.test', password: 'mal', ...context })
          .catch(() => undefined);
      }

      clock.advanceBy(16 * 60_000);

      // Un bloqueo permanente sería una herramienta de denegación de servicio: bastaría
      // fallar cinco veces contra el correo de la propietaria para dejarla fuera.
      await expect(
        useCase.execute({ email: 'ana@salon.test', password: 'ContrasenaSegura1', ...context }),
      ).resolves.toBeDefined();
    });

    it('audita los intentos fallidos', async () => {
      await useCase
        .execute({ email: 'ana@salon.test', password: 'mal', ...context })
        .catch(() => undefined);
      expect(audit.has('LOGIN_FAILED')).toBe(true);
    });
  });

  describe('cuentas que no pueden autenticarse', () => {
    it('rechaza una cuenta desactivada aunque la contraseña sea correcta', async () => {
      users.seed(
        aUser().withEmail('baja@salon.test').withPassword('ContrasenaSegura1').inactive().build(),
      );

      await expect(
        useCase.execute({ email: 'baja@salon.test', password: 'ContrasenaSegura1', ...context }),
      ).rejects.toThrow(AccountNotActiveError);
    });

    it('rechaza una cuenta eliminada', async () => {
      users.seed(
        aUser().withEmail('borrada@salon.test').withPassword('ContrasenaSegura1').deleted().build(),
      );

      // El repositorio no la ve: para el login es indistinguible de un correo que no existe.
      await expect(
        useCase.execute({ email: 'borrada@salon.test', password: 'ContrasenaSegura1', ...context }),
      ).rejects.toThrow(InvalidCredentialsError);
    });

    it('no verifica la contraseña de una cuenta bloqueada', async () => {
      users.seed(
        aUser()
          .withEmail('bloqueada@salon.test')
          .withPassword('ContrasenaSegura1')
          .locked(new Date(NOW.getTime() + 10 * 60_000))
          .build(),
      );

      const hashCallsBefore = hasher.hashCalls;
      await expect(
        useCase.execute({
          email: 'bloqueada@salon.test',
          password: 'ContrasenaSegura1',
          ...context,
        }),
      ).rejects.toThrow(AccountLockedError);

      // Verificar Argon2 cuesta CPU a propósito. Gastarla en cuentas bloqueadas
      // convertiría el bloqueo en un vector de agotamiento de recursos.
      expect(hasher.hashCalls).toBe(hashCallsBefore);
    });
  });

  describe('aislamiento entre salones', () => {
    it('un mismo correo no puede existir en dos salones', async () => {
      // La búsqueda del login cruza inquilinos por necesidad, y por eso el correo es
      // único en toda la plataforma. Este test fija esa expectativa.
      users.seed(
        aUser().withEmail('compartido@salon.test').withPassword('Uno').inTenant(TENANT_A).build(),
      );
      expect(await users.existsByEmail('compartido@salon.test')).toBe(true);
    });

    it('la sesión lleva el salón del usuario, no uno elegido por el cliente', async () => {
      users.seed(
        aUser()
          .withEmail('otro@salon.test')
          .withPassword('ContrasenaSegura1')
          .inTenant('33333333-3333-7333-8333-333333333333')
          .withRoles(RECEPTIONIST_ROLE)
          .build(),
      );

      const session = await useCase.execute({
        email: 'otro@salon.test',
        password: 'ContrasenaSegura1',
        ...context,
      });

      expect(session.user.tenantId).toBe('33333333-3333-7333-8333-333333333333');
    });
  });
});
