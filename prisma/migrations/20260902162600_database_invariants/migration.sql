-- ---------------------------------------------------------------------------
-- Invariantes que Prisma no sabe expresar en su DSL.
--
-- Todo lo de aqui existe porque la aplicacion NO PUEDE garantizarlo por si sola:
-- bajo peticiones concurrentes, la comprobacion "leer, validar, escribir" del codigo
-- tiene siempre una ventana de carrera. La base de datos es el unico punto donde una
-- invariante puede ser realmente inviolable.
--
-- El dominio sigue comprobando las mismas reglas: no por redundancia, sino porque
-- produce un mensaje de error util. La base de datos produce garantia; el dominio
-- produce explicacion. Se necesitan las dos.
-- ---------------------------------------------------------------------------

-- btree_gist permite combinar igualdad (=) sobre texto con solapamiento (&&) sobre
-- rangos dentro de una misma restriccion EXCLUDE.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ===========================================================================
-- 1. UNICIDADES PARCIALES  (ADR-0004)
--
-- Un @@unique normal impediria reutilizar el email de un cliente borrado. Con
-- indice parcial, la unicidad solo aplica a las filas vivas.
-- `lower()` hace la unicidad insensible a mayusculas: el dominio ya normaliza,
-- pero esto protege tambien frente a escrituras por SQL directo.
-- COALESCE sobre tenantId: los usuarios y roles de plataforma tienen tenantId NULL,
-- y en SQL NULL <> NULL, asi que sin el centinela no habria unicidad entre ellos.
-- ===========================================================================

CREATE UNIQUE INDEX "users_tenant_email_uq"
  ON "users" (COALESCE("tenantId", '00000000-0000-0000-0000-000000000000'), lower("email"))
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "roles_tenant_code_uq"
  ON "roles" (COALESCE("tenantId", '00000000-0000-0000-0000-000000000000'), "code")
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "clients_tenant_email_uq"
  ON "clients" ("tenantId", lower("email"))
  WHERE "deletedAt" IS NULL AND "email" IS NOT NULL;

CREATE UNIQUE INDEX "stylists_tenant_email_uq"
  ON "stylists" ("tenantId", lower("email"))
  WHERE "deletedAt" IS NULL AND "email" IS NOT NULL;

CREATE UNIQUE INDEX "services_tenant_code_uq"
  ON "services" ("tenantId", "code")
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "products_tenant_sku_uq"
  ON "products" ("tenantId", "sku")
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "products_tenant_barcode_uq"
  ON "products" ("tenantId", "barcode")
  WHERE "deletedAt" IS NULL AND "barcode" IS NOT NULL;

CREATE UNIQUE INDEX "suppliers_tenant_code_uq"
  ON "suppliers" ("tenantId", "code")
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "categories_tenant_kind_slug_uq"
  ON "categories" ("tenantId", "kind", "slug")
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "invoices_tenant_number_uq"
  ON "invoices" ("tenantId", "number")
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "purchase_orders_tenant_number_uq"
  ON "purchase_orders" ("tenantId", "number")
  WHERE "deletedAt" IS NULL;

-- v1 asume una sola caja fisica por salon: como mucho una sesion abierta a la vez.
-- Si el producto pasa a soportar varios puestos de cobro, esto se sustituye por
-- (tenantId, registerId) y deja de ser una restriccion de tenant.
CREATE UNIQUE INDEX "cash_sessions_one_open_per_tenant_uq"
  ON "cash_sessions" ("tenantId")
  WHERE "status" = 'OPEN' AND "deletedAt" IS NULL;

-- ===========================================================================
-- 2. SOLAPAMIENTO DE AGENDA  (ADR-0011 / modulo de citas)
--
-- La razon de ser de esta restriccion: dos recepcionistas que reservan a la vez el
-- mismo hueco pasan ambas la validacion del dominio (ninguna ve la cita de la otra
-- porque aun no esta confirmada) y producen una doble reserva. Ningun `SELECT`
-- previo lo evita. Un EXCLUDE si.
--
-- El rango es semiabierto '[)': una cita de 10:00-11:00 y otra de 11:00-12:00 NO
-- se solapan, que es justo lo que espera el usuario.
--
-- Solo aplica a estados que ocupan sillon de verdad: una cita cancelada o marcada
-- como no presentada libera el hueco.
-- ===========================================================================

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_no_overlap_per_stylist"
  EXCLUDE USING gist (
    "tenantId" WITH =,
    "stylistId" WITH =,
    tstzrange("startsAt", "endsAt", '[)') WITH &&
  )
  WHERE ("deletedAt" IS NULL AND "status" IN ('SCHEDULED', 'CONFIRMED', 'IN_PROGRESS'));

-- ===========================================================================
-- 3. INVARIANTES DE VALOR (CHECK)
--
-- Se declaran NOT VALID + VALIDATE por costumbre operativa: en una tabla grande
-- el ALTER no bloquea escrituras durante la validacion. Aqui las tablas estan
-- vacias, pero el patron queda establecido para futuras migraciones.
-- ===========================================================================

-- Intervalos temporales bien formados
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_period_valid" CHECK ("endsAt" > "startsAt");

ALTER TABLE "stylist_time_off"
  ADD CONSTRAINT "stylist_time_off_period_valid" CHECK ("endsAt" > "startsAt");

ALTER TABLE "stylist_schedules"
  ADD CONSTRAINT "stylist_schedules_valid" CHECK (
    "dayOfWeek" BETWEEN 0 AND 6
    AND "startMinutes" >= 0
    AND "endMinutes" <= 1440
    AND "endMinutes" > "startMinutes"
  );

