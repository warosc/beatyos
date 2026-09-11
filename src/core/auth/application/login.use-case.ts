import { Inject, Injectable } from '@nestjs/common';

import {
  AUDIT_RECORDER,
  CLOCK,
  ID_GENERATOR,
  PASSWORD_HASHER,
  TOKEN_SIGNER,
  type AuditRecorder,
  type Clock,
  type IdGenerator,
  type PasswordHasher,
  type TokenSigner,
  type UseCase,
} from '../../../shared/application/ports';
import { InvalidCredentialsError } from '../../users/domain/user.errors';
import type { User } from '../../users/domain/user.entity';
import { USER_REPOSITORY, type UserRepository } from '../../users/domain/user.repository';
import {
  REFRESH_TOKEN_REPOSITORY,
  type RefreshTokenRepository,
} from '../domain/refresh-token.repository';
import { AUTH_POLICY, type AuthPolicy } from '../domain/auth-policy';

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
}

export interface AuthenticatedSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly tenantId: string | null;
    readonly roles: readonly string[];
    readonly permissions: readonly string[];
  };
}

/**
 * Inicio de sesión (ADR-0005).
 *
 * El orden de las operaciones de este caso de uso es una decisión de seguridad, no de
 * estilo. Cada paso está donde está por un motivo concreto que se documenta en línea.
 */
@Injectable()
export class LoginUseCase implements UseCase<LoginInput, AuthenticatedSession> {
  private readonly maxFailedAttempts: number;
  private readonly lockMinutes: number;

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(TOKEN_SIGNER) private readonly tokens: TokenSigner,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    @Inject(AUTH_POLICY) policy: AuthPolicy,
  ) {
    this.maxFailedAttempts = policy.maxFailedLoginAttempts;
    this.lockMinutes = policy.accountLockMinutes;
  }

  async execute(input: LoginInput): Promise<AuthenticatedSession> {
    const now = this.clock.now();

    // Búsqueda entre inquilinos: en este punto solo hay un correo y todavía no se sabe
    // a qué salón pertenece. Es la única consulta del sistema autorizada a hacerlo.
    const user = await this.users.findByEmailAcrossTenants(input.email);

    if (!user) {
      // Se compara contra un hash señuelo antes de responder. Sin esto, un correo
      // inexistente respondería en microsegundos y uno existente en decenas de
      // milisegundos: esa diferencia, medible desde fuera, permite enumerar la base de
      // usuarios probando correos.
      await this.hasher.verifyDummy();
      await this.audit.record({
        action: 'LOGIN_FAILED',
        entityType: 'User',
        metadata: { email: input.email, reason: 'UNKNOWN_EMAIL' },
      });
      throw new InvalidCredentialsError();
    }

    // Estado de la cuenta ANTES de verificar la contraseña: verificar un hash Argon2
    // cuesta ~50 ms de CPU deliberadamente, y gastarlos en una cuenta bloqueada
    // convertiría el propio bloqueo en un vector de agotamiento de recursos.
    user.assertCanAuthenticate(now);

    const passwordMatches = await this.hasher.verify(user.passwordHash, input.password);

    if (!passwordMatches) {
      user.registerFailedLogin(now, this.maxFailedAttempts, this.lockMinutes);
      await this.users.updateLoginState(user);

      await this.audit.record({
        action: 'LOGIN_FAILED',
        entityType: 'User',
        entityId: user.id,
        metadata: {
          reason: 'BAD_PASSWORD',
          attempts: user.failedLoginAttempts,
          locked: user.isLocked(now),
        },
      });

      // Mismo error que para un correo desconocido: quien lo recibe no puede distinguir
      // si el problema fue el correo o la contraseña.
      throw new InvalidCredentialsError();
    }

    // Rehash silencioso si los parámetros de Argon2 se han endurecido desde la última
    // vez. Es el único momento en que se tiene la contraseña en claro, así que es la
    // única oportunidad de hacerlo sin molestar al usuario.
    if (this.hasher.needsRehash(user.passwordHash)) {
      user.upgradePasswordHash(await this.hasher.hash(input.password), now);
    }

    user.registerSuccessfulLogin(now);
    await this.users.updateLoginState(user);

    const session = await this.issueSession(user, input, now);

    await this.audit.record({
      action: 'LOGIN',
      entityType: 'User',
      entityId: user.id,
      metadata: { roles: user.roleCodes },
    });

    return session;
  }

  /**
   * Emite el par de tokens y abre una familia de refresco nueva.
   *
   * Cada inicio de sesión abre su propia familia: así, cerrar la sesión del móvil por
   * robo no tira abajo la del ordenador del salón.
   */
  private async issueSession(
    user: User,
    input: LoginInput,
    now: Date,
  ): Promise<AuthenticatedSession> {
    const familyId = this.ids.generate();

    const access = await this.tokens.signAccess({
      sub: user.id,
      tenantId: user.tenantId,
      email: user.email.value,
      roles: user.roleCodes,
      permissions: user.effectivePermissions,
      tv: user.tokenVersion,
    });

    const refresh = await this.tokens.signRefresh({
      sub: user.id,
      tenantId: user.tenantId,
      familyId,
    });

    await this.refreshTokens.create({
      id: this.ids.generate(),
      jti: refresh.jti,
      userId: user.id,
      tenantId: user.tenantId,
      // El token se guarda hasheado, igual que una contraseña.
      tokenHash: await this.hasher.hash(refresh.token),
      familyId,
      expiresAt: refresh.expiresAt,
      userAgent: input.userAgent,
      ipAddress: input.ipAddress,
    });

    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      tokenType: 'Bearer',
      expiresIn: Math.floor((access.expiresAt.getTime() - now.getTime()) / 1000),
      user: {
        id: user.id,
        email: user.email.value,
        firstName: user.name.firstName,
        lastName: user.name.lastName,
        tenantId: user.tenantId,
        roles: user.roleCodes,
        permissions: user.effectivePermissions,
      },
    };
  }
}
