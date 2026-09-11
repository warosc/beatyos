import { QueryScopeStore } from '../persistence/prisma/query-scope';
import { RequestContextStore } from './request-context';

/**
 * El contexto de petición es la pieza sobre la que se apoya el aislamiento entre salones
 * (ADR-0003). Lo que estos tests protegen es que **cada petición tenga su propio
 * almacén**: si dos peticiones concurrentes compartieran contexto, una recepcionista
 * vería los datos del salón de la otra.
 */
describe('RequestContextStore', () => {
  describe('fuera de una petición', () => {
    it('devuelve un contexto anónimo en lugar de fallar', () => {
      // Un seed, un test o un job arrancado fuera de una petición deben poder llamar al
      // mismo código. El aislamiento no depende de que esto lance, sino de que
      // `tenantId` sea nulo y la extensión de Prisma rechace entonces la consulta.
      const context = RequestContextStore.get();

      expect(context.tenantId).toBeNull();
      expect(context.userId).toBeNull();
      expect(context.permissions).toEqual([]);
      expect(context.bypassTenantScope).toBe(false);
    });

    it('patch sobre un contexto inexistente no hace nada ni revienta', () => {
      expect(() => RequestContextStore.patch({ tenantId: 'x' })).not.toThrow();
      expect(RequestContextStore.tenantId).toBeNull();
    });
  });

  describe('dentro de una petición', () => {
    it('genera un identificador de correlación', () => {
      RequestContextStore.run({}, () => {
        expect(RequestContextStore.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      });
    });

    it('respeta el identificador de correlación entrante', () => {
      // Permite que una traza atraviese varios saltos —pasarela, servicio llamante— sin
      // romperse.
      RequestContextStore.run({ correlationId: 'trazado-externo' }, () => {
        expect(RequestContextStore.correlationId).toBe('trazado-externo');
      });
    });

    it('expone los datos del actor', () => {
      RequestContextStore.run({ tenantId: 't-1', userId: 'u-1', userEmail: 'a@b.c' }, () => {
        expect(RequestContextStore.tenantId).toBe('t-1');
        expect(RequestContextStore.userId).toBe('u-1');
        expect(RequestContextStore.get().userEmail).toBe('a@b.c');
      });
    });

    it('patch enriquece el contexto vivo', () => {
      // Es lo que hace el guard de autenticación tras validar el token: el middleware ya
      // abrió el contexto, y aquí se completa con quién es y en qué salón está.
      RequestContextStore.run({ ipAddress: '10.0.0.1' }, () => {
        RequestContextStore.patch({ tenantId: 't-9', permissions: ['clients.read'] });

        expect(RequestContextStore.tenantId).toBe('t-9');
        expect(RequestContextStore.get().permissions).toEqual(['clients.read']);
        expect(RequestContextStore.get().ipAddress).toBe('10.0.0.1');
      });
    });

    it('el contexto no sobrevive fuera de su ámbito', () => {
      RequestContextStore.run({ tenantId: 't-1' }, () => {
        expect(RequestContextStore.tenantId).toBe('t-1');
      });

      expect(RequestContextStore.tenantId).toBeNull();
    });

    it('cada ejecución tiene su propio almacén, incluso a través de await', async () => {
      // La garantía central: sin aislamiento por petición, dos peticiones concurrentes se
      // pisarían el `tenantId` y una vería los datos de la otra.
      const observed: (string | null)[] = [];

      const work = (tenantId: string): Promise<void> =>
        RequestContextStore.run({ tenantId }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          observed.push(RequestContextStore.tenantId);
        });

      await Promise.all([work('salon-a'), work('salon-b'), work('salon-c')]);

      expect(observed.sort()).toEqual(['salon-a', 'salon-b', 'salon-c']);
    });

    it('los contextos anidados no contaminan al padre', async () => {
      await RequestContextStore.run({ tenantId: 'padre' }, async () => {
        await RequestContextStore.runAsTenant('hijo', async () => {
          expect(RequestContextStore.tenantId).toBe('hijo');
        });

        expect(RequestContextStore.tenantId).toBe('padre');
      });
    });
  });

  describe('excepciones al ámbito de salón', () => {
    it('runWithoutTenantScope activa el bypass solo durante su ejecución', async () => {
      await RequestContextStore.run({ tenantId: 't-1' }, async () => {
        expect(RequestContextStore.get().bypassTenantScope).toBe(false);

        await RequestContextStore.runWithoutTenantScope(async () => {
          expect(RequestContextStore.get().bypassTenantScope).toBe(true);
        });

        // El bypass es una puerta que se cierra sola: dejarla abierta sería una fuga.
        expect(RequestContextStore.get().bypassTenantScope).toBe(false);
      });
    });

    it('runAsTenant fija el salón y desactiva cualquier bypass heredado', async () => {
      await RequestContextStore.runWithoutTenantScope(async () => {
        await RequestContextStore.runAsTenant('t-2', async () => {
          expect(RequestContextStore.tenantId).toBe('t-2');
          expect(RequestContextStore.get().bypassTenantScope).toBe(false);
        });
      });
    });

    it('funciona también fuera de una petición, para jobs y seeds', async () => {
      await RequestContextStore.runAsTenant('t-3', async () => {
        expect(RequestContextStore.tenantId).toBe('t-3');
      });
    });
  });
});

describe('QueryScopeStore', () => {
  it('por defecto no incluye borrados ni salta el filtro de salón', () => {
    expect(QueryScopeStore.current()).toEqual({ includeDeleted: false, bypassTenant: false });
  });

  it('includingDeleted solo afecta a su ámbito', async () => {
    await QueryScopeStore.includingDeleted(async () => {
      expect(QueryScopeStore.current().includeDeleted).toBe(true);
      // No arrastra el otro permiso: ver borrados y saltarse el salón son decisiones
      // distintas y ninguna implica la otra.
      expect(QueryScopeStore.current().bypassTenant).toBe(false);
    });

    expect(QueryScopeStore.current().includeDeleted).toBe(false);
  });

  it('crossTenant solo afecta a su ámbito', async () => {
    await QueryScopeStore.crossTenant(async () => {
      expect(QueryScopeStore.current().bypassTenant).toBe(true);
    });

    expect(QueryScopeStore.current().bypassTenant).toBe(false);
  });

  it('los ámbitos se componen y se deshacen en orden', async () => {
    await QueryScopeStore.crossTenant(async () => {
      await QueryScopeStore.includingDeleted(async () => {
        expect(QueryScopeStore.current()).toEqual({ includeDeleted: true, bypassTenant: true });
      });

      expect(QueryScopeStore.current()).toEqual({ includeDeleted: false, bypassTenant: true });
    });
  });
});
