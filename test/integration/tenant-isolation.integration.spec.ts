import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';
import { RequestContextStore } from '@shared/infrastructure/context/request-context';
import { MissingTenantScopeError } from '@shared/infrastructure/persistence/prisma/prisma.extensions';

import { api, createTestApp, resetDatabase } from './app-harness';
import { seedTwoTenants, TEST_PASSWORD, type SeededTenant } from './fixtures';

/**
 * Aislamiento entre inquilinos (ADR-0003).
 *
 * **Este es el fichero más importante de la suite.** Una fuga entre salones es el fallo
 * más grave que puede tener este sistema: significa que la clienta de un negocio aparece
 * en la pantalla de su competidor. No hay funcionalidad que compense eso.
 *
 * El aislamiento se apoya en tres capas concéntricas y aquí se comprueban las tres:
 *
 *   1. El `tenantId` sale del token firmado y de ningún otro sitio.
 *   2. La extensión de Prisma inyecta el filtro aunque el repositorio lo olvide.
 *   3. El esquema tiene claves únicas compuestas con `tenantId`.
 *
 * Cada test intenta activamente una fuga. Un test que solo comprobara el camino feliz no
 * probaría nada: con un único salón sembrado, hasta una consulta sin filtro pasaría.
 */
describe('Aislamiento entre salones (integración)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let salonA: SeededTenant;
  let salonB: SeededTenant;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    const context = await createTestApp();
    app = context.app;
    prisma = context.prisma;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    ({ salonA, salonB } = await seedTwoTenants(prisma));
    tokenA = await login(salonA.ownerEmail);
    tokenB = await login(salonB.ownerEmail);
  });

  const login = async (email: string): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post(api('/auth/login'))
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    return response.body.data.accessToken as string;
  };

  const asA = (path: string) =>
    request(app.getHttpServer()).get(api(path)).set('Authorization', `Bearer ${tokenA}`);

  describe('lectura', () => {
    it('cada salón ve únicamente sus propias clientas', async () => {
      const listA = await asA('/clients').expect(200);

      expect(listA.body.data).toHaveLength(1);
      expect(listA.body.data[0].id).toBe(salonA.clientId);
      expect(listA.body.meta.total).toBe(1);

      // La clienta del salón B existe en la base y no aparece por ninguna parte.
      const allClients = await prisma.client.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM clients
      `;
      expect(Number(allClients[0].count)).toBe(2);
    });

    it('pedir por id una clienta de otro salón devuelve 404, no 403', async () => {
      const response = await asA(`/clients/${salonB.clientId}`).expect(404);

      // 404 y no 403 deliberadamente: un 403 confirmaría que ese identificador existe,
      // y eso ya es información sobre el negocio de otro (ADR-0008).
      expect(response.body.code).toBe('ENTITY_NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain(salonB.slug);
    });

    it('la búsqueda por texto no alcanza fichas de otro salón', async () => {
      // Ambos salones tienen una clienta llamada "Rosa Iglesias".
      const response = await asA('/clients?search=Rosa').expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].email).toBe(`rosa@${salonA.slug}.test`);
    });

    it('`includeDeleted` tampoco abre la puerta a otros salones', async () => {
      await prisma.client.$executeRaw`
        UPDATE clients SET "deletedAt" = NOW() WHERE id = ${salonB.clientId}
      `;

      const response = await asA('/clients?includeDeleted=true').expect(200);
      expect(response.body.data.every((c: { id: string }) => c.id === salonA.clientId)).toBe(true);
    });

    it('paginar no filtra registros ajenos por los bordes', async () => {
      const response = await asA('/clients?page=1&limit=100').expect(200);
      expect(response.body.meta.total).toBe(1);
      expect(response.body.data).toHaveLength(1);
    });
  });

  describe('escritura', () => {
    it('no se puede modificar una clienta de otro salón', async () => {
      await request(app.getHttpServer())
        .patch(api(`/clients/${salonB.clientId}`))
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ firstName: 'Secuestrada' })
        .expect(404);

      // Y, lo esencial: la fila del salón B sigue intacta.
      const untouched = await prisma.client.$queryRaw<{ firstName: string }[]>`
        SELECT "firstName" FROM clients WHERE id = ${salonB.clientId}
      `;
      expect(untouched[0].firstName).toBe('Rosa');
    });

    it('no se puede dar de baja una clienta de otro salón', async () => {
      await request(app.getHttpServer())
        .delete(api(`/clients/${salonB.clientId}`))
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);

      const alive = await prisma.client.$queryRaw<{ deletedAt: Date | null }[]>`
        SELECT "deletedAt" FROM clients WHERE id = ${salonB.clientId}
      `;
      expect(alive[0].deletedAt).toBeNull();
    });

    it('una clienta creada se asigna al salón del token, no al que se indique', async () => {
      const response = await request(app.getHttpServer())
        .post(api('/clients'))
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ firstName: 'Nueva', lastName: 'Clienta', phone: '+34600999888' })
        .expect(201);

      const row = await prisma.client.$queryRaw<{ tenantId: string }[]>`
        SELECT "tenantId" FROM clients WHERE id = ${response.body.data.id as string}
      `;
      expect(row[0].tenantId).toBe(salonA.tenantId);
    });

    it('enviar `tenantId` en el cuerpo se rechaza con 400', async () => {
      // `forbidNonWhitelisted` convierte el intento en un error explícito. Sin él, el
      // campo se descartaría en silencio: seguiría sin haber fuga, pero quien lo intenta
      // no se enteraría de que su ataque no funciona, y quien audita el código tampoco.
      const response = await request(app.getHttpServer())
        .post(api('/clients'))
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          firstName: 'Intrusa',
          lastName: 'Prueba',
          phone: '+34600777666',
          tenantId: salonB.tenantId,
        })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('unicidad por salón', () => {
    it('dos salones pueden tener una clienta con el mismo correo', async () => {
      const email = 'misma.persona@ejemplo.es';

      await request(app.getHttpServer())
        .post(api('/clients'))
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ firstName: 'María', lastName: 'López', email })
        .expect(201);

      // Una clienta puede ir a dos peluquerías distintas. Si el correo fuese único a
      // nivel global, el segundo salón no podría darla de alta —y descubriría, de paso,
      // que esa persona es clienta de otro sitio.
      await request(app.getHttpServer())
        .post(api('/clients'))
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ firstName: 'María', lastName: 'López', email })
        .expect(201);
    });

    it('dentro de un mismo salón el correo sigue siendo único', async () => {
      const email = 'duplicada@ejemplo.es';

      await request(app.getHttpServer())
        .post(api('/clients'))
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ firstName: 'Ana', lastName: 'Uno', email })
        .expect(201);

      const conflict = await request(app.getHttpServer())
        .post(api('/clients'))
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ firstName: 'Ana', lastName: 'Dos', email })
        .expect(409);

      expect(conflict.body.code).toBe('CLIENT_EMAIL_ALREADY_EXISTS');
    });

    it('el correo de una ficha eliminada puede reutilizarse tras recuperarla o crearla de nuevo', async () => {
      const email = 'reciclado@ejemplo.es';

      const created = await request(app.getHttpServer())
        .post(api('/clients'))
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ firstName: 'Temporal', lastName: 'Ficha', email })
        .expect(201);

      await request(app.getHttpServer())
        .delete(api(`/clients/${created.body.data.id as string}`))
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(204);

      // El índice único es PARCIAL (`WHERE "deletedAt" IS NULL`), así que la fila
      // borrada no bloquea el correo. La API avisa de que existe una ficha eliminada,
      // que es más útil que un error de unicidad opaco.
      const advice = await request(app.getHttpServer())
        .post(api('/clients'))
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ firstName: 'Nueva', lastName: 'Ficha', email })
        .expect(409);

      expect(advice.body.code).toBe('CLIENT_EXISTS_DELETED');
    });
  });

  describe('defensa en profundidad', () => {
    it('una consulta sin salón activo falla en vez de devolver datos de todos', async () => {
      // Simula el peor caso: código que llega al repositorio sin contexto de petición
      // —un job mal configurado, un endpoint marcado público por error—. La extensión de
      // Prisma no puede saber qué salón filtrar, así que revienta.
      //
      // La alternativa —devolver las filas de todos los inquilinos— sería una fuga total
      // y silenciosa. Fallar ruidosamente es la única respuesta aceptable.
      await expect(
        RequestContextStore.run({ tenantId: null }, () => prisma.client.client.findMany()),
      ).rejects.toThrow(MissingTenantScopeError);
    });

    it('el token de un salón no sirve para leer con la sesión del otro', async () => {
      const listB = await request(app.getHttpServer())
        .get(api('/clients'))
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);

      expect(listB.body.data).toHaveLength(1);
      expect(listB.body.data[0].id).toBe(salonB.clientId);
      expect(listB.body.data[0].id).not.toBe(salonA.clientId);
    });

    it('la auditoría de cada salón queda etiquetada con su inquilino', async () => {
      await request(app.getHttpServer())
        .post(api('/clients'))
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ firstName: 'Auditada', lastName: 'Alta', phone: '+34600555444' })
        .expect(201);

      const entries = await prisma.client.$queryRaw<{ tenantId: string | null }[]>`
        SELECT "tenantId" FROM audit_logs WHERE action = 'CREATE' AND "entityType" = 'Client'
      `;

      expect(entries).toHaveLength(1);
      expect(entries[0].tenantId).toBe(salonA.tenantId);
    });
  });

  describe('autorización por rol', () => {
    it('la recepción no puede anonimizar clientas', async () => {
      const receptionToken = await login(salonA.receptionEmail);

      // Anonimizar es irreversible y destruye datos personales. Es una decisión de la
      // propiedad, no de mostrador (ADR-0006).
      const response = await request(app.getHttpServer())
        .post(api(`/clients/${salonA.clientId}/anonymize`))
        .set('Authorization', `Bearer ${receptionToken}`)
        .send({ reason: 'Solicitud de la interesada del 2026-09-01' })
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(response.body.detail).toContain('clients.anonymize');
    });

    it('la propietaria sí puede, y la ficha queda irreconocible', async () => {
      await request(app.getHttpServer())
        .post(api(`/clients/${salonA.clientId}/anonymize`))
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ reason: 'Solicitud de la interesada del 2026-09-01' })
        .expect(204);

      const row = await prisma.client.$queryRaw<
        { firstName: string; email: string | null; allergies: string | null }[]
      >`SELECT "firstName", email, allergies FROM clients WHERE id = ${salonA.clientId}`;

      expect(row[0].firstName).toBe('Anónimo');
      expect(row[0].email).toBeNull();
      expect(row[0].allergies).toBeNull();
    });

    it('la auditoría de la anonimización no conserva los datos suprimidos', async () => {
      await request(app.getHttpServer())
        .post(api(`/clients/${salonA.clientId}/anonymize`))
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ reason: 'Solicitud de la interesada del 2026-09-01' })
        .expect(204);

      const entries = await prisma.client.$queryRaw<{ before: unknown; after: unknown }[]>`
        SELECT before, after FROM audit_logs WHERE action = 'ANONYMIZE'
      `;

      expect(entries).toHaveLength(1);
      // Copiar el "antes" aquí dejaría justo lo que se acaba de suprimir en una tabla
      // append-only que nadie puede borrar: la auditoría se convertiría en el escondite
      // de los datos que el RGPD obliga a destruir.
      expect(entries[0].before).toBeNull();
      expect(entries[0].after).toBeNull();
    });
  });
});
