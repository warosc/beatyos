import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { USER_REPOSITORY, type UserRepository } from '@core/users/domain/user.repository';
import { DomainValidationError, EntityNotFoundError } from '@shared/domain/errors';
import { RequestContextStore } from '@shared/infrastructure/context/request-context';
import {
  AppendOnlyViolationError,
  MissingTenantScopeError,
} from '@shared/infrastructure/persistence/prisma/prisma.extensions';
import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';
import { QueryScopeStore } from '@shared/infrastructure/persistence/prisma/query-scope';
import { CLIENT_REPOSITORY, type ClientRepository } from '@salon/clients/domain/client.repository';

import { api, createTestApp, resetDatabase } from './app-harness';
import { seedTwoTenants, TEST_PASSWORD, type SeededTenant } from './fixtures';

/**
 * Capa de persistencia contra PostgreSQL real.
 *
 * Aquí se prueba lo que la suite unitaria **no puede**: que el SQL generado sea correcto,
 * que las extensiones de Prisma inyecten los filtros de verdad, que los índices parciales
 * de soft delete se comporten como se diseñaron y que la clase base de repositorios
 * —usada por todos los módulos— funcione de extremo a extremo (ADR-0009).
 */
describe('Persistencia (integración)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let clients: ClientRepository;
  let users: UserRepository;
  let salonA: SeededTenant;
  let salonB: SeededTenant;

  beforeAll(async () => {
    const context = await createTestApp();
    app = context.app;
    prisma = context.prisma;
    clients = app.get<ClientRepository>(CLIENT_REPOSITORY);
    users = app.get<UserRepository>(USER_REPOSITORY);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    ({ salonA, salonB } = await seedTwoTenants(prisma));
  });

  /** Ejecuta dentro del contexto de un salón, como haría una petición autenticada. */
  const inTenant = <T>(tenantId: string, work: () => Promise<T>): Promise<T> =>
    RequestContextStore.run({ tenantId, userId: 'tester' }, work);

  describe('PrismaRepositoryBase', () => {
    it('findById respeta el ámbito de salón', async () => {
      await inTenant(salonA.tenantId, async () => {
        expect(await clients.findById(salonA.clientId)).not.toBeNull();
        // La misma consulta, con un identificador del otro salón, no encuentra nada.
        expect(await clients.findById(salonB.clientId)).toBeNull();
      });
    });

    it('findByIdOrFail lanza un error de dominio, no uno de Prisma', async () => {
      await inTenant(salonA.tenantId, async () => {
        await expect(clients.findByIdOrFail(salonB.clientId)).rejects.toThrow(EntityNotFoundError);
      });
    });

    it('exists y count solo ven el propio salón', async () => {
      await inTenant(salonA.tenantId, async () => {
        expect(await clients.exists(salonA.clientId)).toBe(true);
        expect(await clients.exists(salonB.clientId)).toBe(false);
        expect(await clients.count({})).toBe(1);
      });
    });

    it('search pagina y devuelve metadatos coherentes', async () => {
      await inTenant(salonA.tenantId, async () => {
        for (let i = 0; i < 5; i += 1) {
          await prisma.client.client.create({
            data: {
              tenantId: salonA.tenantId,
              firstName: `Clienta${i}`,
              lastName: `Apellido${i}`,
              phone: `+3460000000${i}`,
            },
          });
        }

        const page = await clients.search({}, { page: 2, limit: 2 });

        expect(page.data).toHaveLength(2);
        expect(page.meta).toMatchObject({
          page: 2,
          limit: 2,
          total: 6,
          totalPages: 3,
          hasNext: true,
          hasPrevious: true,
        });
      });
    });

    it('ordena por un campo lógico que expande a varias columnas', async () => {
      await inTenant(salonA.tenantId, async () => {
        await prisma.client.client.create({
          data: {
            tenantId: salonA.tenantId,
            firstName: 'Zoe',
            lastName: 'Abad',
            phone: '+34600000091',
          },
        });

        const page = await clients.search(
          {},
          { page: 1, limit: 10, sort: [{ field: 'name', direction: 'asc' }] },
        );

        // "Ordenar por nombre" son en realidad apellidos y luego nombre, como en
        // cualquier listado de personas.
        expect(page.data.map((c) => c.name.lastName)).toEqual(['Abad', 'Iglesias']);
      });
    });

    it('rechaza ordenar por un campo fuera de la lista blanca', async () => {
      await inTenant(salonA.tenantId, async () => {
        // Sin lista blanca, el parámetro `sort` de la URL permitiría ordenar por columnas
        // sin índice y provocar escaneos completos a voluntad de cualquier cliente.
        await expect(
          clients.search(
            {},
            { page: 1, limit: 10, sort: [{ field: 'passwordHash' as never, direction: 'asc' }] },
          ),
        ).rejects.toThrow(DomainValidationError);
      });
    });

    it('filtra por texto en varios campos a la vez', async () => {
      await inTenant(salonA.tenantId, async () => {
        const byName = await clients.search({ search: 'Iglesias' }, { page: 1, limit: 10 });
        const byEmail = await clients.search({ search: 'salon-a' }, { page: 1, limit: 10 });

        expect(byName.meta.total).toBe(1);
        expect(byEmail.meta.total).toBe(1);
      });
    });

    it('la búsqueda por texto es insensible a mayúsculas', async () => {
      await inTenant(salonA.tenantId, async () => {
        const page = await clients.search({ search: 'IGLESIAS' }, { page: 1, limit: 10 });
        expect(page.meta.total).toBe(1);
      });
    });

    it('un filtro de texto vacío no filtra nada', async () => {
      await inTenant(salonA.tenantId, async () => {
        expect((await clients.search({ search: '   ' }, { page: 1, limit: 10 })).meta.total).toBe(
          1,
        );
      });
    });

    it('el ciclo completo de soft delete y restauración', async () => {
      await inTenant(salonA.tenantId, async () => {
        await clients.softDelete(salonA.clientId, 'tester');

        // Desaparece de las consultas normales...
        expect(await clients.findById(salonA.clientId)).toBeNull();
        expect(await clients.count({})).toBe(0);
        // ...pero sigue ahí si se pide explícitamente.
        expect(await clients.findById(salonA.clientId, { includeDeleted: true })).not.toBeNull();

        const restored = await clients.restore(salonA.clientId, 'tester');

        expect(restored.isDeleted).toBe(false);
        expect(await clients.findById(salonA.clientId)).not.toBeNull();
      });
    });

    it('borrar dos veces falla la segunda', async () => {
      await inTenant(salonA.tenantId, async () => {
        await clients.softDelete(salonA.clientId, 'tester');
        await expect(clients.softDelete(salonA.clientId, 'tester')).rejects.toThrow(
          EntityNotFoundError,
        );
      });
    });

    it('no se puede restaurar algo que nunca se borró', async () => {
      await inTenant(salonA.tenantId, async () => {
        await expect(clients.restore(salonA.clientId, 'tester')).rejects.toThrow(
          EntityNotFoundError,
        );
      });
    });

    it('no se puede borrar ni restaurar un registro de otro salón', async () => {
      await inTenant(salonA.tenantId, async () => {
        await expect(clients.softDelete(salonB.clientId, 'tester')).rejects.toThrow(
          EntityNotFoundError,
        );
        await expect(clients.restore(salonB.clientId, 'tester')).rejects.toThrow(
          EntityNotFoundError,
        );
      });
    });

    it('el borrado registra autor y fecha', async () => {
      await inTenant(salonA.tenantId, async () => {
        await clients.softDelete(salonA.clientId, 'tester');

        const row = await QueryScopeStore.includingDeleted(() =>
          prisma.client.client.findFirst({ where: { id: salonA.clientId } }),
        );

        expect(row!.deletedAt).not.toBeNull();
        expect(row!.deletedBy).toBe('tester');
      });
    });
  });

  describe('extensiones de Prisma', () => {
    it('inyecta el tenant en las creaciones sin que el repositorio lo indique', async () => {
      await inTenant(salonA.tenantId, async () => {
        const created = await prisma.client.client.create({
          data: { firstName: 'Sin', lastName: 'Tenant', phone: '+34600123456' } as never,
        });

        // El repositorio no ha puesto `tenantId` en ninguna parte: lo ha añadido la
        // extensión. Es la red que hace inofensivo el olvido (ADR-0003).
        expect(created.tenantId).toBe(salonA.tenantId);
      });
    });

    it('filtra por tenant también en createMany', async () => {
      await inTenant(salonA.tenantId, async () => {
        await prisma.client.client.createMany({
          data: [
            { firstName: 'Lote', lastName: 'Uno', phone: '+34600000071' },
            { firstName: 'Lote', lastName: 'Dos', phone: '+34600000072' },
          ] as never,
        });

        expect(await clients.count({})).toBe(3);
      });
    });

    it('rechaza modificar una tabla append-only antes de llegar a la base', async () => {
      await inTenant(salonA.tenantId, async () => {
        const entry = await QueryScopeStore.crossTenant(() =>
          prisma.client.auditLog.create({
            data: { tenantId: salonA.tenantId, action: 'CREATE', entityType: 'Client' },
          }),
        );

        // La base tiene además un trigger; la extensión lo atrapa antes y con un mensaje
        // que dice qué hacer en lugar de un error de PostgreSQL.
        await expect(
          prisma.client.auditLog.update({ where: { id: entry.id }, data: { action: 'DELETE' } }),
        ).rejects.toThrow(AppendOnlyViolationError);

        await expect(prisma.client.auditLog.delete({ where: { id: entry.id } })).rejects.toThrow(
          AppendOnlyViolationError,
        );
      });
    });

    it('el ledger de inventario también es inmutable', async () => {
      await inTenant(salonA.tenantId, async () => {
        await expect(
          prisma.client.inventoryMovement.updateMany({
            where: { productId: salonA.productId },
            data: { quantityDelta: '99' },
          }),
        ).rejects.toThrow(AppendOnlyViolationError);
      });
    });

    it('una consulta sin salón activo falla en lugar de devolver todo', async () => {
      await expect(
        RequestContextStore.run({ tenantId: null }, () => prisma.client.service.findMany()),
      ).rejects.toThrow(MissingTenantScopeError);
    });

    it('crossTenant permite las operaciones legítimas entre inquilinos', async () => {
      const all = await QueryScopeStore.crossTenant(() => prisma.client.client.findMany());
      expect(all).toHaveLength(2);
    });

    it('los modelos globales no exigen tenant', async () => {
      // `Permission` es global: el catálogo de acciones lo define el software, no el
      // inquilino.
      const permissions = await RequestContextStore.run({ tenantId: null }, () =>
        prisma.client.permission.findMany(),
      );
      expect(permissions.length).toBeGreaterThan(0);
    });
  });

  describe('repositorio de usuarios', () => {
    it('busca por correo atravesando inquilinos, como necesita el login', async () => {
      const user = await users.findByEmailAcrossTenants(salonB.ownerEmail);

      // Es la única consulta autorizada a cruzar salones: en el login solo hay un correo
      // y todavía no se sabe a qué salón pertenece.
      expect(user).not.toBeNull();
      expect(user!.tenantId).toBe(salonB.tenantId);
    });

    it('la búsqueda por correo es insensible a mayúsculas', async () => {
      expect(await users.findByEmailAcrossTenants(salonA.ownerEmail.toUpperCase())).not.toBeNull();
    });

    it('devuelve null para un correo desconocido', async () => {
      expect(await users.findByEmailAcrossTenants('nadie@ninguna-parte.test')).toBeNull();
    });

    it('carga los roles y sus permisos', async () => {
      const user = await users.findByEmailAcrossTenants(salonA.ownerEmail);

      expect(user!.roleCodes).toEqual(['OWNER']);
      // Sin los permisos cargados no se podría firmar un access token útil.
      expect(user!.effectivePermissions.length).toBeGreaterThan(50);
    });

    it('existsByEmail comprueba en toda la plataforma', async () => {
      await expect(users.existsByEmail(salonB.ownerEmail)).resolves.toBe(true);
      await expect(users.existsByEmail('libre@ninguna-parte.test')).resolves.toBe(false);
    });

    it('excluye un usuario concreto al comprobar la unicidad', async () => {
      const user = await users.findByEmailAcrossTenants(salonA.ownerEmail);
      // Es lo que necesita una edición: el correo "ya existe", pero es el suyo propio.
      await expect(users.existsByEmail(salonA.ownerEmail, user!.id)).resolves.toBe(false);
    });

    it('cuenta las propietarias activas del salón', async () => {
      await inTenant(salonA.tenantId, async () => {
        expect(await users.countActiveOwners()).toBe(1);
        const owner = await users.findByEmail(salonA.ownerEmail);
        // Sostiene la regla de no dejar el salón sin nadie que lo administre.
        expect(await users.countActiveOwners(owner!.id)).toBe(0);
      });
    });

    it('search filtra por rol y por texto dentro del salón', async () => {
      await inTenant(salonA.tenantId, async () => {
        const owners = await users.search({ roleCode: 'OWNER' }, { page: 1, limit: 10 });
        const byText = await users.search({ search: 'Molina' }, { page: 1, limit: 10 });
        const all = await users.search({}, { page: 1, limit: 10 });

        expect(owners.meta.total).toBe(1);
        expect(byText.meta.total).toBe(1);
        // Tres usuarios en el salón A; los del salón B no aparecen.
        expect(all.meta.total).toBe(3);
      });
    });

    it('search filtra por estado', async () => {
      await inTenant(salonA.tenantId, async () => {
        expect((await users.search({ status: 'ACTIVE' }, { page: 1, limit: 10 })).meta.total).toBe(
          3,
        );
        expect(
          (await users.search({ status: 'INACTIVE' }, { page: 1, limit: 10 })).meta.total,
        ).toBe(0);
      });
    });

    it('actualiza el agregado y sincroniza sus roles de forma atómica', async () => {
      await inTenant(salonA.tenantId, async () => {
        const user = (await users.findByEmail(salonA.receptionEmail))!;

        user.assignRoles(
          [{ id: 'role-manager', code: 'MANAGER', permissions: [] }],
          new Date(),
          'tester',
        );
        const saved = await users.update(user);

        expect(saved.roleCodes).toEqual(['MANAGER']);
        // Reasignar roles sube la versión de token para que el cambio se note ya.
        expect(saved.tokenVersion).toBe(user.tokenVersion);
      });
    });

    it('dar de baja a un usuario corta su acceso de inmediato', async () => {
      await inTenant(salonA.tenantId, async () => {
        const user = (await users.findByEmail(salonA.receptionEmail))!;
        const versionBefore = user.tokenVersion;

        await users.softDelete(user.id, 'tester');

        const row = await QueryScopeStore.includingDeleted(() =>
          prisma.client.user.findFirst({ where: { id: user.id } }),
        );

        expect(row!.deletedAt).not.toBeNull();
        // Sin subir la versión seguiría trabajando hasta que caducara su token.
        expect(row!.tokenVersion).toBe(versionBefore + 1);
      });
    });

    it('restaura un usuario dado de baja', async () => {
      await inTenant(salonA.tenantId, async () => {
        const user = (await users.findByEmail(salonA.receptionEmail))!;

        await users.softDelete(user.id, 'tester');
        const restored = await users.restore(user.id, 'tester');

        expect(restored.id).toBe(user.id);
        expect(await users.findById(user.id)).not.toBeNull();
      });
    });

    it('actualizar un usuario inexistente da un error de dominio', async () => {
      await inTenant(salonA.tenantId, async () => {
        await expect(users.softDelete('00000000-0000-7000-8000-000000000000', 'x')).rejects.toThrow(
          EntityNotFoundError,
        );
      });
    });
  });

  describe('la caché del agregado se mantiene coherente', () => {
    it('el importe acumulado sobrevive al viaje por PostgreSQL sin perder precisión', async () => {
      const token = await request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email: salonA.ownerEmail, password: TEST_PASSWORD })
        .expect(200)
        .then((r) => r.body.data.accessToken as string);

      await prisma.client.$executeRaw`
        UPDATE clients SET "totalSpent" = 1234.56 WHERE id = ${salonA.clientId}
      `;

      const response = await request(app.getHttpServer())
        .get(api(`/clients/${salonA.clientId}`))
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // El importe cruza `numeric` de PostgreSQL, `Decimal` de Prisma, `Money` del
      // dominio y JSON, y sigue siendo exacto. Si en algún punto pasara por `number`,
      // aquí aparecería un 1234.5599999999999.
      expect(response.body.data.totalSpent).toBe('1234.56');
      expect(typeof response.body.data.totalSpent).toBe('string');
    });
  });
});
