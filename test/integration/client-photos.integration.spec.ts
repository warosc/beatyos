import { createHash } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { OBJECT_STORAGE, type ObjectStorage } from '@shared/application/object-storage.port';
import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';
import { QueryScopeStore } from '@shared/infrastructure/persistence/prisma/query-scope';

import { api, createTestApp, resetDatabase } from './app-harness';
import { seedTwoTenants, TEST_PASSWORD, type SeededTenant } from './fixtures';

/**
 * Fotos de clienta, de extremo a extremo y contra MinIO de verdad.
 *
 * Lo que se comprueba aquí no lo puede afirmar un test unitario: que el objeto acaba en el
 * almacén, que la URL firmada lo devuelve, y que al purgar desaparece de verdad. Un doble en
 * memoria diría que sí a todo.
 *
 * La prueba que más importa es la del fichero disfrazado: un HTML con un `<script>` dentro,
 * llamado `foto.jpg` y declarado `image/jpeg`. Si el sistema lo aceptara y después lo
 * sirviera, sería ejecución de código en el dominio que sirve las fotos.
 */

/** JPEG mínimo válido: firma SOI + APP0 y un marcador de fin. */
const jpegBytes = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

/** PNG mínimo con dimensiones declaradas en la cabecera IHDR. */
const pngBytes = (width: number, height: number): Buffer => {
  const buffer = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};

const CONSENT = '2026-09-03T09:00:00.000Z';

