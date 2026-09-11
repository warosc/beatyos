import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import type { Env } from '../config/env.schema';

/**
 * Contrato OpenAPI (ADR-0007).
 *
 * Se genera **del código**, no a mano: un documento escrito aparte empieza siendo
 * correcto y termina, sin excepción, describiendo una API que ya no existe. Aquí, si un
 * endpoint cambia de forma, el contrato cambia con él.
 */
export function setupOpenApi(app: INestApplication, config: ConfigService<Env, true>): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('AppSalonBelleza API')
      .setDescription(
        [
          'API de gestión integral para salones de belleza.',
          '',
          '## Autenticación',
          '',
          'Todos los endpoints exigen `Authorization: Bearer <access token>` salvo los',
          'marcados como públicos. El access token caduca a los **15 minutos**; use',
          '`POST /api/v1/auth/refresh` para renovarlo.',
          '',
          'El refresh token **se rota en cada uso**: el que envía deja de ser válido y',
          'recibe uno nuevo. Guarde siempre el último. Reutilizar uno ya rotado se',
          'interpreta como robo de credenciales y cierra todas las sesiones de esa cadena.',
          '',
          '## Formato de respuesta',
          '',
          'Todas las respuestas van envueltas en `data`. Las colecciones añaden `meta`',
          'con la paginación:',
          '',
          '```json',
          '{ "data": [ ... ], "meta": { "page": 1, "limit": 20, "total": 137,',
          '  "totalPages": 7, "hasNext": true, "hasPrevious": false } }',
          '```',
          '',
          '## Importes monetarios',
          '',
          'Los importes viajan como **cadena decimal** (`"1250.00"`), nunca como número.',
          '`JSON.parse` convertiría un número a coma flotante binaria y `0.1 + 0.2` dejaría',
          'de ser `0.3`: en un arqueo de caja, esa diferencia la ve el usuario. Use una',
          'librería decimal en su cliente.',
          '',
          '## Errores',
          '',
          'Formato RFC 9457 (Problem Details). Ramifique siempre sobre `code`, que es',
          'contrato estable, y nunca sobre `title` ni `detail`, que son texto para personas',
          'y pueden traducirse o reescribirse sin previo aviso.',
          '',
          'Cada respuesta lleva un `correlationId`: cítelo al reportar una incidencia y el',
          'equipo localizará la petición exacta en los registros.',
          '',
          '## Paginación, orden y filtros',
          '',
          '`?page=1&limit=20&sort=createdAt:desc,name:asc`. El límite máximo es 100. Los',
          'campos ordenables se validan contra una lista blanca por recurso.',
        ].join('\n'),
      )
      .setVersion('1.0.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Access token obtenido en POST /api/v1/auth/login',
        },
        'bearer',
      )
      .addTag('Autenticación', 'Inicio de sesión, renovación y cierre de sesión')
      .addTag('Salud', 'Sondas de vida y disponibilidad')
      .addServer(`http://localhost:${config.get('PORT', { infer: true })}`, 'Desarrollo local')
      .build(),
    {
      // Nombres de operación estables: son los que acaban dando nombre a los métodos de
      // los SDK generados, y cambiarlos rompe a los clientes tanto como cambiar una ruta.
      operationIdFactory: (controllerKey, methodKey) =>
        `${controllerKey.replace(/Controller$/, '')}_${methodKey}`,
    },
  );

  SwaggerModule.setup(config.get('SWAGGER_PATH', { infer: true }), app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      docExpansion: 'none',
    },
    customSiteTitle: 'AppSalonBelleza API',
  });
}
