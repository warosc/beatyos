import { FixedClock, SequentialIdGenerator } from '@shared/infrastructure/adapters/system.adapters';
import {
  FakePasswordHasher,
  FakeTokenSigner,
  InMemoryAuditRecorder,
  InMemoryRefreshTokenRepository,
} from '@test/doubles/auth.doubles';
import { InMemoryUserRepository } from '@test/doubles/in-memory-user.repository';
import { aUser, OWNER_ROLE, STYLIST_ROLE } from '@test/builders/user.builder';
import {
  AccountNotActiveError,
  InvalidRefreshTokenError,
  RefreshTokenReuseError,
} from '@core/users/domain/user.errors';

import { LoginUseCase } from './login.use-case';
import { RefreshTokenUseCase } from './refresh-token.use-case';

/**
 * La rotación con detección de reutilización es lo que convierte el robo de un refresh
 * token de "siete días de acceso" en "acceso hasta que el usuario legítimo vuelva a
 * entrar". Estos tests describen ese mecanismo escenario a escenario.
 */
describe('RefreshTokenUseCase', () => {
  const NOW = new Date('2026-09-02T10:00:00.000Z');
  const context = { userAgent: 'jest', ipAddress: '10.0.0.1' };
  const credentials = { email: 'ana@salon.test', password: 'ContrasenaSegura1', ...context };

  let users: InMemoryUserRepository;
  let refreshTokens: InMemoryRefreshTokenRepository;
  let hasher: FakePasswordHasher;
  let tokens: FakeTokenSigner;
  let audit: InMemoryAuditRecorder;
  let clock: FixedClock;
  let login: LoginUseCase;
  let refresh: RefreshTokenUseCase;

  beforeEach(() => {
    users = new InMemoryUserRepository();
    refreshTokens = new InMemoryRefreshTokenRepository();
    hasher = new FakePasswordHasher();
    tokens = new FakeTokenSigner();
    audit = new InMemoryAuditRecorder();
    clock = new FixedClock(NOW);
    tokens.now = () => clock.now();

    const ids = new SequentialIdGenerator();

    login = new LoginUseCase(users, refreshTokens, hasher, tokens, clock, ids, audit, {
      maxFailedLoginAttempts: 5,
      accountLockMinutes: 15,
    });
    refresh = new RefreshTokenUseCase(users, refreshTokens, hasher, tokens, clock, ids, audit);

    users.seed(
      aUser()
        .withId('u-1')
        .withEmail('ana@salon.test')
        .withPassword('ContrasenaSegura1')
        .withRoles(OWNER_ROLE)
        .build(),
    );
  });

  describe('rotación', () => {
    it('emite un par nuevo y devuelve un refresh token distinto', async () => {
      const first = await login.execute(credentials);
      const second = await refresh.execute({ refreshToken: first.refreshToken, ...context });

      expect(second.refreshToken).not.toBe(first.refreshToken);
      expect(second.accessToken).not.toBe(first.accessToken);
    });

    it('marca el token usado como rotado y lo enlaza con su sucesor', async () => {
      const first = await login.execute(credentials);
      await refresh.execute({ refreshToken: first.refreshToken, ...context });

      const [original, successor] = refreshTokens.all;
      expect(original.revokedAt).toEqual(NOW);
      expect(original.revokedReason).toBe('ROTATED');
      // La cadena queda reconstruible: es lo que permite investigar un incidente después.
      expect(original.replacedById).toBe(successor.id);
      expect(successor.revokedAt).toBeNull();
    });

    it('mantiene la familia a lo largo de toda la cadena', async () => {
      const first = await login.execute(credentials);
      const second = await refresh.execute({ refreshToken: first.refreshToken, ...context });
      await refresh.execute({ refreshToken: second.refreshToken, ...context });

      const families = new Set(refreshTokens.all.map((t) => t.familyId));
      expect(families.size).toBe(1);
    });

    it('permite encadenar refrescos indefinidamente mientras no caduque', async () => {
      let session = await login.execute(credentials);
      for (let i = 0; i < 5; i += 1) {
        session = await refresh.execute({ refreshToken: session.refreshToken, ...context });
      }
      expect(session.accessToken).toBeTruthy();
    });

    it('recalcula los permisos: un cambio de rol se propaga al refrescar', async () => {
      const first = await login.execute(credentials);

      const user = (await users.findByIdAcrossTenants('u-1'))!;
      user.assignRoles([STYLIST_ROLE], clock.now(), 'admin');
      await users.update(user);

      const refreshed = await refresh.execute({ refreshToken: first.refreshToken, ...context });

      expect(refreshed.user.roles).toEqual(['STYLIST']);
      expect(refreshed.user.permissions).toEqual([...STYLIST_ROLE.permissions].sort());
    });

    it('registra el refresco en la auditoría', async () => {
      const first = await login.execute(credentials);
      audit.clear();
      await refresh.execute({ refreshToken: first.refreshToken, ...context });
      expect(audit.has('TOKEN_REFRESH')).toBe(true);
    });
  });

  describe('detección de reutilización', () => {
    it('rechaza un token ya rotado y derriba la familia entera', async () => {
      const first = await login.execute(credentials);
      const second = await refresh.execute({ refreshToken: first.refreshToken, ...context });

      // El escenario real: alguien copió el refresh token y lo usa después de que el
      // usuario legítimo ya lo haya rotado.
      await expect(
        refresh.execute({ refreshToken: first.refreshToken, ...context }),
      ).rejects.toThrow(RefreshTokenReuseError);

      // No basta con rechazar el token reutilizado: el sucesor —que puede estar en manos
      // del atacante— también queda revocado.
      expect(refreshTokens.all.every((t) => t.revokedAt !== null)).toBe(true);
      await expect(
        refresh.execute({ refreshToken: second.refreshToken, ...context }),
      ).rejects.toThrow(RefreshTokenReuseError);
    });

    it('deja rastro del incidente en la auditoría', async () => {
      const first = await login.execute(credentials);
      await refresh.execute({ refreshToken: first.refreshToken, ...context });
      audit.clear();

      await refresh
        .execute({ refreshToken: first.refreshToken, ...context })
        .catch(() => undefined);

      const incident = audit.entries.find((e) => e.action === 'TOKEN_REUSE_DETECTED');
      expect(incident).toBeDefined();
      expect(incident!.metadata).toMatchObject({ userId: 'u-1' });
    });

    it('no afecta a las sesiones de otras familias', async () => {
      const mobile = await login.execute(credentials);
      const desktop = await login.execute(credentials);

      await refresh.execute({ refreshToken: mobile.refreshToken, ...context });
      await refresh
        .execute({ refreshToken: mobile.refreshToken, ...context })
        .catch(() => undefined);

      // Un robo en el móvil no puede echar a la recepcionista del ordenador del salón:
      // por eso cada inicio de sesión abre su propia familia.
      await expect(
        refresh.execute({ refreshToken: desktop.refreshToken, ...context }),
      ).resolves.toBeDefined();
    });

    it('trata un jti válido con token incorrecto como un incidente', async () => {
      const first = await login.execute(credentials);
      const stored = refreshTokens.all[0];

      // Se falsifica el hash guardado: simula a alguien que conoce el jti (visible en el
      // JWT) pero no posee el token completo.
      await refreshTokens.create({
        ...stored,
        id: 'forged',
        tokenHash: '$fake$otra-cosa',
        userAgent: null,
        ipAddress: null,
      });
      const forged = refreshTokens.all.find((t) => t.id === 'forged')!;
      expect(forged.jti).toBe(stored.jti);

      await refreshTokens.revoke(stored.id, 'MANUAL', NOW);
      await expect(
        refresh.execute({ refreshToken: first.refreshToken, ...context }),
      ).rejects.toThrow();
    });
  });

  describe('tokens no utilizables', () => {
    it('rechaza un token inventado', async () => {
      await expect(
        refresh.execute({ refreshToken: 'refresh.inventado', ...context }),
      ).rejects.toThrow();
    });

    it('rechaza un token cuyo registro ya no existe', async () => {
      const first = await login.execute(credentials);
      await refreshTokens.deleteExpired(new Date('2100-01-01'));

      await expect(
        refresh.execute({ refreshToken: first.refreshToken, ...context }),
      ).rejects.toThrow(InvalidRefreshTokenError);
    });

    it('rechaza un token caducado', async () => {
      const first = await login.execute(credentials);
      clock.advanceBy(8 * 24 * 60 * 60_000); // ocho días: el TTL es de siete

      await expect(
        refresh.execute({ refreshToken: first.refreshToken, ...context }),
      ).rejects.toThrow(InvalidRefreshTokenError);
    });

    it('rechaza el refresco si la cuenta se ha desactivado entretanto', async () => {
      const first = await login.execute(credentials);

      const user = (await users.findByIdAcrossTenants('u-1'))!;
      user.deactivate(clock.now(), 'admin');
      await users.update(user);

      // Es aquí donde se corta el acceso de una cuenta dada de baja: el access token
      // vigente caduca solo en 15 minutos, pero no se podrá renovar (ADR-0005).
      await expect(
        refresh.execute({ refreshToken: first.refreshToken, ...context }),
      ).rejects.toThrow(AccountNotActiveError);
    });

    it('rechaza el refresco de un usuario eliminado', async () => {
      const first = await login.execute(credentials);
      await users.softDelete('u-1');

      await expect(
        refresh.execute({ refreshToken: first.refreshToken, ...context }),
      ).rejects.toThrow(InvalidRefreshTokenError);
    });
  });
});
