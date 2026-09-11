import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_RECORDER,
  CLOCK,
  PASSWORD_HASHER,
  TOKEN_SIGNER,
  type AuditRecorder,
  type Clock,
  type PasswordHasher,
  type TokenSigner,
  type UseCase,
} from '../../../shared/application/ports';
import { EntityNotFoundError } from '../../../shared/domain/errors';
import { InvalidCredentialsError } from '../../users/domain/user.errors';
import { User } from '../../users/domain/user.entity';
import { USER_REPOSITORY, type UserRepository } from '../../users/domain/user.repository';
import {
  REFRESH_TOKEN_REPOSITORY,
  type RefreshTokenRepository,
} from '../domain/refresh-token.repository';

/**
 * Cierre de sesión y cambio de contraseña.
 *
 * Van juntos porque comparten el mismo objetivo —invalidar sesiones— y las mismas
 * dependencias. Separarlos en dos ficheros de veinte líneas repetiría el mismo bloque de
 * seis inyecciones sin añadir claridad.
 */

export interface LogoutInput {
  readonly refreshToken?: string;
  /**
   * Usuario que cierra sesión, si hay access token válido.
   *
   * Es opcional a propósito: cerrar sesión tiene que funcionar también con el access
   * token ya caducado, que es justo cuando el cliente más lo necesita. En ese caso el
   * usuario se deduce del propio refresh token, cuya posesión se verifica igualmente.
   */
  readonly userId?: string | null;
  /** `true` cierra todas las sesiones del usuario, no solo la actual. */
  readonly allDevices?: boolean;
}

export interface LogoutResult {
  readonly revokedSessions: number;
}

@Injectable()
export class LogoutUseCase implements UseCase<LogoutInput, LogoutResult> {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepository,
    @Inject(TOKEN_SIGNER) private readonly tokens: TokenSigner,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: LogoutInput): Promise<LogoutResult> {
    const now = this.clock.now();
    const session = await this.resolveSession(input.refreshToken);

    // El usuario del access token manda; si no lo hay, el del refresh token verificado.
    const userId = input.userId ?? session?.userId ?? null;

    if (!userId) {
      // Nada que revocar: ni sesión válida ni token utilizable. Se responde igualmente
      // con éxito, porque el estado que el cliente pedía —estar fuera— ya se cumple.
      return { revokedSessions: 0 };
    }

    // Si el access token y el refresh token son de usuarios distintos, alguien está
    // enviando un token ajeno. Se ignora en lugar de revocar la sesión de un tercero,
    // que sería una denegación de servicio trivial de explotar.
    const ownsToken = session !== null && session.userId === userId;

    let revoked = 0;
    if (input.allDevices) {
      revoked = await this.refreshTokens.revokeAllForUser(userId, 'LOGOUT_ALL', now);
    } else if (ownsToken) {
      // La familia entera, no solo el token presentado: dentro de una familia solo hay
      // un token vivo, y revocarla es como alcanzarlo aunque el cliente envíe uno
      // anterior por una carrera entre un refresco y el cierre de sesión.
      revoked = await this.refreshTokens.revokeFamily(session.familyId, 'LOGOUT', now);
    }

    await this.audit.record({
      action: 'LOGOUT',
      entityType: 'User',
      entityId: userId,
      metadata: { allDevices: input.allDevices === true, revokedSessions: revoked },
    });

    return { revokedSessions: revoked };
  }

  /** Verifica el refresh token y localiza su registro. `null` si no es utilizable. */
  private async resolveSession(
    refreshToken: string | undefined,
  ): Promise<{ userId: string; familyId: string } | null> {
    if (!refreshToken) return null;

    try {
      const claims = await this.tokens.verifyRefresh(refreshToken);
      const stored = await this.refreshTokens.findByJti(claims.jti);
      if (!stored) return null;
      return { userId: stored.userId, familyId: stored.familyId };
    } catch {
      // Un token inválido al cerrar sesión no es un error que comunicar: devolver un
      // fallo solo conseguiría que el cliente conservara la sesión en su lado.
      return null;
    }
  }
}

export interface ChangePasswordInput {
  readonly userId: string;
  readonly currentPassword: string;
  readonly newPassword: string;
}

/**
 * Cambio de contraseña por el propio usuario.
 *
 * Exige la contraseña actual aunque ya esté autenticado: si alguien deja la sesión
 * abierta en el ordenador de recepción, quien pase por delante no puede apropiarse de
 * la cuenta cambiándole la contraseña.
 */
@Injectable()
export class ChangePasswordUseCase implements UseCase<ChangePasswordInput, void> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: ChangePasswordInput): Promise<void> {
    const now = this.clock.now();
    const user = await this.users.findById(input.userId);

    if (!user) {
      throw new EntityNotFoundError('Usuario', input.userId);
    }

    const currentMatches = await this.hasher.verify(user.passwordHash, input.currentPassword);
    if (!currentMatches) {
      await this.audit.record({
        action: 'LOGIN_FAILED',
        entityType: 'User',
        entityId: user.id,
        metadata: { reason: 'CHANGE_PASSWORD_BAD_CURRENT' },
      });
      throw new InvalidCredentialsError();
    }

    // La política vive en el dominio para que rija igual desde HTTP, desde un seed o
    // desde un script de administración.
    User.validatePasswordStrength(input.newPassword);

    user.changePassword(await this.hasher.hash(input.newPassword), now, input.userId);
    await this.users.update(user);

    // Cambiar la contraseña suele ser la reacción a sospechar que la han comprometido.
    // Dejar vivas las sesiones abiertas haría inútil el cambio justo cuando más importa.
    await this.refreshTokens.revokeAllForUser(user.id, 'PASSWORD_CHANGED', now);

    await this.audit.record({
      action: 'UPDATE',
      entityType: 'User',
      entityId: user.id,
      metadata: { field: 'password', sessionsRevoked: true },
    });
  }
}

export interface CurrentUserProfile {
  readonly id: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly fullName: string;
  readonly phone: string | null;
  readonly avatarUrl: string | null;
  readonly locale: string;
  readonly status: string;
  readonly tenantId: string | null;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly lastLoginAt: string | null;
}

/**
 * Perfil del usuario autenticado.
 *
 * Se lee de la base y no de los claims del token: el token puede llevar hasta quince
 * minutos de retraso, y lo que la interfaz pinta en pantalla —nombre, avatar, permisos
 * del menú— debe reflejar el estado actual, no el de cuando se autenticó.
 */
@Injectable()
export class GetCurrentUserUseCase implements UseCase<string, CurrentUserProfile> {
  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepository) {}

  async execute(userId: string): Promise<CurrentUserProfile> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new EntityNotFoundError('Usuario', userId);
    }

    return {
      id: user.id,
      email: user.email.value,
      firstName: user.name.firstName,
      lastName: user.name.lastName,
      fullName: user.name.full,
      phone: user.phone?.value ?? null,
      avatarUrl: user.avatarUrl,
      locale: user.locale,
      status: user.status,
      tenantId: user.tenantId,
      roles: user.roleCodes,
      permissions: user.effectivePermissions,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    };
  }
}
