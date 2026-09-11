-- Corrige únicamente el catálogo editable de los salones de demostración.
-- Las líneas de facturas y compras históricas conservan el impuesto con el que se emitieron.
UPDATE "services"
SET "taxRate" = 12, "updatedAt" = CURRENT_TIMESTAMP
WHERE "tenantId" IN (
  'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb'
) AND "taxRate" = 21;

UPDATE "products"
SET "taxRate" = 12, "updatedAt" = CURRENT_TIMESTAMP
WHERE "tenantId" IN (
  'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb'
) AND "taxRate" = 21;
