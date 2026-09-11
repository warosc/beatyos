import { createHash } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { PrismaClient } from '@prisma/client';

import { ARGON2ID } from '../src/shared/infrastructure/security/argon2-password-hasher.adapter';

import {
  PERMISSION_DEFINITIONS,
  SYSTEM_ROLE_DEFINITIONS,
  SYSTEM_ROLES,
} from '../src/core/permissions/domain/permission-catalog';

/**
 * Siembra de datos.
 *
 * Dos partes con naturaleza muy distinta:
 *
 * 1. **Catálogo del sistema** (permisos y roles predefinidos). Es *obligatorio* y se
 *    ejecuta en **cada despliegue**. Sin él, un permiso recién introducido no existiría
 *    en la tabla y ningún rol podría tenerlo: el endpoint quedaría cerrado para todos.
 *    Por eso es idempotente —`upsert` en todo— y puede correrse mil veces seguidas.
 *
 * 2. **Salón de demostración**. Solo fuera de producción. Existe para que la suite de
 *    integración tenga datos realistas y para que alguien recién llegado al proyecto
 *    pueda abrir Swagger y ver el sistema funcionando en cinco minutos.
 *
 * El seed usa `PrismaClient` **sin las extensiones** de la aplicación a propósito: se
 * ejecuta fuera de toda petición, no hay contexto de salón, y necesita escribir en varios
 * inquilinos a la vez. Es la excepción legítima al ADR-0003.
 */

const prisma = new PrismaClient();

/**
 * Identificador determinista con forma de UUIDv7 válido.
 *
 * El seed usaba antes identificadores legibles del tipo `stylist-bella-vista-1`. Eran
 * cómodos de leer en la base de datos e **inservibles desde la API**: los controladores
 * validan los parámetros de ruta con `ParseUUIDPipe`, de modo que cualquier petición
 * contra los datos de demostración moría con un 400 antes de llegar al caso de uso.
 *
 * Esta función conserva lo bueno —el mismo dato produce siempre el mismo identificador,
 * y el prefijo dice a qué salón y a qué entidad pertenece— y añade lo que faltaba: que
 * sea un UUID de verdad.
 */
