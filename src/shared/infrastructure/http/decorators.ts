import {
  applyDecorators,
  createParamDecorator,
  SetMetadata,
  type ExecutionContext,
} from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';

import type { AccessTokenClaims } from '../../application/ports';

/**
 * Decoradores transversales.
 *
 * Todo lo que aparecería copiado en cada controlador —el `@ApiBearerAuth`, las
 * respuestas 401 y 403, el acceso al usuario— vive aquí (ADR-0002, no-duplicación).
 */

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const PERMISSIONS_KEY = 'auth:permissions';
export const PERMISSIONS_MODE_KEY = 'auth:permissionsMode';
export const AUTHENTICATED_ONLY_KEY = 'auth:authenticatedOnly';

/**
 * Marca un endpoint como accesible sin autenticar.
 *
 * Debe ser escaso y evidente: login, refresh y salud. Cada uso nuevo es una decisión de
 * seguridad, no una comodidad, y por eso se declara de forma expresa en vez de ser el
 * comportamiento por omisión.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Endpoint que exige sesion valida pero ningun permiso concreto.
 *
 * Es el tercer estado, junto a `@Public()` y `@RequirePermissions()`. Sin el, endpoints
 * como `/auth/me` o "cambiar mi contrasena" no encajarian en ninguna categoria: no son
 * publicos, pero tampoco existe un permiso que otorgar —todo el mundo puede consultar su
 * propio perfil, y no tendria sentido que la propietaria pudiera quitarselo a nadie.
 *
 * Marcarlos como `@Public()` habria sido el atajo facil y el error grave: el guard de
 * autenticacion no habria rellenado el usuario y `@CurrentUser()` habria reventado en
 * tiempo de ejecucion.
 */
export const Authenticated = () =>
  applyDecorators(
    SetMetadata(AUTHENTICATED_ONLY_KEY, true),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({ description: 'Token ausente, invalido o caducado' }),
  );

/**
 * Permisos exigidos por el endpoint (ADR-0006).
 *
 * Con varios permisos, por defecto se exigen **todos**. `mode: 'any'` los trata como
 * alternativas, que es lo que hace falta cuando existe la variante `.own`: quien tenga
 * `appointments.read` o `appointments.read.own` puede entrar, y es el caso de uso —no
 * el guard— quien decide qué filas ve cada cual.
 */
export const RequirePermissions = (...permissions: string[]) =>
  applyDecorators(
    SetMetadata(PERMISSIONS_KEY, permissions),
    SetMetadata(PERMISSIONS_MODE_KEY, 'all'),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({ description: 'Token ausente, inválido o caducado' }),
    ApiForbiddenResponse({ description: `Requiere el permiso: ${permissions.join(' + ')}` }),
  );

export const RequireAnyPermission = (...permissions: string[]) =>
  applyDecorators(
    SetMetadata(PERMISSIONS_KEY, permissions),
    SetMetadata(PERMISSIONS_MODE_KEY, 'any'),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({ description: 'Token ausente, inválido o caducado' }),
    ApiForbiddenResponse({ description: `Requiere alguno de: ${permissions.join(' | ')}` }),
  );

/** Usuario autenticado, extraído de los claims ya verificados por el guard. */
export const CurrentUser = createParamDecorator(
  (field: keyof AccessTokenClaims | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<{ user?: AccessTokenClaims }>();
    const user = request.user;
    if (!user) {
      // Ocurre si alguien usa @CurrentUser en un endpoint @Public. Es un fallo de
      // programación y debe verse en desarrollo, no degradarse a `undefined` y provocar
      // un error incomprensible tres capas más abajo.
      throw new Error(
        '@CurrentUser() se ha usado en un endpoint sin autenticación. ' +
          'Quite @Public() o deje de pedir el usuario.',
      );
    }
    return field ? user[field] : user;
  },
);

/** Salón activo. Atajo de `@CurrentUser('tenantId')`, que es lo que más se usa. */
export const CurrentTenant = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<{ user?: AccessTokenClaims }>();
  return request.user?.tenantId ?? null;
});
