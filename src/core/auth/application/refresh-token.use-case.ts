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
import { InvalidRefreshTokenError, RefreshTokenReuseError } from '../../users/domain/user.errors';
import { USER_REPOSITORY, type UserRepository } from '../../users/domain/user.repository';
import {
  REFRESH_TOKEN_REPOSITORY,
  type RefreshTokenRepository,
} from '../domain/refresh-token.repository';
import type { AuthenticatedSession } from './login.use-case';

export interface RefreshInput {
  readonly refreshToken: string;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
}

/**
 * Renovación de sesión con rotación y detección de reutilización (ADR-0005).
 *
 * El mecanismo, en una frase: **cada refresh token se usa exactamente una vez**. Si uno
 * ya rotado vuelve a aparecer, es que hay dos portadores —el legítimo y quien se lo
 * copió— y no hay forma de saber cuál es cuál, así que se cierra la cadena entera.
 *
 * Es lo que convierte el robo de un refresh token de "acceso durante siete días" en
 * "acceso hasta que el usuario legítimo vuelva a entrar", que suele ser cuestión de
 * minutos. Y, de paso, deja rastro en la auditoría de que ha pasado algo raro.
 */
@Injectable()
export class RefreshTokenUseCase implements UseCase<RefreshInput, AuthenticatedSession> {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(TOKEN_SIGNER) private readonly tokens: TokenSigner,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async execute(input: RefreshInput): Promise<AuthenticatedSession> {
    const now = this.clock.now();

    // 1. Firma. Barato y descarta de entrada cualquier token inventado.
    const claims = await this.tokens.verifyRefresh(input.refreshToken);

    // 2. Existencia. Se busca por `jti`, no por el token: el token está hasheado y no se
    //    puede consultar por él (esa es justamente la protección).
    const stored = await this.refreshTokens.findByJti(claims.jti);
    if (!stored) {
      throw new InvalidRefreshTokenError();
    }

    // 3. Reutilización. Un token revocado que se presenta significa que alguien está
    //    usando una copia. Se derriba la familia completa antes de responder.
    if (stored.revokedAt !== null) {
      await this.refreshTokens.revokeFamily(stored.familyId, 'REUSE_DETECTED', now);
      await this.audit.record({
        action: 'TOKEN_REUSE_DETECTED',
        entityType: 'RefreshToken',
        entityId: stored.id,
        metadata: {
          userId: stored.userId,
          familyId: stored.familyId,
          revokedAt: stored.revokedAt.toISOString(),
          ipAddress: input.ipAddress,
        },
      });
      throw new RefreshTokenReuseError();
    }

    if (stored.expiresAt.getTime() <= now.getTime()) {
      throw new InvalidRefreshTokenError();
    }

    // 4. Posesión. Hasta aquí solo se ha probado que el `jti` existe; esto prueba que
    //    quien lo presenta tiene el token entero y no solo su identificador.
    const tokenMatches = await this.hasher.verify(stored.tokenHash, input.refreshToken);
    if (!tokenMatches) {
      // El `jti` es correcto pero el token no: alguien está probando. Se trata con la
      // misma severidad que una reutilización.
      await this.refreshTokens.revokeFamily(stored.familyId, 'HASH_MISMATCH', now);
      await this.audit.record({
        action: 'TOKEN_REUSE_DETECTED',
        entityType: 'RefreshToken',
        entityId: stored.id,
        metadata: { userId: stored.userId, reason: 'HASH_MISMATCH' },
      });
      throw new InvalidRefreshTokenError();
    }

    // 5. Usuario. Sin filtro de salón: el refresco llega sin access token, así que el
    //    contexto de la petición todavía no tiene tenant.
    const user = await this.users.findByIdAcrossTenants(stored.userId);
    if (!user) {
      throw new InvalidRefreshTokenError();
    }

    // Estado actual de la cuenta: es aquí, y no en cada petición, donde se comprueba que
    // el usuario sigue activo y que no le han revocado las sesiones (ADR-0005).
    user.assertCanAuthenticate(now);

    if (claims.jti && stored.userId !== user.id) {
      throw new InvalidRefreshTokenError();
    }

    // 6. Rotación. El token nuevo hereda la familia; el viejo queda marcado y enlazado
    //    con su sucesor, de modo que la cadena completa es reconstruible en una
    //    investigación posterior.
    const newRefresh = await this.tokens.signRefresh({
      sub: user.id,
      tenantId: user.tenantId,
      familyId: stored.familyId,
    });

    const newRecordId = this.ids.generate();

    await this.refreshTokens.create({
      id: newRecordId,
      jti: newRefresh.jti,
      userId: user.id,
      tenantId: user.tenantId,
      tokenHash: await this.hasher.hash(newRefresh.token),
      familyId: stored.familyId,
      expiresAt: newRefresh.expiresAt,
      userAgent: input.userAgent,
      ipAddress: input.ipAddress,
    });

    await this.refreshTokens.rotate(stored.id, newRecordId, now);

    const access = await this.tokens.signAccess({
      sub: user.id,
      tenantId: user.tenantId,
      email: user.email.value,
      // Los permisos se recalculan en cada refresco: un cambio de rol se propaga como
      // mucho en un ciclo de refresco, sin consultar la base en cada petición.
      roles: user.roleCodes,
      permissions: user.effectivePermissions,
      tv: user.tokenVersion,
    });

    await this.audit.record({
      action: 'TOKEN_REFRESH',
      entityType: 'RefreshToken',
      entityId: newRecordId,
      metadata: { userId: user.id, familyId: stored.familyId },
    });

    return {
      accessToken: access.token,
      refreshToken: newRefresh.token,
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
