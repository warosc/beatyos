import { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';

import type { AccessTokenClaims } from '../../application/ports';
import { CurrentTenant, CurrentUser } from './decorators';

/**
 * Decoradores de parámetro.
 *
 * `createParamDecorator` no expone su función de extracción, así que hay que recuperarla
 * de los metadatos de ruta —igual que hace NestJS al resolver el argumento—. Es el único
 * modo de probar estos decoradores sin levantar una aplicación entera, y merece la pena:
 * son el punto por el que el usuario autenticado entra en cada controlador.
 */
type ParamFactory = (data: unknown, context: ExecutionContext) => unknown;

const factoryOf = (decorator: (...args: never[]) => ParameterDecorator): ParamFactory => {
  class Probe {
    handler(@decorator() _value: unknown): void {}
  }

  const metadata = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'handler') as Record<
    string,
    { factory: ParamFactory }
  >;

  return metadata[Object.keys(metadata)[0]].factory;
};

const contextWithUser = (user?: AccessTokenClaims): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

const claims: AccessTokenClaims = {
  sub: 'user-1',
  tenantId: 'tenant-1',
  email: 'ana@salon.es',
  roles: ['OWNER'],
  permissions: ['clients.read'],
  tv: 0,
  jti: 'jti-1',
};

describe('@CurrentUser', () => {
  const factory = factoryOf(CurrentUser);

  it('devuelve los claims completos', () => {
    expect(factory(undefined, contextWithUser(claims))).toEqual(claims);
  });

  it('devuelve un campo concreto cuando se indica', () => {
    expect(factory('sub', contextWithUser(claims))).toBe('user-1');
    expect(factory('tenantId', contextWithUser(claims))).toBe('tenant-1');
  });

  it('falla ruidosamente si se usa en un endpoint sin autenticación', () => {
    // Ocurre al poner @CurrentUser en un endpoint @Public. Es un fallo de programación:
    // debe verse en desarrollo, no degradarse a `undefined` y reventar tres capas más
    // abajo con un error incomprensible.
    expect(() => factory(undefined, contextWithUser(undefined))).toThrow(
      /endpoint sin autenticación/,
    );
  });
});

describe('@CurrentTenant', () => {
  const factory = factoryOf(CurrentTenant);

  it('devuelve el salón del token', () => {
    expect(factory(undefined, contextWithUser(claims))).toBe('tenant-1');
  });

  it('devuelve null para una cuenta de plataforma', () => {
    // `tenantId` nulo identifica al administrador de plataforma, que opera entre salones
    // indicando el destino de forma explícita (ADR-0003).
    expect(factory(undefined, contextWithUser({ ...claims, tenantId: null }))).toBeNull();
  });

  it('devuelve null si no hay usuario, sin lanzar', () => {
    // A diferencia de @CurrentUser, aquí la ausencia es un resultado legítimo: hay
    // endpoints públicos que quieren saber el salón "si lo hay".
    expect(factory(undefined, contextWithUser(undefined))).toBeNull();
  });
});
