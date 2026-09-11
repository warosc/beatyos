import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AccessTokenClaims, TokenSigner } from '../../application/ports';
import { RequestContextStore } from '../context/request-context';
import {
  AUTHENTICATED_ONLY_KEY,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  PERMISSIONS_MODE_KEY,
} from '../http/decorators';
import { JwtAuthGuard, PermissionsGuard } from './guards';

/**
 * Guards de autenticación y autorización (ADR-0005 y ADR-0006).
 *
 * Los dos son globales, así que un fallo aquí no afecta a un endpoint: afecta a todos.
 * Lo que más importa de estos tests es el comportamiento ante lo **no declarado**: un
 * endpoint sin anotar debe quedar cerrado, nunca abierto.
 */
describe('Guards', () => {
  const claims = (overrides: Partial<AccessTokenClaims> = {}): AccessTokenClaims => ({
    sub: 'user-1',
    tenantId: 'tenant-1',
    email: 'ana@salon.es',
    roles: ['RECEPTIONIST'],
    permissions: ['clients.read', 'appointments.create'],
    tv: 0,
    jti: 'jti-1',
    ...overrides,
  });

  /** Contexto de ejecución mínimo, con los metadatos que declararía cada decorador. */
  const contextWith = (
    metadata: Record<string, unknown>,
    request: Record<string, unknown> = {},
  ): { context: ExecutionContext; reflector: Reflector; request: Record<string, unknown> } => {
    const handler = () => undefined;
    class TestController {}

    const reflector = {
      getAllAndOverride: (key: string) => metadata[key],
    } as unknown as Reflector;

    const context = {
      getHandler: () => handler,
      getClass: () => TestController,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    return { context, reflector, request };
  };

  describe('JwtAuthGuard', () => {
    const signer = (verify: (token: string) => Promise<AccessTokenClaims>): TokenSigner => ({
      verifyAccess: verify,
      signAccess: jest.fn(),
      signRefresh: jest.fn(),
      verifyRefresh: jest.fn(),
    });

    it('deja pasar un endpoint público sin mirar el token', async () => {
      const { context, reflector } = contextWith({ [IS_PUBLIC_KEY]: true });
      const verify = jest.fn();

      await expect(new JwtAuthGuard(reflector, signer(verify)).canActivate(context)).resolves.toBe(
        true,
      );
      expect(verify).not.toHaveBeenCalled();
    });

    it('rechaza sin cabecera de autorización', async () => {
      const { context, reflector } = contextWith({}, { headers: {} });

      await expect(
        new JwtAuthGuard(reflector, signer(jest.fn())).canActivate(context),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('acepta el esquema Bearer en cualquier combinación de mayúsculas', async () => {
      for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
        const { context, reflector, request } = contextWith(
          {},
          { headers: { authorization: `${scheme} token-valido` } },
        );

        await expect(
          new JwtAuthGuard(
            reflector,
            signer(() => Promise.resolve(claims())),
          ).canActivate(context),
        ).resolves.toBe(true);
        expect((request.user as AccessTokenClaims).sub).toBe('user-1');
      }
    });

    it('rechaza un esquema que no sea Bearer', async () => {
      const { context, reflector } = contextWith(
        {},
        { headers: { authorization: 'Basic dXNlcjpwYXNz' } },
      );

      await expect(
        new JwtAuthGuard(reflector, signer(jest.fn())).canActivate(context),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rechaza una cabecera Bearer sin valor', async () => {
      const { context, reflector } = contextWith({}, { headers: { authorization: 'Bearer' } });

      await expect(
        new JwtAuthGuard(reflector, signer(jest.fn())).canActivate(context),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('propaga el fallo de verificación del firmador', async () => {
      const { context, reflector } = contextWith(
        {},
        { headers: { authorization: 'Bearer manipulado' } },
      );

      await expect(
        new JwtAuthGuard(
          reflector,
          signer(() => Promise.reject(new UnauthorizedException('Token no válido'))),
        ).canActivate(context),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('vuelca el salón del token en el contexto de la petición', async () => {
      const { context, reflector } = contextWith(
        {},
        { headers: { authorization: 'Bearer valido' } },
      );

      await RequestContextStore.run({}, async () => {
        await new JwtAuthGuard(
          reflector,
          signer(() => Promise.resolve(claims({ tenantId: 'salon-9' }))),
        ).canActivate(context);

        // Es el punto exacto por donde entra el `tenantId` al sistema, y sale del token
        // firmado: nunca de una cabecera ni del cuerpo (ADR-0003).
        expect(RequestContextStore.tenantId).toBe('salon-9');
        expect(RequestContextStore.userId).toBe('user-1');
      });
    });
  });

  describe('PermissionsGuard', () => {
    const guardFor = (metadata: Record<string, unknown>, request: Record<string, unknown>) => {
      const { context, reflector } = contextWith(metadata, request);
      return { guard: new PermissionsGuard(reflector), context };
    };

    it('deja pasar los endpoints públicos', () => {
      const { guard, context } = guardFor({ [IS_PUBLIC_KEY]: true }, {});
      expect(guard.canActivate(context)).toBe(true);
    });

    it('exige sesión aunque el endpoint no pida permisos', () => {
      const { guard, context } = guardFor({ [AUTHENTICATED_ONLY_KEY]: true }, {});
      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    });

    it('deja pasar a cualquier usuario autenticado en un endpoint sin permiso concreto', () => {
      // `/auth/me` o "cambiar mi contraseña": no hay permiso que otorgar, todo el mundo
      // puede consultar su propio perfil.
      const { guard, context } = guardFor({ [AUTHENTICATED_ONLY_KEY]: true }, { user: claims() });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('DENIEGA un endpoint autenticado que no declara permisos', () => {
      // Es el caso más importante del fichero: olvidar `@RequirePermissions` cierra el
      // endpoint, no lo abre. El olvido debe fallar hacia el lado seguro (ADR-0006).
      const { guard, context } = guardFor({}, { user: claims() });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow(/sin política de autorización/);
    });

    it('deniega también con una lista de permisos vacía', () => {
      const { guard, context } = guardFor({ [PERMISSIONS_KEY]: [] }, { user: claims() });
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('concede cuando el usuario tiene el permiso exigido', () => {
      const { guard, context } = guardFor(
        { [PERMISSIONS_KEY]: ['clients.read'] },
        { user: claims() },
      );
      expect(guard.canActivate(context)).toBe(true);
    });

    it('en modo "all" exige todos los permisos', () => {
      const { guard, context } = guardFor(
        { [PERMISSIONS_KEY]: ['clients.read', 'clients.delete'], [PERMISSIONS_MODE_KEY]: 'all' },
        { user: claims() },
      );

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('en modo "any" basta con uno', () => {
      // Es lo que hace falta cuando existe la variante `.own`: quien tenga
      // `appointments.read` o `appointments.read.own` entra, y el caso de uso decide
      // después qué filas ve.
      const { guard, context } = guardFor(
        {
          [PERMISSIONS_KEY]: ['appointments.read', 'appointments.read.own'],
          [PERMISSIONS_MODE_KEY]: 'any',
        },
        { user: claims({ permissions: ['appointments.read.own'] }) },
      );

      expect(guard.canActivate(context)).toBe(true);
    });

    it('el comodín del administrador de plataforma concede cualquier permiso', () => {
      const { guard, context } = guardFor(
        { [PERMISSIONS_KEY]: ['reports.financial'] },
        { user: claims({ permissions: ['*'] }) },
      );

      expect(guard.canActivate(context)).toBe(true);
    });

    it('el mensaje dice qué permiso falta, sin revelar qué recursos existen', () => {
      const { guard, context } = guardFor(
        { [PERMISSIONS_KEY]: ['clients.anonymize'] },
        { user: claims() },
      );

      try {
        guard.canActivate(context);
        fail('se esperaba ForbiddenException');
      } catch (error) {
        // Información sobre la política, no sobre los datos: ayuda a quien administra el
        // salón a componer bien los roles.
        expect((error as ForbiddenException).message).toContain('clients.anonymize');
      }
    });

    it('enumera todos los permisos que faltan', () => {
      const { guard, context } = guardFor(
        { [PERMISSIONS_KEY]: ['cash.open', 'cash.close'] },
        { user: claims() },
      );

      expect(() => guard.canActivate(context)).toThrow(/cash.open, cash.close/);
    });
  });
});
