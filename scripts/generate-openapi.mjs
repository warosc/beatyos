import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Generar el contrato no necesita servicios externos, pero AppModule valida la
// configuración al construirse. Estos valores deterministas solo se usan cuando CI no
// aporta los suyos y nunca se escriben en el artefacto.
const defaults = {
  NODE_ENV: 'development',
  PORT: '3000',
  API_PREFIX: 'api',
  DATABASE_URL: 'postgresql://openapi:openapi@localhost:5432/openapi',
  JWT_ACCESS_SECRET: 'openapi_access_contract_secret_0123456789',
  JWT_REFRESH_SECRET: 'openapi_refresh_contract_secret_9876543210',
  SWAGGER_ENABLED: 'true',
};
for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;

const [{ AppModule }, { createOpenApiDocument }] = await Promise.all([
  import('../dist/src/app.module.js'),
  import('../dist/src/shared/infrastructure/http/openapi.js'),
]);

const app = await NestFactory.create(AppModule, { logger: false });
try {
  const config = app.get(ConfigService);
  app.setGlobalPrefix(config.get('API_PREFIX'));
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  const document = createOpenApiDocument(app, config);
  const output = resolve(root, 'docs', 'openapi.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  process.stdout.write(`OpenAPI: ${Object.keys(document.paths).length} rutas -> ${output}\n`);
} finally {
  await app.close();
}
