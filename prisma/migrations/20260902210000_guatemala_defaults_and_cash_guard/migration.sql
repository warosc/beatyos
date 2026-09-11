-- Guatemala is the default operating market. Historical amounts are intentionally
-- not converted: changing their currency label without an exchange operation would
-- corrupt accounting history.
ALTER TABLE "tenants" ALTER COLUMN "country" SET DEFAULT 'GT';
ALTER TABLE "tenants" ALTER COLUMN "timezone" SET DEFAULT 'America/Guatemala';
ALTER TABLE "tenants" ALTER COLUMN "currency" SET DEFAULT 'GTQ';
ALTER TABLE "tenants" ALTER COLUMN "locale" SET DEFAULT 'es-GT';
ALTER TABLE "users" ALTER COLUMN "locale" SET DEFAULT 'es-GT';
ALTER TABLE "suppliers" ALTER COLUMN "country" SET DEFAULT 'GT';

ALTER TABLE "services" ALTER COLUMN "currency" SET DEFAULT 'GTQ';
ALTER TABLE "products" ALTER COLUMN "currency" SET DEFAULT 'GTQ';
ALTER TABLE "appointments" ALTER COLUMN "currency" SET DEFAULT 'GTQ';
ALTER TABLE "appointment_services" ALTER COLUMN "currency" SET DEFAULT 'GTQ';
ALTER TABLE "supplier_products" ALTER COLUMN "currency" SET DEFAULT 'GTQ';
ALTER TABLE "purchase_orders" ALTER COLUMN "currency" SET DEFAULT 'GTQ';
ALTER TABLE "purchase_order_lines" ALTER COLUMN "currency" SET DEFAULT 'GTQ';
ALTER TABLE "inventory_movements" ALTER COLUMN "currency" SET DEFAULT 'GTQ';
ALTER TABLE "product_batches" ALTER COLUMN "currency" SET DEFAULT 'GTQ';
ALTER TABLE "invoices" ALTER COLUMN "currency" SET DEFAULT 'GTQ';
ALTER TABLE "invoice_lines" ALTER COLUMN "currency" SET DEFAULT 'GTQ';
ALTER TABLE "payments" ALTER COLUMN "currency" SET DEFAULT 'GTQ';
ALTER TABLE "cash_sessions" ALTER COLUMN "currency" SET DEFAULT 'GTQ';
ALTER TABLE "cash_movements" ALTER COLUMN "currency" SET DEFAULT 'GTQ';

-- A tenant may never have two simultaneously open tills, including under races.
CREATE UNIQUE INDEX "cash_sessions_one_open_per_tenant"
ON "cash_sessions" ("tenantId")
WHERE "status" = 'OPEN' AND "deletedAt" IS NULL;
