-- Los dos salones incluidos por el seed son datos de demostración, no registros
-- contables reales. Normalizamos su catálogo activo creado antes del cambio a Guatemala.
UPDATE "services"
SET "currency" = 'GTQ'
WHERE "tenantId" IN (
  'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb'
) AND "currency" <> 'GTQ';

UPDATE "products"
SET "currency" = 'GTQ'
WHERE "tenantId" IN (
  'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb'
) AND "currency" <> 'GTQ';
