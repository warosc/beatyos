import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PrismaService } from '@shared/infrastructure/persistence/prisma/prisma.service';

import { api, createTestApp, resetDatabase } from './app-harness';
import { seedTwoTenants, TEST_PASSWORD } from './fixtures';

/**
 * Límites de peticiones (ADR-0007).
 *
 * Vive en su **propio fichero** por una razón práctica: el límite se cuenta por IP y toda
 * la suite sale de la misma, de modo que unos límites realistas estrangularían al resto
 * de tests. En `.env.test` los umbrales son altísimos; aquí se levanta una aplicación
 * aparte con umbrales mínimos, y así el rate limiting se prueba de verdad en lugar de
 * quedar desactivado en toda la suite —que es lo que suele pasar cuando se resuelve
 * subiendo el límite global y nadie vuelve a mirarlo.
 *
 * Se prueban las **dos** defensas contra fuerza bruta, que son distintas y complementarias:
 *
 * - El **bloqueo por cuenta** frena a quien ataca un correo concreto desde muchas IP.
 *   Por sí solo permitiría a cualquiera bloquear la cuenta de otro a voluntad.
 * - El **límite por IP** frena a quien prueba muchos correos distintos desde un sitio.
 *   Por sí solo lo elude un atacante con una botnet.
 */
describe('Rate limiting (integración)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerEmail: string;

  beforeAll(async () => {
    const context = await createTestApp({
      // Se sustituyen las opciones del modulo, no las variables de entorno: `.env.test`
      // tiene prioridad sobre `process.env` en `@nestjs/config`, asi que tocarlas no
      // habria surtido efecto. El resto de ventanas van holgadas para que el 429 que se
      // observe provenga sin ambiguedad de la ventana `auth`.
      throttlers: [
        { name: 'short', ttl: 1000, limit: 10_000 },
        { name: 'medium', ttl: 60_000, limit: 10_000 },
        { name: 'long', ttl: 3_600_000, limit: 10_000 },
        { name: 'auth', ttl: 900_000, limit: 3 },
      ],
    });
    app = context.app;
    prisma = context.prisma;

    await resetDatabase(prisma);
    const { salonA } = await seedTwoTenants(prisma);
    ownerEmail = salonA.ownerEmail;
  });

  afterAll(async () => {
    await app.close();
  });

  it('corta con 429 al superar el límite de intentos de acceso por IP', async () => {
    const attempt = (email: string) =>
      request(app.getHttpServer())
        .post(api('/auth/login'))
        .send({ email, password: 'ContrasenaIncorrecta1' });

    // Tres correos DISTINTOS: el bloqueo por cuenta no vería este patrón, porque ninguna
    // cuenta acumula intentos. Es exactamente el hueco que cubre el límite por IP.
    await attempt('uno@salon-a.test').expect(401);
    await attempt('dos@salon-a.test').expect(401);
    await attempt('tres@salon-a.test').expect(401);

    const blocked = await attempt('cuatro@salon-a.test').expect(429);
    expect(blocked.body.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('el límite alcanza también a las credenciales correctas', async () => {
    // Si el contador solo sumara los fallos, bastaría intercalar accesos correctos para
    // mantenerlo a cero mientras se prueban contraseñas.
    const response = await request(app.getHttpServer())
      .post(api('/auth/login'))
      .send({ email: ownerEmail, password: TEST_PASSWORD });

    expect(response.status).toBe(429);
  });

  it('las sondas de salud quedan exentas', async () => {
    // Llevan @SkipThrottle: si el orquestador recibiera un 429 en la sonda, daría la
    // instancia por caída y la reiniciaría justo cuando está bajo carga —convirtiendo
    // un pico de tráfico en una caída completa.
    for (let i = 0; i < 10; i += 1) {
      await request(app.getHttpServer()).get(api('/health/live')).expect(200);
    }
  });
});