const seedId = (salonPrefix: string, entity: string, key: string): string => {
  const digest = createHash('sha256').update(`${salonPrefix}:${entity}:${key}`).digest('hex');
  // Se fuerzan la versión (7) y la variante (RFC 4122) para que valide como UUID.
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `7${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
};

/**
 * Existencias de apertura: lotes y su asiento en el kardex.
 *
 * El seed escribe `stockOnHand` directamente, que es un atajo aceptable para datos de
 * demostración, pero deja el ledger vacío. Como el ledger es la fuente de verdad y la
 * caché su suma (ADR-0011), un inventario sembrado sin movimientos arranca ya divergente:
 * la pantalla de kardex sale en blanco y cualquier comprobación de coherencia falla desde
 * el primer día.
 *
 * Es idempotente por la vía que importa: si el producto ya tiene movimientos, no anota
 * ninguno más. El ledger es de solo anexión y un `db:seed` repetido duplicaría las
 * entradas sin que nada pudiera borrarlas después.
 */
async function seedOpeningStock(
  prisma: PrismaClient,
  params: {
    tenantId: string;
    productId: string;
    product: {
      sku: string;
      stock: string;
      cost: string;
      batches: { number: string; quantity: string; cost: string; expiresInDays: number }[];
    };
  },
): Promise<void> {
  const { tenantId, productId, product } = params;

  const existing = await prisma.inventoryMovement.count({ where: { productId } });
  if (existing > 0) return;

  const day = 86_400_000;

  for (const batch of product.batches) {
    await prisma.productBatch.create({
      data: {
        id: seedId(tenantId, 'batch', product.sku + ':' + batch.number),
        tenantId,
        productId,
        batchNumber: batch.number,
        expiresAt: new Date(Date.now() + batch.expiresInDays * day),
        initialQuantity: batch.quantity,
        remainingQuantity: batch.quantity,
        unitCost: batch.cost,
        currency: 'GTQ',
      },
    });
  }

  // Un asiento por lote, o uno solo si el producto no los lleva. `balanceAfter` acumula
  // para que la serie del kardex se lea como lo que es: un saldo que avanza.
  let balance = 0;
  const entries = product.batches.length
    ? product.batches.map((batch) => ({
        quantity: batch.quantity,
        unitCost: batch.cost,
        batchId: seedId(tenantId, 'batch', product.sku + ':' + batch.number),
      }))
    : [{ quantity: product.stock, unitCost: product.cost, batchId: null }];

  for (const entry of entries) {
    balance += Number(entry.quantity);
    await prisma.inventoryMovement.create({
      data: {
        tenantId,
        productId,
        type: 'INITIAL_STOCK',
        quantityDelta: entry.quantity,
        balanceAfter: balance.toFixed(3),
        unitCost: entry.unitCost,
        currency: 'GTQ',
        sourceType: 'MANUAL',
        reason: 'Existencias de apertura',
        batchId: entry.batchId,
      },
    });
  }
}

const isProduction = process.env.NODE_ENV === 'production';

/** Parámetros bajos a propósito: el seed crea muchos usuarios y no protege nada real. */
const hashPassword = (plain: string): Promise<string> =>
  hash(plain, {
    algorithm: ARGON2ID,
    memoryCost: isProduction ? 19_456 : 8_192,
    timeCost: isProduction ? 2 : 1,
    parallelism: 1,
  });

// Identificadores fijos: hacen el seed reproducible y permiten referenciar datos
// concretos sin buscarlos primero.
//
// Son DISTINTOS de los que usan las fixtures de integración (`11111111…`, `22222222…`)
// y eso no es casualidad. Al principio coincidían, y una configuración de entorno mal
// resuelta hizo que la suite escribiera sus fixtures en la base de desarrollo: como los
// identificadores eran los mismos, las filas se mezclaron y el seed dejó de poder
// ejecutarse por colisión de claves únicas. Espacios de identificadores separados hacen
// que un fallo así sea visible de inmediato en lugar de corromper datos en silencio.
const TENANT_DEMO = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const TENANT_RIVAL = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

const DEMO_PASSWORD = 'SalonDemo2026';

async function seedPermissions(): Promise<Map<string, string>> {
  const byCode = new Map<string, string>();

  for (const definition of PERMISSION_DEFINITIONS) {
    const permission = await prisma.permission.upsert({
      where: { code: definition.code },
      // La descripción puede evolucionar; el código nunca, porque es contrato (ADR-0006).
      update: {
        description: definition.description,
        resource: definition.resource,
        action: definition.action,
      },
      create: definition,
    });
    byCode.set(permission.code, permission.id);
  }

  console.log(`  · ${byCode.size} permisos`);
  return byCode;
}

/**
 * Roles del sistema, compartidos por todos los salones (`tenantId = null`).
 *
 * Los permisos se **reemplazan** en cada ejecución, no se acumulan: si una versión nueva
 * retira un permiso a la recepción, el seed tiene que quitarlo de verdad. Un seed que
 * solo añade dejaría permisos huérfanos concedidos para siempre.
 */
async function seedSystemRoles(permissionIds: Map<string, string>): Promise<Map<string, string>> {
  const byCode = new Map<string, string>();

  for (const definition of SYSTEM_ROLE_DEFINITIONS) {
    // Se busca por la clave de negocio —el código— y no por el id: el id es un detalle
    // de implementación y cambiarlo no debe duplicar el rol.
    const existing = await prisma.role.findFirst({
      where: { tenantId: null, code: definition.code },
    });

    const role = existing
      ? await prisma.role.update({
          where: { id: existing.id },
          data: { name: definition.name, description: definition.description, isSystem: true },
        })
      : await prisma.role.create({
          data: {
            id: seedId('system', 'role', definition.code),
            tenantId: null,
            code: definition.code,
            name: definition.name,
            description: definition.description,
            isSystem: true,
          },
        });

    // El comodín del administrador de plataforma no es una fila de `Permission`: lo
    // resuelve el guard. Darle todos los permisos uno a uno obligaría a acordarse de
    // añadirle cada permiso nuevo, que es justo lo que el comodín evita.
    const codes =
      definition.code === SYSTEM_ROLES.PLATFORM_ADMIN
        ? []
        : definition.permissions.filter((code) => permissionIds.has(code));

    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    if (codes.length > 0) {
      await prisma.rolePermission.createMany({
        data: codes.map((code) => ({ roleId: role.id, permissionId: permissionIds.get(code)! })),
      });
    }

    byCode.set(definition.code, role.id);
    console.log(`  · ${definition.code}: ${codes.length} permisos`);
  }

  return byCode;
}

interface DemoSalon {
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
}

/**
 * Crea un salón completo.
 *
 * Se siembran **dos** salones, y no uno, por un motivo concreto: sin un segundo
 * inquilino con datos propios, los tests de fuga entre salones no tendrían nada contra
 * lo que comprobar el aislamiento. Un único salón haría pasar cualquier consulta, incluso
 * una que hubiera olvidado el filtro de tenant (ADR-0003).
 */
async function seedSalon(salon: DemoSalon, roleIds: Map<string, string>): Promise<void> {
  const { tenantId, slug, name } = salon;

  await prisma.tenant.upsert({
    where: { id: tenantId },
    update: { name },
    create: {
      id: tenantId,
      name,
      slug,
      legalName: `${name} S.L.`,
      taxId: `B${slug.slice(0, 8).toUpperCase()}`,
      email: `hola@${slug}.es`,
      phone: '+34910000000',
      city: 'Madrid',
      country: 'GT',
      timezone: 'America/Guatemala',
      currency: 'GTQ',
    },
  });

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const staff = [
    { local: 'propietaria', first: 'Carmen', last: 'Ruiz', role: SYSTEM_ROLES.OWNER },
    { local: 'encargada', first: 'Marta', last: 'Delgado', role: SYSTEM_ROLES.MANAGER },
    { local: 'recepcion', first: 'Lucía', last: 'Fernández', role: SYSTEM_ROLES.RECEPTIONIST },
    { local: 'estilista', first: 'Sara', last: 'Molina', role: SYSTEM_ROLES.STYLIST },
  ];

  for (const person of staff) {
    const email = `${person.local}@${slug}.es`;
    const existingUser = await prisma.user.findFirst({ where: { tenantId, email } });
    const user = await prisma.user.upsert({
      where: { id: existingUser?.id ?? seedId(slug, 'user', person.local) },
      // `update` con los mismos valores que `create`, y no `{}`.
      //
      // Un seed que no corrige las filas existentes no es idempotente: es "no hace nada
      // la segunda vez". Cuando los identificadores de salón cambiaron, las filas viejas
      // se quedaron apuntando al salón anterior y el seed no podía repararlas.
      // Repitiendo los valores, volver a ejecutarlo devuelve la base a un estado
      // conocido, que es justo lo que se le pide a un seed.
      update: {
        tenantId,
        email: `${person.local}@${slug}.es`,
        firstName: person.first,
        lastName: person.last,
        status: 'ACTIVE',
      },
      create: {
        id: seedId(slug, 'user', person.local),
        tenantId,
        email,
        passwordHash,
        firstName: person.first,
        lastName: person.last,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });

    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    await prisma.userRole.create({
      data: { userId: user.id, roleId: roleIds.get(person.role)! },
    });

    // La estilista tiene además ficha de profesional: es la que hace posible probar el
    // ámbito `.own` de la agenda.
    if (person.role === SYSTEM_ROLES.STYLIST) {
      const existingStylist = await prisma.stylist.findFirst({ where: { tenantId, email } });
      const stylist = await prisma.stylist.upsert({
        where: { id: existingStylist?.id ?? seedId(slug, 'stylist', '1') },
        update: { tenantId, userId: user.id, firstName: person.first, lastName: person.last },
        create: {
          id: seedId(slug, 'stylist', '1'),
          tenantId,
          userId: user.id,
          firstName: person.first,
          lastName: person.last,
          email,
          color: '#EC4899',
          commissionRate: '15.00',
          hiredAt: new Date('2024-03-01'),
        },
      });

      const activeScheduleCount = await prisma.stylistSchedule.count({
        where: { stylistId: stylist.id, deletedAt: null },
      });
      if (activeScheduleCount === 0) {
        await prisma.stylistSchedule.createMany({
          data: [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
            id: seedId(slug, 'schedule', String(dayOfWeek)),
            tenantId,
            stylistId: stylist.id,
            dayOfWeek,
            startMinutes: 9 * 60,
            endMinutes: 18 * 60,
          })),
        });
      }
    }
  }

  // --- Catálogo ------------------------------------------------------------
  const serviceCategory = await prisma.category.upsert({
    where: {
      id:
        (
          await prisma.category.findFirst({
            where: { tenantId, kind: 'SERVICE', slug: 'peluqueria' },
          })
        )?.id ?? seedId(slug, 'category', 'peluqueria'),
    },
    update: { tenantId, name: 'Peluquería', slug: 'peluqueria' },
    create: {
      id: seedId(slug, 'category', 'peluqueria'),
      tenantId,
      kind: 'SERVICE',
      name: 'Peluquería',
      slug: 'peluqueria',
      color: '#8B5CF6',
    },
  });

  const productCategory = await prisma.category.upsert({
    where: {
      id:
        (
          await prisma.category.findFirst({
            where: { tenantId, kind: 'PRODUCT', slug: 'coloracion' },
          })
        )?.id ?? seedId(slug, 'category', 'coloracion'),
    },
    update: { tenantId, name: 'Coloración', slug: 'coloracion' },
    create: {
      id: seedId(slug, 'category', 'coloracion'),
      tenantId,
      kind: 'PRODUCT',
      name: 'Coloración',
      slug: 'coloracion',
    },
  });

  const services = [
    { code: 'COR-M', name: 'Corte de señora', minutes: 45, price: '25.00', buffer: 10 },
    { code: 'COL-R', name: 'Color raíz', minutes: 90, price: '55.00', buffer: 15 },
    { code: 'MEC-B', name: 'Mechas balayage', minutes: 180, price: '120.00', buffer: 20 },
    { code: 'PEI-F', name: 'Peinado de fiesta', minutes: 60, price: '40.00', buffer: 10 },
  ];

  for (const [index, service] of services.entries()) {
    await prisma.service.upsert({
      where: {
        id:
          (await prisma.service.findFirst({ where: { tenantId, code: service.code } }))?.id ??
          seedId(slug, 'service', service.code),
      },
      update: {
        tenantId,
        categoryId: serviceCategory.id,
        name: service.name,
        durationMinutes: service.minutes,
        price: service.price,
        currency: 'GTQ',
        taxRate: '12.00',
      },
      create: {
        id: seedId(slug, 'service', service.code),
        tenantId,
        categoryId: serviceCategory.id,
        code: service.code,
        name: service.name,
        durationMinutes: service.minutes,
        bufferMinutes: service.buffer,
        price: service.price,
        currency: 'GTQ',
        taxRate: '12.00',
        sortOrder: index,
      },
    });
  }

  /**
   * Catálogo de demostración.
   *
   * Los productos químicos van con `tracksBatches` porque es lo que exige el Reglamento
   * (CE) 1223/2009 y porque así la demo enseña el reparto FEFO funcionando en lugar de
   * describirlo. El champú no lo lleva: no todo producto de un salón necesita lote, y
   * tenerlos mezclados es lo que hace la demo representativa (ADR-0012).
   *
   * `batches` lleva la caducidad en días desde hoy, para que la demo siga teniendo sentido
   * dentro de seis meses. Las cantidades suman el stock del producto: si no cuadraran, el
   * kardex mostraría una divergencia desde el primer arranque.
   */
  const products = [
    {
      sku: 'TIN-001',
      name: 'Tinte castaño 6.0',
      price: '18.50',
      cost: '7.20',
      stock: '24.000',
      tracksBatches: true,
      batches: [
        { number: 'L-2601-A', quantity: '10.000', cost: '7.00', expiresInDays: 45 },
        { number: 'L-2603-B', quantity: '14.000', cost: '7.34', expiresInDays: 210 },
      ],
    },
    {
      sku: 'CHA-002',
      name: 'Champú hidratante 300 ml',
      price: '14.90',
      cost: '5.80',
      stock: '40.000',
      tracksBatches: false,
      batches: [],
    },
    {
      sku: 'OXI-003',
      name: 'Oxidante 20 vol 1 L',
      price: '9.00',
      cost: '3.10',
      stock: '12.000',
      tracksBatches: true,
      batches: [{ number: 'L-2602-C', quantity: '12.000', cost: '3.10', expiresInDays: 120 }],
    },
  ];

  for (const product of products) {
    const saved = await prisma.product.upsert({
      where: {
        id:
          (await prisma.product.findFirst({ where: { tenantId, sku: product.sku } }))?.id ??
          seedId(slug, 'product', product.sku),
      },
      update: {
        tenantId,
        categoryId: productCategory.id,
        name: product.name,
        price: product.price,
        costPrice: product.cost,
        currency: 'GTQ',
        taxRate: '12.00',
        // Va también aquí y no solo en `create`: el seed es re-ejecutable y los productos
        // de una siembra anterior solo pasan por esta rama. Sin esta línea, los lotes se
        // creaban pero el producto seguía sin marcar como trazado, y el reparto FEFO no se
        // activaba nunca sobre los datos de demostración.
        tracksBatches: product.tracksBatches,
      },
      create: {
        id: seedId(slug, 'product', product.sku),
        tenantId,
        categoryId: productCategory.id,
        sku: product.sku,
        name: product.name,
        price: product.price,
        costPrice: product.cost,
        currency: 'GTQ',
        taxRate: '12.00',
        stockOnHand: product.stock,
        reorderPoint: '5.000',
        reorderQuantity: '20.000',
        unit: 'UNIT',
        tracksBatches: product.tracksBatches,
      },
    });

    await seedOpeningStock(prisma, { tenantId, productId: saved.id, product });
  }

  // --- Clientas ------------------------------------------------------------
  const clients = [
    { local: 'rosa', first: 'Rosa', last: 'Iglesias', phone: '+34600111222' },
    { local: 'elena', first: 'Elena', last: 'Vidal', phone: '+34600333444' },
    { local: 'pilar', first: 'Pilar', last: 'Serrano', phone: '+34600555666' },
  ];

  for (const client of clients) {
    await prisma.client.upsert({
      where: {
        id:
          (
            await prisma.client.findFirst({
              where: { tenantId, email: `${client.local}@${slug}-clientes.es` },
            })
          )?.id ?? seedId(slug, 'client', client.local),
      },
      update: {
        tenantId,
        firstName: client.first,
        lastName: client.last,
        email: `${client.local}@${slug}-clientes.es`,
        phone: client.phone,
      },
      create: {
        id: seedId(slug, 'client', client.local),
        tenantId,
        firstName: client.first,
        lastName: client.last,
        // El correo lleva el slug del salón: así los dos salones de demostración tienen
        // clientas distintas y el índice único parcial por (tenantId, email) no choca.
        email: `${client.local}@${slug}-clientes.es`,
        phone: client.phone,
        marketingConsent: true,
        marketingConsentAt: new Date(),
      },
    });
  }

  await prisma.supplier.upsert({
    where: {
      id:
        (await prisma.supplier.findFirst({ where: { tenantId, code: 'PROV-001' } }))?.id ??
        seedId(slug, 'supplier', '1'),
    },
    update: { tenantId, name: 'Distribuciones Bella', email: 'pedidos@distribella.es' },
    create: {
      id: seedId(slug, 'supplier', '1'),
      tenantId,
      code: 'PROV-001',
      name: 'Distribuciones Bella',
      email: 'pedidos@distribella.es',
      paymentTermDays: 30,
    },
  });

  console.log(
    `  · ${name}: ${staff.length} usuarios, ${services.length} servicios, ${products.length} productos, ${clients.length} clientas`,
  );
}

async function main(): Promise<void> {
  console.log('Sembrando catálogo del sistema...');
  const permissionIds = await seedPermissions();
  const roleIds = await seedSystemRoles(permissionIds);

  if (isProduction) {
    // En producción se siembra el catálogo y nada más: los datos de demostración
    // incluyen usuarios con una contraseña conocida y publicada en este fichero.
    console.log('\nNODE_ENV=production: se omiten los datos de demostración.');
    return;
  }

  console.log('\nSembrando salones de demostración...');
  await seedSalon(
    { tenantId: TENANT_DEMO, slug: 'bella-vista', name: 'Salón Bella Vista' },
    roleIds,
  );
  await seedSalon(
    { tenantId: TENANT_RIVAL, slug: 'estilo-urbano', name: 'Estilo Urbano' },
    roleIds,
  );

  console.log('\nListo. Acceda con:');
  console.log(`  propietaria@bella-vista.es / ${DEMO_PASSWORD}   (OWNER)`);
  console.log(`  encargada@bella-vista.es   / ${DEMO_PASSWORD}   (MANAGER)`);
  console.log(`  recepcion@bella-vista.es   / ${DEMO_PASSWORD}   (RECEPTIONIST)`);
  console.log(`  estilista@bella-vista.es   / ${DEMO_PASSWORD}   (STYLIST)`);
  console.log(
    '\nEl segundo salón (estilo-urbano) existe para probar el aislamiento entre inquilinos.',
  );
}

main()
  .catch((error: unknown) => {
    console.error('El seed ha fallado:', error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
