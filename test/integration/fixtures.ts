import { hash } from '@node-rs/argon2';

import {
  PERMISSION_DEFINITIONS,
  SYSTEM_ROLE_DEFINITIONS,
  SYSTEM_ROLES,
} from '@core/permissions/domain/permission-catalog';
import { ARGON2ID } from '@shared/infrastructure/security/argon2-password-hasher.adapter';
import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';
import { QueryScopeStore } from '@shared/infrastructure/persistence/prisma/query-scope';

/**
 * Datos de partida de la suite de integración.
 *
 * Crea **dos salones completos**. No es adorno: sin un segundo inquilino con datos
 * propios, un test de aislamiento no prueba nada —una consulta que hubiera olvidado el
 * filtro de tenant devolvería exactamente lo mismo que una correcta—. El salón B existe
 * para que ese olvido se note.
 */

/**
 * Inquilinos de la suite.
 *
 * Distintos de los del seed de desarrollo (`aaaaaaaa…`, `bbbbbbbb…`) a propósito: si una
 * mala configuración vuelve a apuntar los tests a otra base de datos, las filas no se
 * mezclan con las de desarrollo y el problema se ve en lugar de corromper datos.
 */
export const TENANT_A = '11111111-1111-7111-8111-111111111111';
export const TENANT_B = '22222222-2222-7222-8222-222222222222';

export const TEST_PASSWORD = 'ContrasenaDePrueba1';

/** Argon2 con parámetros mínimos: la suite hace decenas de logins y 19 MiB × N es caro. */
const testHash = (plain: string): Promise<string> =>
  hash(plain, { algorithm: ARGON2ID, memoryCost: 8_192, timeCost: 1, parallelism: 1 });

export interface SeededTenant {
  readonly tenantId: string;
  readonly slug: string;
  readonly ownerEmail: string;
  readonly receptionEmail: string;
  readonly stylistEmail: string;
  readonly stylistId: string;
  readonly clientId: string;
  readonly serviceId: string;
  readonly productId: string;
}

/**
 * Siembra el catálogo del sistema.
 *
 * Va sin filtro de salón porque `Permission` y los roles del sistema son globales
 * (ADR-0003) y porque, en este punto, no hay ninguna petición ni contexto de tenant.
 */
export async function seedSystemCatalog(prisma: PrismaService): Promise<Map<string, string>> {
  return QueryScopeStore.crossTenant(async () => {
    const permissionIds = new Map<string, string>();

    await prisma.client.permission.createMany({
      data: PERMISSION_DEFINITIONS.map((p) => ({ ...p })),
      skipDuplicates: true,
    });

    for (const permission of await prisma.client.permission.findMany()) {
      permissionIds.set(permission.code, permission.id);
    }

    const roleIds = new Map<string, string>();

    for (const definition of SYSTEM_ROLE_DEFINITIONS) {
      const id = `role-${definition.code.toLowerCase()}`;
      await prisma.client.role.create({
        data: {
          id,
          tenantId: null,
          code: definition.code,
          name: definition.name,
          description: definition.description,
          isSystem: true,
        },
      });

      const codes =
        definition.code === SYSTEM_ROLES.PLATFORM_ADMIN
          ? []
          : definition.permissions.filter((code) => permissionIds.has(code));

      if (codes.length > 0) {
        await prisma.client.rolePermission.createMany({
          data: codes.map((code) => ({ roleId: id, permissionId: permissionIds.get(code)! })),
        });
      }

      roleIds.set(definition.code, id);
    }

    return roleIds;
  });
}

/**
 * Genera identificadores deterministas con forma de UUIDv7 valido.
 *
 * Los controladores validan los parametros de ruta con `ParseUUIDPipe`, asi que unos
 * identificadores legibles del tipo `client-salon-a` producirian un 400 antes de llegar
 * al caso de uso —y un test que espera un 404 por aislamiento se convertiria en un test
 * que solo comprueba el validador de formato, sin darse cuenta.
 *
 * El prefijo distingue el salon, de modo que un identificador sigue diciendo a simple
 * vista de quien es cuando falla un aserto.
 */
