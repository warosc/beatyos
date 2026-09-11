-- ---------------------------------------------------------------------------
-- Metas e incentivos de profesionales
-- ---------------------------------------------------------------------------
--
-- Objetivo de facturacion de una estilista en un periodo concreto, con su recompensa.
-- No es una plantilla recurrente: cada periodo que la owner quiera premiar crea una fila
-- nueva. El progreso no se guarda aqui -se calcula al leer, sumando las lineas de venta
-- del periodo- pero `achievedAt` si se persiste y es de una sola direccion.

CREATE TYPE "GoalMetric" AS ENUM ('SERVICE_REVENUE', 'PRODUCT_REVENUE');

CREATE TABLE "goals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "stylistId" TEXT NOT NULL,
    "metric" "GoalMetric" NOT NULL,
    "targetAmount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'GTQ',
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "periodEnd" TIMESTAMPTZ(3) NOT NULL,
    "rewardDescription" TEXT NOT NULL,
    "achievedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "deletedBy" TEXT,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "goals_tenantId_stylistId_deletedAt_idx" ON "goals"("tenantId", "stylistId", "deletedAt");

ALTER TABLE "goals" ADD CONSTRAINT "goals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "goals" ADD CONSTRAINT "goals_stylistId_fkey" FOREIGN KEY ("stylistId") REFERENCES "stylists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Invariantes
-- ---------------------------------------------------------------------------

-- Un objetivo de cero o negativo no es una meta. La aplicacion ya lo comprueba; esto lo
-- cierra tambien para el SQL directo.
ALTER TABLE "goals"
  ADD CONSTRAINT "goals_target_positive" CHECK ("targetAmount" > 0);

-- El periodo tiene que tener extension real: un fin anterior o igual al inicio no define
-- ninguna ventana de tiempo en la que evaluar el progreso.
ALTER TABLE "goals"
  ADD CONSTRAINT "goals_period_valid" CHECK ("periodEnd" > "periodStart");
