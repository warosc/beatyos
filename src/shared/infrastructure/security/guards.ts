import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { TOKEN_SIGNER, type AccessTokenClaims, type TokenSigner } from '../../application/ports';
import { Inject } from '@nestjs/common';
import {
  AUTHENTICATED_ONLY_KEY,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  PERMISSIONS_MODE_KEY,
} from '../http/decorators';
import { RequestContextStore } from '../context/request-context';
import { WILDCARD_PERMISSION } from '../../domain/authorization';

export { WILDCARD_PERMISSION };

type AuthenticatedRequest = Request & { user?: AccessTokenClaims };

/**
 * Guard de autenticación (ADR-0005).
 *
 * Se registra **global**: un endpoint está protegido salvo que lleve `@Public()`. El
 * orden importa —fallar hacia cerrado significa que olvidar una anotación deja el
 * endpoint inaccesible, no abierto al mundo.
 *
 * Aquí es donde el `tenantId` entra en el sistema: se toma del token firmado y de
 * ningún otro sitio. Leerlo de una cabecera o del cuerpo permitiría a cualquiera con
 * una sesión válida leer los datos de otro salón sin más que cambiar un número
 * (ADR-0003).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKEN_SIGNER) private readonly tokens: TokenSigner,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.isPublic(context)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request);

    if (!token) {
      throw new UnauthorizedException('Se requiere un token de acceso');
    }

    const claims = await this.tokens.verifyAccess(token);
    request.user = claims;

    // A partir de aquí, todo el árbol de llamadas —casos de uso, repositorios,
    // extensiones de Prisma— sabe en qué salón está sin recibirlo por parámetro.
    RequestContextStore.patch({
      userId: claims.sub,
      userEmail: claims.email,
      tenantId: claims.tenantId,
      permissions: claims.permissions,
    });

    return true;
  }

  private isPublic(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false
    );
  }

  private extractBearerToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    // Comparación insensible a mayúsculas: hay clientes que envían "bearer".
    return scheme?.toLowerCase() === 'bearer' && value ? value : null;
  }
}

/**
 * Guard de autorización (ADR-0006).
 *
 * Comprueba **permisos**, nunca roles. La diferencia importa: `@Roles('MANAGER')` obliga
 * a tocar código cada vez que el negocio matiza quién puede hacer qué;
 * `@RequirePermissions('cash.close')` permite recomponer los roles desde la propia
 * aplicación.
 *
 * Denegación por defecto: un endpoint autenticado que no declara permiso se rechaza. Un
 * endpoint sin anotar es casi siempre un olvido, y el olvido debe fallar hacia cerrado.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException('Se requiere autenticación');
    }

    // Sesion valida sin permiso concreto: el propio perfil, cambiar la propia
    // contrasena. Es una decision explicita del endpoint, no la ausencia de una.
    const authenticatedOnly = this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (authenticatedOnly) return true;

    if (!required || required.length === 0) {
      // No es un 403 corriente: es un aviso al equipo de que falta una anotación.
      this.logger.error(
        `${context.getClass().name}.${context.getHandler().name} no declara permisos. ` +
          'Añada @RequirePermissions(...) o @Public(). Se deniega por defecto (ADR-0006).',
      );
      throw new ForbiddenException('Endpoint sin política de autorización declarada');
    }

    const granted = new Set(user.permissions);
    if (granted.has(WILDCARD_PERMISSION)) {
      return true;
    }

    const mode =
      this.reflector.getAllAndOverride<'all' | 'any'>(PERMISSIONS_MODE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'all';

    const allowed =
      mode === 'any'
        ? required.some((permission) => granted.has(permission))
        : required.every((permission) => granted.has(permission));

    if (!allowed) {
      const missing = required.filter((permission) => !granted.has(permission));
      // El mensaje dice qué permiso falta. Es información sobre la política, no sobre
      // los datos: ayuda a quien administra el salón a componer bien los roles y no
      // revela nada sobre qué recursos existen.
      throw new ForbiddenException(
        `Permisos insuficientes. Falta${missing.length > 1 ? 'n' : ''}: ${missing.join(', ')}`,
      );
    }

    return true;
  }
}
