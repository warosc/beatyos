-- AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN     "batchId" TEXT;

-- CreateTable
CREATE TABLE "product_batches" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "expiresAt" DATE,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "initialQuantity" DECIMAL(12,3) NOT NULL,
    "remainingQuantity" DECIMAL(12,3) NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'EUR',
    "supplierId" TEXT,
    "purchaseOrderId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "deletedBy" TEXT,

    CONSTRAINT "product_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_batches_tenantId_productId_expiresAt_idx" ON "product_batches"("tenantId", "productId", "expiresAt");

-- CreateIndex
CREATE INDEX "product_batches_tenantId_expiresAt_idx" ON "product_batches"("tenantId", "expiresAt");

-- CreateIndex
CREATE INDEX "product_batches_tenantId_productId_deletedAt_idx" ON "product_batches"("tenantId", "productId", "deletedAt");

-- CreateIndex
CREATE INDEX "inventory_movements_tenantId_batchId_idx" ON "inventory_movements"("tenantId", "batchId");

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "product_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_batches" ADD CONSTRAINT "product_batches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_batches" ADD CONSTRAINT "product_batches_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Invariantes del lote (ADR-0012).
--
-- El mismo razonamiento que en la migracion de invariantes: bajo peticiones
-- concurrentes, «leer, comprobar, escribir» siempre tiene una ventana de carrera, y solo
-- la base de datos puede cerrarla. Dos consumos simultaneos del mismo lote pasan ambos la
-- comprobacion del dominio; el segundo revienta aqui en lugar de dejar cantidades
-- imposibles.
-- ---------------------------------------------------------------------------

ALTER TABLE "product_batches"
  ADD CONSTRAINT "product_batches_quantities_valid" CHECK (
    "initialQuantity" > 0
    AND "remainingQuantity" >= 0
    -- No se puede consumir mas de lo que entro, ni «devolver» al lote mas de lo recibido.
    AND "remainingQuantity" <= "initialQuantity"
    AND "unitCost" >= 0
  );

-- El numero de lote es unico por producto: es el que figura en el envase y en una
-- reclamacion, y dos filas con el mismo numero harian imposible responder de cual salio.
-- Parcial, como el resto: un lote dado de baja libera su numero.
CREATE UNIQUE INDEX "product_batches_number_uq"
  ON "product_batches" ("tenantId", "productId", "batchNumber")
  WHERE "deletedAt" IS NULL;

-- Indice de consumo FEFO.
--
-- Solo indexa los lotes con existencias: en cuanto el salon lleva unos meses, la mayoria
-- estan agotados y no tiene sentido pasearlos en cada consulta. `NULLS LAST` coloca al
-- final los lotes sin caducidad, que es justo el orden de consumo que se quiere —primero
-- lo que vence, y lo que no caduca al final.
CREATE INDEX "product_batches_fefo_idx"
  ON "product_batches" ("tenantId", "productId", "expiresAt" ASC NULLS LAST, "receivedAt" ASC)
  WHERE "deletedAt" IS NULL AND "remainingQuantity" > 0;

-- Lotes proximos a caducar, para el panel de avisos.
CREATE INDEX "product_batches_expiring_idx"
  ON "product_batches" ("tenantId", "expiresAt")
  WHERE "deletedAt" IS NULL AND "remainingQuantity" > 0 AND "expiresAt" IS NOT NULL;

-- Un movimiento de un producto con lote debe indicar el lote. No se puede expresar como
-- CHECK porque `tracksBatches` vive en otra tabla; queda como responsabilidad del dominio
-- y verificado por los tests de integracion.