describe('Fotos de clienta (integración)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: ObjectStorage;
  let salonA: SeededTenant;
  let token: string;

  beforeAll(async () => {
    const context = await createTestApp();
    app = context.app;
    prisma = context.prisma;
    storage = app.get<ObjectStorage>(OBJECT_STORAGE);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    ({ salonA } = await seedTwoTenants(prisma));

    const login = await request(app.getHttpServer())
      .post(api('/auth/login'))
      .send({ email: salonA.ownerEmail, password: TEST_PASSWORD })
      .expect(200);

    token = login.body.data.accessToken as string;
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => app.getHttpServer();
  const inspect = <T>(work: () => Promise<T>): Promise<T> => QueryScopeStore.crossTenant(work);
  const photosUrl = () => api(`/clients/${salonA.clientId}/photos`);

  const upload = (content: Buffer, filename = 'foto.jpg', fields: Record<string, string> = {}) => {
    const req = request(server()).post(photosUrl()).set(auth()).field('consentGivenAt', CONSENT);

    for (const [key, value] of Object.entries(fields)) req.field(key, value);

    return req.attach('file', content, filename);
  };

  const storageKeyOf = async (photoId: string): Promise<string> => {
    const row = await inspect(() =>
      prisma.client.clientPhoto.findFirst({ where: { id: photoId } }),
    );
    return row!.storageKey;
  };

  // =========================================================================

  describe('subida', () => {
    it('guarda el objeto en el almacén y devuelve la ficha', async () => {
      const response = await upload(jpegBytes).expect(201);

      expect(response.body.data).toMatchObject({
        clientId: salonA.clientId,
        mimeType: 'image/jpeg',
        sizeBytes: jpegBytes.length,
        kind: 'OTHER',
        deduplicated: false,
      });

      // El objeto está donde dice estar.
      await expect(storage.exists(await storageKeyOf(response.body.data.id))).resolves.toBe(true);
    });

    it('no expone la ruta interna del almacén', async () => {
      // Al cliente no le sirve de nada y revela cómo está organizado el almacén; lo que
      // necesita es la URL firmada, que caduca sola.
      const response = await upload(jpegBytes).expect(201);

      expect(response.body.data).not.toHaveProperty('storageKey');
    });

    it('deduce el tipo del contenido, no de lo que declare el cliente', async () => {
      // Se sube un PNG con nombre y extensión de JPEG. Manda el contenido.
      const response = await upload(pngBytes(1920, 1080), 'mentira.jpg').expect(201);

      expect(response.body.data.mimeType).toBe('image/png');
      expect(await storageKeyOf(response.body.data.id)).toMatch(/\.png$/);
    });

    it('lee las dimensiones de la cabecera', async () => {
      const response = await upload(pngBytes(1920, 1080)).expect(201);

      expect(response.body.data).toMatchObject({ width: 1920, height: 1080 });
    });

    it('guarda el fichero bajo el prefijo de su salón', async () => {
      // Permite dar permisos por prefijo en el almacén y borrar de un salón sin tocar otro.
      const response = await upload(jpegBytes).expect(201);
      const key = await storageKeyOf(response.body.data.id);

      expect(key.startsWith(`tenants/${salonA.tenantId}/clients/${salonA.clientId}/`)).toBe(true);
    });

    it('no deja que el nombre del fichero influya en la ruta', async () => {
      // Un nombre como `../../otro-salon/foto.jpg` escaparía del prefijo del inquilino.
      const response = await upload(jpegBytes, '../../otro-salon/robada.jpg').expect(201);
      const key = await storageKeyOf(response.body.data.id);

      expect(key).not.toContain('..');
      expect(key.startsWith(`tenants/${salonA.tenantId}/`)).toBe(true);
    });

    describe('lo que rechaza', () => {
      it('rechaza un HTML disfrazado de JPEG', async () => {
        // Es el ataque que justifica leer los bytes. Aceptarlo y servirlo después sería
        // ejecución de código en el dominio que sirve las fotos.
        const html = Buffer.from('<html><script>alert(document.cookie)</script></html>', 'utf8');

        const response = await upload(html, 'foto.jpg').expect(422);

        expect(response.body.detail).toMatch(/no es una imagen reconocible/i);
      });

      it('rechaza un SVG, que es imagen y admite scripts', async () => {
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'utf8');

        await upload(svg, 'vector.svg').expect(422);
      });

      it('rechaza la subida sin consentimiento', async () => {
        const response = await request(server())
          .post(photosUrl())
          .set(auth())
          .attach('file', jpegBytes, 'foto.jpg')
          .expect(400);

        expect(JSON.stringify(response.body)).toMatch(/consentGivenAt/);
      });

      it('rechaza la petición sin fichero', async () => {
        await request(server())
          .post(photosUrl())
          .set(auth())
          .field('consentGivenAt', CONSENT)
          .expect(422);
      });

      it('rechaza subir a una clienta que no existe', async () => {
        await request(server())
          .post(api('/clients/11111111-1111-7111-8111-999999999999/photos'))
          .set(auth())
          .field('consentGivenAt', CONSENT)
          .attach('file', jpegBytes, 'foto.jpg')
          .expect(404);
      });
    });

    it('no duplica el fichero al subir dos veces la misma foto', async () => {
      // Es corriente: la encargada no recuerda si ya lo hizo. Guardarla dos veces gasta
      // espacio y deja dos entradas idénticas que nadie sabe cuál borrar.
      const first = await upload(jpegBytes).expect(201);
      const second = await upload(jpegBytes).expect(201);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(second.body.data.deduplicated).toBe(true);

      const count = await inspect(() =>
        prisma.client.clientPhoto.count({ where: { clientId: salonA.clientId } }),
      );
      expect(count).toBe(1);
    });

    it('guarda la huella SHA-256 del contenido', async () => {
      const response = await upload(jpegBytes).expect(201);

      const row = await inspect(() =>
        prisma.client.clientPhoto.findFirst({ where: { id: response.body.data.id } }),
      );

      expect(row!.checksum).toBe(createHash('sha256').update(jpegBytes).digest('hex'));
    });
  });

  // =========================================================================

  describe('galería', () => {
    it('devuelve las fotos con una URL firmada que funciona', async () => {
      await upload(jpegBytes).expect(201);

      const response = await request(server()).get(photosUrl()).set(auth()).expect(200);
      const photo = response.body.data[0];

      expect(photo.url).toMatch(/^https?:\/\//);
      expect(new Date(photo.urlExpiresAt).getTime()).toBeGreaterThan(Date.now());

      // La URL firmada devuelve el fichero: es la prueba de que la firma es válida y de que
      // el objeto está donde la fila dice.
      const fetched = await fetch(photo.url as string);
      expect(fetched.status).toBe(200);
      expect(Buffer.from(await fetched.arrayBuffer())).toEqual(jpegBytes);
    });

    it('sirve el fichero como descarga y con el tipo verificado', async () => {
      // Segunda capa sobre la comprobación de bytes: aunque algo se colara, el navegador no
      // lo interpretaría.
      await upload(jpegBytes).expect(201);

      const response = await request(server()).get(photosUrl()).set(auth()).expect(200);
      const fetched = await fetch(response.body.data[0].url as string);

      expect(fetched.headers.get('content-type')).toBe('image/jpeg');
      expect(fetched.headers.get('content-disposition')).toMatch(/^attachment/);
    });

    it('el objeto no es accesible sin firma', async () => {
      // El bucket no es público: las rutas no son secretas y adivinarlas no debe bastar.
      const created = await upload(jpegBytes).expect(201);
      const key = await storageKeyOf(created.body.data.id);

      const direct = await fetch(`http://localhost:9000/salon-media-test/${key}`);

      expect(direct.status).toBeGreaterThanOrEqual(400);
    });

    it('filtra por tipo de foto', async () => {
      await upload(jpegBytes, 'antes.jpg', { kind: 'BEFORE' }).expect(201);
      await upload(pngBytes(10, 10), 'despues.png', { kind: 'AFTER' }).expect(201);

      const response = await request(server())
        .get(photosUrl())
        .query({ kind: 'AFTER' })
        .set(auth())
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].kind).toBe('AFTER');
    });

    it('no muestra las fotos de la clienta de otro salón', async () => {
      await upload(jpegBytes).expect(201);

      const otherLogin = await request(server())
        .post(api('/auth/login'))
        .send({ email: 'owner@salon-b.test', password: TEST_PASSWORD })
        .expect(200);

      // La clienta pertenece al salón A: para el B ni siquiera existe.
      await request(server())
        .get(photosUrl())
        .set({ Authorization: `Bearer ${otherLogin.body.data.accessToken}` })
        .expect(200)
        .expect((res) => expect(res.body.data).toHaveLength(0));
    });
  });

  // =========================================================================

  describe('consentimiento y descripción', () => {
    it('registra el consentimiento y deja distinguir guardar de publicar', async () => {
      const response = await upload(jpegBytes, 'foto.jpg', { allowsMarketing: 'false' }).expect(
        201,
      );

      expect(response.body.data.consent.source).toBe('IN_PERSON');
      expect(response.body.data.isPublishable).toBe(false);
    });

    it('permite conceder y retirar el permiso de publicación', async () => {
      // Un consentimiento es revocable por definición.
      const created = await upload(jpegBytes).expect(201);
      const url = `${photosUrl()}/${created.body.data.id}`;

      const concedido = await request(server())
        .patch(url)
        .set(auth())
        .send({ allowsMarketing: true })
        .expect(200);
      expect(concedido.body.data.isPublishable).toBe(true);

      const retirado = await request(server())
        .patch(url)
        .set(auth())
        .send({ allowsMarketing: false })
        .expect(200);
      expect(retirado.body.data.isPublishable).toBe(false);
    });

    it('vincula la foto a una cita después de subirla', async () => {
      const created = await upload(jpegBytes).expect(201);
      const appointmentId = await inspect(async () => {
        const row = await prisma.client.appointment.findFirst({
          where: { tenantId: salonA.tenantId },
        });
        return row?.id ?? null;
      });

      if (!appointmentId) return;

      const response = await request(server())
        .patch(`${photosUrl()}/${created.body.data.id}`)
        .set(auth())
        .send({ kind: 'AFTER', appointmentId, caption: 'Resultado' })
        .expect(200);

      expect(response.body.data).toMatchObject({
        kind: 'AFTER',
        appointmentId,
        caption: 'Resultado',
      });
    });
  });

  // =========================================================================

  describe('baja y purga', () => {
    it('la baja oculta la foto pero conserva el fichero', async () => {
      const created = await upload(jpegBytes).expect(201);
      const key = await storageKeyOf(created.body.data.id);

      await request(server())
        .delete(`${photosUrl()}/${created.body.data.id}`)
        .set(auth())
        .expect(204);

      await request(server())
        .get(photosUrl())
        .set(auth())
        .expect(200)
        .expect((res) => expect(res.body.data).toHaveLength(0));

      // El fichero sigue: una baja por error tiene que poder deshacerse.
      await expect(storage.exists(key)).resolves.toBe(true);
    });

    it('la purga borra el fichero de verdad', async () => {
      // Es lo que convierte «ya no se ve» en «ya no existe». Sin esto, el derecho de
      // supresión quedaría a medias.
      const created = await upload(jpegBytes).expect(201);
      const photoId = created.body.data.id as string;
      const key = await storageKeyOf(photoId);

      await request(server()).delete(`${photosUrl()}/${photoId}`).set(auth()).expect(204);

      const response = await request(server())
        .post(api('/photos/purge'))
        .set(auth())
        // Cero días: en el test no se espera un mes a que caduque la ventana de gracia.
        .send({ olderThanDays: 0 })
        .expect(201);

      expect(response.body.data.purged).toBe(1);
      await expect(storage.exists(key)).resolves.toBe(false);

      // La fila sigue existiendo y ahora dice cuando se borro el fichero. Hay que pedirla
      // entre las borradas: para una consulta normal ya no existe, que es justo lo que se
      // quiere de una foto dada de baja.
      const row = await inspect(() =>
        QueryScopeStore.includingDeleted(async () =>
          prisma.client.clientPhoto.findFirst({ where: { id: photoId } }),
        ),
      );
      expect(row!.purgedAt).not.toBeNull();
    });

    it('no purga lo que sigue activo', async () => {
      const created = await upload(jpegBytes).expect(201);
      const key = await storageKeyOf(created.body.data.id);

      const response = await request(server())
        .post(api('/photos/purge'))
        .set(auth())
        .send({ olderThanDays: 0 })
        .expect(201);

      expect(response.body.data.purged).toBe(0);
      await expect(storage.exists(key)).resolves.toBe(true);
    });

    it('respeta la ventana de gracia antes de borrar', async () => {
      const created = await upload(jpegBytes).expect(201);
      await request(server())
        .delete(`${photosUrl()}/${created.body.data.id}`)
        .set(auth())
        .expect(204);

      const response = await request(server())
        .post(api('/photos/purge'))
        .set(auth())
        .send({ olderThanDays: 30 })
        .expect(201);

      expect(response.body.data.purged).toBe(0);
    });
  });

  // =========================================================================

  describe('la restricción de una foto por objeto la impone PostgreSQL', () => {
    it('rechaza dos filas activas apuntando al mismo fichero', async () => {
      // Borrar una dejaría a la otra sirviendo un objeto que ya no existe.
      const created = await upload(jpegBytes).expect(201);
      const key = await storageKeyOf(created.body.data.id);

      await expect(
        inspect(() =>
          prisma.client.$executeRawUnsafe(
            `INSERT INTO "client_photos"
               ("id","tenantId","clientId","storageKey","mimeType","sizeBytes","checksum",
                "consentGivenAt","createdAt","updatedAt")
             VALUES (gen_random_uuid(), $1, $2, $3, 'image/jpeg', 100, repeat('b', 64),
                     now(), now(), now())`,
            salonA.tenantId,
            salonA.clientId,
            key,
          ),
        ),
      ).rejects.toThrow();
    });
  });
});