const entityId = (prefix: string, kind: number): string =>
  `${prefix}000${kind}-0000-7000-8000-00000000000${kind}`;

export async function seedTenant(
  prisma: PrismaService,
  params: { tenantId: string; slug: string; prefix: string; roleIds: Map<string, string> },
): Promise<SeededTenant> {
  const { tenantId, slug, prefix, roleIds } = params;

  return QueryScopeStore.crossTenant(async () => {
    await prisma.client.tenant.create({
      data: {
        id: tenantId,
        name: `Salón ${slug}`,
        slug,
        email: `hola@${slug}.test`,
        currency: 'GTQ',
      },
    });

    const passwordHash = await testHash(TEST_PASSWORD);

    const people = [
      { local: 'owner', role: SYSTEM_ROLES.OWNER, first: 'Carmen', last: 'Ruiz' },
      { local: 'reception', role: SYSTEM_ROLES.RECEPTIONIST, first: 'Lucía', last: 'Fernández' },
      { local: 'stylist', role: SYSTEM_ROLES.STYLIST, first: 'Sara', last: 'Molina' },
    ];

    let stylistUserId = '';

    for (const person of people) {
      const userId = `user-${slug}-${person.local}`;
      await prisma.client.user.create({
        data: {
          id: userId,
          tenantId,
          email: `${person.local}@${slug}.test`,
          passwordHash,
          firstName: person.first,
          lastName: person.last,
          status: 'ACTIVE',
          roles: { create: { roleId: roleIds.get(person.role)! } },
        },
      });
      if (person.role === SYSTEM_ROLES.STYLIST) stylistUserId = userId;
    }

    const stylist = await prisma.client.stylist.create({
      data: {
        id: entityId(prefix, 1),
        tenantId,
        userId: stylistUserId,
        firstName: 'Sara',
        lastName: 'Molina',
        email: `stylist@${slug}.test`,
        commissionRate: '15.00',
      },
    });

    const client = await prisma.client.client.create({
      data: {
        id: entityId(prefix, 2),
        tenantId,
        firstName: 'Rosa',
        lastName: 'Iglesias',
        // El correo lleva el slug: los índices únicos son por (tenantId, email), así que
        // repetirlo entre salones sería legal, pero distinguirlos hace que un fallo de
        // aislamiento se vea en el aserto en lugar de pasar desapercibido.
        email: `rosa@${slug}.test`,
        phone: '+34600111222',
      },
    });

    const category = await prisma.client.category.create({
      data: {
        id: entityId(prefix, 3),
        tenantId,
        kind: 'SERVICE',
        name: 'Peluquería',
        slug: 'peluqueria',
      },
    });

    const service = await prisma.client.service.create({
      data: {
        id: entityId(prefix, 4),
        tenantId,
        categoryId: category.id,
        code: 'COR-M',
        name: 'Corte de señora',
        durationMinutes: 45,
        bufferMinutes: 10,
        price: '25.00',
        taxRate: '21.00',
      },
    });

    const product = await prisma.client.product.create({
      data: {
        id: entityId(prefix, 5),
        tenantId,
        sku: 'TIN-001',
        name: 'Tinte castaño',
        price: '18.50',
        costPrice: '7.20',
        stockOnHand: '20.000',
      },
    });

    return {
      tenantId,
      slug,
      ownerEmail: `owner@${slug}.test`,
      receptionEmail: `reception@${slug}.test`,
      stylistEmail: `stylist@${slug}.test`,
      stylistId: stylist.id,
      clientId: client.id,
      serviceId: service.id,
      productId: product.id,
    };
  });
}

/** Siembra el catálogo y los dos salones. Es el punto de partida de casi todo test. */
export async function seedTwoTenants(prisma: PrismaService): Promise<{
  salonA: SeededTenant;
  salonB: SeededTenant;
}> {
  const roleIds = await seedSystemCatalog(prisma);
  return {
    salonA: await seedTenant(prisma, {
      tenantId: TENANT_A,
      slug: 'salon-a',
      prefix: '1111',
      roleIds,
    }),
    salonB: await seedTenant(prisma, {
      tenantId: TENANT_B,
      slug: 'salon-b',
      prefix: '2222',
      roleIds,
    }),
  };
}
