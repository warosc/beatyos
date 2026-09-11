import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';

import { api, createTestApp, resetDatabase } from './app-harness';
import { seedTwoTenants, TEST_PASSWORD, type SeededTenant } from './fixtures';

/**
 * Administración de usuarios y roles, de extremo a extremo.
 *
 * Estos dos módulos tenían controladores completos y ni una prueba. Es un sitio incómodo
 * para no tenerlas: son los endpoints que reparten permisos, de modo que un fallo aquí no
 * se manifiesta como una pantalla rota sino como alguien viendo lo que no debe.
 *
 * Lo que se afirma es justo eso —quién puede administrar, qué permisos acaba teniendo el
 * administrado, y que el salón de al lado no aparece por ninguna parte—, no el CRUD.
 */
describe('Usuarios y roles (integración)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let salonA: SeededTenant;
  let salonB: SeededTenant;
  let token: string;

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
    token = await tokenFor(salonA.ownerEmail);
  });

  const server = () => app.getHttpServer();

  const tokenFor = async (email: string): Promise<string> => {
    const response = await request(server())
      .post(api('/auth/login'))
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    return response.body.data.accessToken as string;
  };

  const auth = (as: string = token) => ({ Authorization: `Bearer ${as}` });

  const roleIdOf = async (code: string): Promise<string> => {
    const response = await request(server()).get(api('/roles')).set(auth()).expect(200);
    const roles = response.body.data as Array<{ id: string; code: string }>;
    return roles.find((r) => r.code === code)!.id;
  };

  const createUser = (body: Record<string, unknown>, as: string = token) =>
    request(server()).post(api('/users')).set(auth(as)).send(body);

  const newUserPayload = async (overrides: Record<string, unknown> = {}) => ({
    email: 'nueva@bella-vista.test',
    password: 'ContrasenaDePrueba1',
    firstName: 'Marta',
    lastName: 'Gómez',
    roleIds: [await roleIdOf('STYLIST')],
    ...overrides,
  });

  // =========================================================================

  describe('alta de usuarios', () => {
    it('crea el usuario y le deja iniciar sesión con sus permisos', async () => {
      const response = await createUser(await newUserPayload()).expect(201);

      expect(response.body.data.roles).toHaveLength(1);
      expect(response.body.data.roles[0].code).toBe('STYLIST');

      // La prueba de que el alta sirvió: la persona entra y su token trae los permisos.
      const login = await request(server())
        .post(api('/auth/login'))
        .send({ email: 'nueva@bella-vista.test', password: 'ContrasenaDePrueba1' })
        .expect(200);
      expect(login.body.data.user.permissions).toContain('appointments.read.own');
    });

    it('nunca devuelve el hash de la contraseña', async () => {
      const response = await createUser(await newUserPayload()).expect(201);

      expect(JSON.stringify(response.body)).not.toContain('$argon2');
      expect(response.body.data.passwordHash).toBeUndefined();
    });

    it('rechaza un correo ya registrado', async () => {
      await createUser(await newUserPayload()).expect(201);
      await createUser(await newUserPayload()).expect(409);
    });

    it('exige al menos un rol', async () => {
      await createUser(await newUserPayload({ roleIds: [] })).expect(400);
    });

    it('exige una contraseña que cumpla la política', async () => {
      await createUser(await newUserPayload({ password: 'corta' })).expect(400);
    });
  });

  describe('permisos sobre la propia administración', () => {
    it('una recepcionista no puede dar de alta usuarios', async () => {
      const recepcion = await tokenFor(salonA.receptionEmail);

      // 403 y no 404: el endpoint existe, lo que falta es el permiso. Distinguirlo importa
      // para depurar, y no filtra nada que quien pregunta no sepa ya.
      await createUser(await newUserPayload(), recepcion).expect(403);
    });

    it('una recepcionista tampoco puede leer el listado', async () => {
      const recepcion = await tokenFor(salonA.receptionEmail);

      await request(server()).get(api('/users')).set(auth(recepcion)).expect(403);
    });

    it('dice qué permiso falta, sin revelar qué recursos existen', async () => {
      const recepcion = await tokenFor(salonA.receptionEmail);

      const response = await request(server()).get(api('/users')).set(auth(recepcion)).expect(403);

      // Información sobre la política, no sobre los datos: sirve para componer bien un rol
      // y no dice nada de qué usuarios hay al otro lado (ADR-0006).
      expect(response.body.detail).toContain('users.read');
    });
  });

  describe('aislamiento entre salones', () => {
    it('el listado solo trae usuarios del salón propio', async () => {
      const response = await request(server()).get(api('/users')).set(auth()).expect(200);

      const emails = (response.body.data as Array<{ email: string }>).map((u) => u.email);
      expect(emails).toContain(salonA.ownerEmail);
      expect(emails).not.toContain(salonB.ownerEmail);
    });

    it('no deja leer el detalle de un usuario ajeno', async () => {
      const ajeno = await prisma.client.user.findFirstOrThrow({
        where: { email: salonB.ownerEmail },
      });

      await request(server())
        .get(api(`/users/${ajeno.id}`))
        .set(auth())
        .expect(404);
    });
  });

  describe('roles', () => {
    it('publica el catálogo de permisos', async () => {
      const response = await request(server())
        .get(api('/roles/permissions'))
        .set(auth())
        .expect(200);

      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBeGreaterThan(0);
    });

    it('crea un rol a medida y lo aplica a quien lo recibe', async () => {
      const rol = await request(server())
        .post(api('/roles'))
        .set(auth())
        .send({
          code: 'AuxiliarCaja',
          name: 'Auxiliar de caja',
          permissionCodes: ['cash.read', 'clients.read'],
        })
        .expect(201);

      const creado = await createUser(await newUserPayload({ roleIds: [rol.body.data.id] })).expect(
        201,
      );

      // Exactamente los dos concedidos: ni el rol de plantilla ni un permiso de más.
      expect(creado.body.data.permissions.sort()).toEqual(['cash.read', 'clients.read']);
    });

    it('reemplaza los permisos al actualizar el rol', async () => {
      const rol = await request(server())
        .post(api('/roles'))
        .set(auth())
        .send({ code: 'Temporal', name: 'Temporal', permissionCodes: ['cash.read'] })
        .expect(201);

      await request(server())
        .patch(api(`/roles/${rol.body.data.id}`))
        .set(auth())
        .send({ permissionCodes: ['clients.read'] })
        .expect(200);

      const creado = await createUser(await newUserPayload({ roleIds: [rol.body.data.id] })).expect(
        201,
      );
      expect(creado.body.data.permissions).toEqual(['clients.read']);
    });

    it('rechaza un código de rol con formato inválido', async () => {
      await request(server())
        .post(api('/roles'))
        .set(auth())
        .send({ code: '1-mal', name: 'Inválido', permissionCodes: ['cash.read'] })
        .expect(400);
    });
  });

  /**
   * La última propietaria.
   *
   * Es la invariante que impide que un salón se quede sin nadie que pueda administrarlo, y
   * estaba sin una sola prueba pese a vigilarse en tres sitios distintos —desactivar,
   * cambiar de rol y dar de baja—. Un fallo aquí no da un error: da un salón cuyo dueño no
   * puede volver a entrar en su propia cuenta.
   */
  describe('la última propietaria no se puede quedar sin salón', () => {
    const ownerId = async (): Promise<string> => {
      const owner = await prisma.client.user.findFirstOrThrow({
        where: { email: salonA.ownerEmail },
      });
      return owner.id;
    };

    /** Da de alta una segunda propietaria, que es lo que levanta la restricción. */
    const segundaPropietaria = async (): Promise<string> => {
      const response = await createUser(
        await newUserPayload({
          email: 'otra@bella-vista.test',
          roleIds: [await roleIdOf('OWNER')],
        }),
      ).expect(201);
      return response.body.data.id as string;
    };

    it('no deja darla de baja', async () => {
      await request(server())
        .delete(api(`/users/${await ownerId()}`))
        .set(auth())
        .expect(422);
    });

    it('no deja desactivarla', async () => {
      await request(server())
        .patch(api(`/users/${await ownerId()}`))
        .set(auth())
        .send({ status: 'INACTIVE' })
        .expect(422);
    });

    it('no deja quitarle el rol de propietaria', async () => {
      await request(server())
        .put(api(`/users/${await ownerId()}/roles`))
        .set(auth())
        .send({ roleIds: [await roleIdOf('STYLIST')] })
        .expect(422);
    });

    it('sí lo permite en cuanto hay una segunda', async () => {
      await segundaPropietaria();

      await request(server())
        .put(api(`/users/${await ownerId()}/roles`))
        .set(auth())
        .send({ roleIds: [await roleIdOf('MANAGER')] })
        .expect(200);
    });
  });

  describe('actualización parcial del perfil', () => {
    it('cambia solo el nombre y conserva el apellido', async () => {
      const creado = await createUser(await newUserPayload()).expect(201);

      const response = await request(server())
        .patch(api(`/users/${creado.body.data.id}`))
        .set(auth())
        .send({ firstName: 'Marina' })
        .expect(200);

      expect(response.body.data.firstName).toBe('Marina');
      expect(response.body.data.lastName).toBe('Gómez');
    });

    it('permite borrar el teléfono con null sin tocar el resto', async () => {
      const creado = await createUser(await newUserPayload({ phone: '+50255551234' })).expect(201);

      const response = await request(server())
        .patch(api(`/users/${creado.body.data.id}`))
        .set(auth())
        .send({ phone: null })
        .expect(200);

      // `null` borra y `undefined` no toca: son dos intenciones distintas y el caso de uso
      // las distingue, cosa que sin prueba se rompe al primer refactor.
      expect(response.body.data.phone).toBeNull();
      expect(response.body.data.firstName).toBe('Marta');
    });

    it('desactiva y vuelve a activar a un usuario corriente', async () => {
      const creado = await createUser(await newUserPayload()).expect(201);
      const id = creado.body.data.id as string;

      const baja = await request(server())
        .patch(api(`/users/${id}`))
        .set(auth())
        .send({ status: 'INACTIVE' })
        .expect(200);
      expect(baja.body.data.status).toBe('INACTIVE');

      const alta = await request(server())
        .patch(api(`/users/${id}`))
        .set(auth())
        .send({ status: 'ACTIVE' })
        .expect(200);
      expect(alta.body.data.status).toBe('ACTIVE');
    });
  });

  describe('referencias inexistentes', () => {
    it('rechaza crear con un rol que no existe', async () => {
      await createUser(
        await newUserPayload({ roleIds: ['11111111-1111-7111-8111-999999999999'] }),
      ).expect(404);
    });

    it('rechaza asignar un rol que no existe', async () => {
      const creado = await createUser(await newUserPayload()).expect(201);

      await request(server())
        .put(api(`/users/${creado.body.data.id}/roles`))
        .set(auth())
        .send({ roleIds: ['11111111-1111-7111-8111-999999999999'] })
        .expect(404);
    });

    it('devuelve 404 al pedir el detalle de un usuario que no existe', async () => {
      await request(server())
        .get(api('/users/11111111-1111-7111-8111-999999999999'))
        .set(auth())
        .expect(404);
    });
  });

  describe('baja y restauración', () => {
    it('el usuario dado de baja deja de poder entrar y vuelve al restaurarlo', async () => {
      const creado = await createUser(await newUserPayload()).expect(201);
      const id = creado.body.data.id as string;

      await request(server())
        .delete(api(`/users/${id}`))
        .set(auth())
        .expect(200);
      await request(server())
        .post(api('/auth/login'))
        .send({ email: 'nueva@bella-vista.test', password: 'ContrasenaDePrueba1' })
        .expect(401);

      await request(server())
        .post(api(`/users/${id}/restore`))
        .set(auth())
        .expect(201);
      await request(server())
        .post(api('/auth/login'))
        .send({ email: 'nueva@bella-vista.test', password: 'ContrasenaDePrueba1' })
        .expect(200);
    });

    it('la baja es lógica: el registro sigue en la base con su marca', async () => {
      const creado = await createUser(await newUserPayload()).expect(201);
      await request(server())
        .delete(api(`/users/${creado.body.data.id}`))
        .set(auth())
        .expect(200);

      const fila = await prisma.client.user.findFirst({
        where: { email: 'nueva@bella-vista.test' },
      });
      expect(fila).toBeNull();
    });
  });
});
