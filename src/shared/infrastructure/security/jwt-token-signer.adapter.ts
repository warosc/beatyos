import { randomUUID } from 'node:crypto';

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';

import type { AccessTokenClaims, RefreshTokenClaims, TokenSigner } from '../../application/ports';
import type { Env } from '../config/env.schema';

/**
 * `expiresIn` de `jsonwebtoken` es un tipo de plantilla estricto (`"15m"`, `"7d"`...) que
 * TypeScript no puede derivar de un `string` genérico. El esquema de entorno ya obliga al
 * formato con la expresión `/^\d+[smhd]$/`, de modo que la conversión está respaldada por
 * una validación real y no es un atajo para callar al compilador.
 */
type ExpiresIn = NonNullable<JwtSignOptions['expiresIn']>;

/**
 * Firma y verificación de JWT (ADR-0005).
 *
 * Dos decisiones que no son negociables aquí:
 *
 * 1. **Secretos distintos para access y refresh.** Con un secreto compartido, un refresh
 *    token —de siete días de vida y guardado por el cliente— podría presentarse como
 *    access token y saltarse por completo la ventana de quince minutos que es toda la
 *    defensa del modelo. El esquema de entorno rechaza que coincidan.
 *
 * 2. **`issuer` y `audience` se verifican siempre.** Sin ellos, un token emitido por
 *    otro sistema que comparta secreto —un entorno de staging mal aislado, un servicio
 *    hermano— sería aceptado aquí.
 */
@Injectable()
export class JwtTokenSigner implements TokenSigner {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessTtl: string;
  private readonly refreshTtl: string;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService<Env, true>,
  ) {
    this.accessSecret = config.get('JWT_ACCESS_SECRET', { infer: true });
    this.refreshSecret = config.get('JWT_REFRESH_SECRET', { infer: true });
    this.accessTtl = config.get('JWT_ACCESS_TTL', { infer: true });
    this.refreshTtl = config.get('JWT_REFRESH_TTL', { infer: true });
    this.issuer = config.get('JWT_ISSUER', { infer: true });
    this.audience = config.get('JWT_AUDIENCE', { infer: true });
  }

  async signAccess(
    claims: Omit<AccessTokenClaims, 'jti'>,
  ): Promise<{ token: string; expiresAt: Date; jti: string }> {
    const jti = randomUUID();
    const token = await this.jwt.signAsync(
      { ...claims, jti },
      {
        secret: this.accessSecret,
        expiresIn: this.accessTtl as ExpiresIn,
        issuer: this.issuer,
        audience: this.audience,
      },
    );
    return { token, expiresAt: this.expiryOf(token), jti };
  }

  async signRefresh(
    claims: Omit<RefreshTokenClaims, 'jti'>,
  ): Promise<{ token: string; expiresAt: Date; jti: string }> {
    const jti = randomUUID();
    const token = await this.jwt.signAsync(
      { ...claims, jti },
      {
        secret: this.refreshSecret,
        expiresIn: this.refreshTtl as ExpiresIn,
        issuer: this.issuer,
        audience: this.audience,
      },
    );
    return { token, expiresAt: this.expiryOf(token), jti };
  }

  async verifyAccess(token: string): Promise<AccessTokenClaims> {
    return this.verifyWith<AccessTokenClaims>(token, this.accessSecret);
  }

  async verifyRefresh(token: string): Promise<RefreshTokenClaims> {
    return this.verifyWith<RefreshTokenClaims>(token, this.refreshSecret);
  }

  private async verifyWith<T extends object>(token: string, secret: string): Promise<T> {
    try {
      return await this.jwt.verifyAsync<T>(token, {
        secret,
        issuer: this.issuer,
        audience: this.audience,
        // Sin esto, un token con `alg: none` o firmado con un algoritmo simétrico
        // distinto al esperado podría pasar la verificación. Es la familia de ataques
        // de confusión de algoritmo, y la defensa es no dejar que el token elija.
        algorithms: ['HS256'],
      });
    } catch {
      // El motivo exacto (caducado, firma inválida, emisor ajeno) no se comunica: para
      // quien lo presenta, todos significan lo mismo, y distinguirlos le diría a un
      // atacante en qué parte está fallando.
      throw new UnauthorizedException('Token no válido o caducado');
    }
  }

  /** Lee `exp` del token ya firmado en lugar de recalcular el TTL por separado. */
  private expiryOf(token: string): Date {
    const decoded = this.jwt.decode(token);
    if (!decoded?.exp) {
      throw new Error('El token firmado no contiene fecha de expiración');
    }
    return new Date(decoded.exp * 1000);
  }
}