-- Un movimiento de stock de cantidad cero no significa nada y ensucia el ledger.
ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_delta_not_zero" CHECK ("quantityDelta" <> 0);

-- El stock negativo nunca es un estado valido. Esta es la garantia real detras del
-- `UPDATE ... WHERE stockOnHand >= :cantidad` del ADR-0011: si dos ventas concurrentes
-- se cuelan, la segunda revienta aqui en vez de dejar existencias imposibles.
ALTER TABLE "products"
  ADD CONSTRAINT "products_stock_not_negative" CHECK ("stockOnHand" >= 0);

-- Una linea de factura de servicio referencia un servicio; una de producto, un producto.
-- Sin esto, nada impide una linea PRODUCT apuntando a un servicio.
ALTER TABLE "invoice_lines"
  ADD CONSTRAINT "invoice_lines_reference_matches_kind" CHECK (
    ("kind" = 'SERVICE' AND "serviceId" IS NOT NULL AND "productId" IS NULL)
    OR ("kind" = 'PRODUCT' AND "productId" IS NOT NULL AND "serviceId" IS NULL)
    OR ("kind" IN ('DISCOUNT', 'OTHER') AND "serviceId" IS NULL AND "productId" IS NULL)
  );

ALTER TABLE "invoice_lines"
  ADD CONSTRAINT "invoice_lines_amounts_valid" CHECK (
    "quantity" > 0
    AND "unitPrice" >= 0
    AND "discountAmount" >= 0
    AND "taxRate" BETWEEN 0 AND 100
  );

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_amounts_valid" CHECK (
    "subtotal" >= 0 AND "taxTotal" >= 0 AND "total" >= 0
    AND "discountTotal" >= 0 AND "paidTotal" >= 0
  );

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_refund_within_amount" CHECK (
    "refundedAmount" >= 0 AND "refundedAmount" <= "amount"
  );

ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT "po_lines_quantities_valid" CHECK (
    "quantity" > 0
    AND "receivedQuantity" >= 0
    AND "receivedQuantity" <= "quantity"
    AND "unitCost" >= 0
  );

ALTER TABLE "cash_sessions"
  ADD CONSTRAINT "cash_sessions_float_not_negative" CHECK ("openingFloat" >= 0);

ALTER TABLE "cash_movements"
  ADD CONSTRAINT "cash_movements_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "services"
  ADD CONSTRAINT "services_values_valid" CHECK (
    "durationMinutes" > 0
    AND "bufferMinutes" >= 0
    AND "price" >= 0
    AND "taxRate" BETWEEN 0 AND 100
    AND ("commissionRate" IS NULL OR "commissionRate" BETWEEN 0 AND 100)
  );

ALTER TABLE "products"
  ADD CONSTRAINT "products_values_valid" CHECK (
    "price" >= 0 AND "costPrice" >= 0 AND "taxRate" BETWEEN 0 AND 100
  );

ALTER TABLE "stylists"
  ADD CONSTRAINT "stylists_commission_valid" CHECK ("commissionRate" BETWEEN 0 AND 100);

ALTER TABLE "service_consumables"
  ADD CONSTRAINT "service_consumables_quantity_positive" CHECK ("quantity" > 0);

-- ===========================================================================
-- 4. INMUTABILIDAD DEL LEDGER  (ADR-0004 y ADR-0011)
--
-- "Append-only" escrito en un documento es una intencion. Escrito como trigger es
-- una garantia: ni un caso de uso mal escrito, ni una consola de psql abierta a las
-- tres de la manana, pueden reescribir la auditoria ni el historico de inventario.
--
-- TRUNCATE no dispara triggers de fila, de modo que la limpieza entre tests de
-- integracion sigue funcionando.
-- ===========================================================================

CREATE OR REPLACE FUNCTION reject_mutation_on_append_only_table()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'La tabla % es append-only: % no esta permitido. Corrija con un asiento compensatorio.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_on_append_only_table();

CREATE TRIGGER "inventory_movements_append_only"
  BEFORE UPDATE OR DELETE ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_on_append_only_table();

-- ===========================================================================
-- 5. INDICES DE APOYO A CONSULTAS FRECUENTES
--
-- Todos empiezan por tenantId: sin eso el planificador escanearia filas de otros
-- salones antes de descartarlas (ADR-0003).
-- ===========================================================================

-- Busqueda de clientes por nombre en la caja: trigrama para tolerar el tecleo parcial.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "clients_name_trgm_idx"
  ON "clients" USING gin ((lower("firstName" || ' ' || "lastName")) gin_trgm_ops)
  WHERE "deletedAt" IS NULL;

CREATE INDEX "products_name_trgm_idx"
  ON "products" USING gin (lower("name") gin_trgm_ops)
  WHERE "deletedAt" IS NULL;

-- Vista de agenda del dia: el filtro parcial mantiene el indice pequeno y caliente.
CREATE INDEX "appointments_active_calendar_idx"
  ON "appointments" ("tenantId", "startsAt", "stylistId")
  WHERE "deletedAt" IS NULL AND "status" IN ('SCHEDULED', 'CONFIRMED', 'IN_PROGRESS');

-- Facturas pendientes de cobro.
CREATE INDEX "invoices_outstanding_idx"
  ON "invoices" ("tenantId", "dueAt")
  WHERE "deletedAt" IS NULL AND "balanceDue" > 0;

-- Productos bajo minimo, para el panel de reposicion.
CREATE INDEX "products_below_reorder_idx"
  ON "products" ("tenantId", "stockOnHand")
  WHERE "deletedAt" IS NULL AND "trackStock" = true AND "isActive" = true;
