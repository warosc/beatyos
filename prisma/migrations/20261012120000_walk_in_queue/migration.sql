-- ---------------------------------------------------------------------------
-- Fila de espera de clientas sin cita (ADR-0024)
-- ---------------------------------------------------------------------------
--
-- Recepción anota a quien llega sin cita, la profesional la llama cuando queda libre y la
-- pantalla del salón anuncia el turno. Al terminar, el turno se convierte en comanda.
--
-- Todo es aditivo: tablas nuevas y una columna opcional en `tenants`.

-- CreateEnum
CREATE TYPE "QueueTurnStatus" AS ENUM ('WAITING', 'CALLED', 'IN_SERVICE', 'DONE', 'NO_SHOW', 'CANCELLED');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "queueDisplayTokenHash" TEXT;

-- CreateTable
CREATE TABLE "queue_turns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "number" INTEGER NOT NULL,
    "clientId" TEXT,
    "clientName" TEXT NOT NULL,
    "serviceIds" TEXT[],
    "preferredStylistId" TEXT,
    "stylistId" TEXT,
    "status" "QueueTurnStatus" NOT NULL DEFAULT 'WAITING',
    "notes" TEXT,
    "callCount" INTEGER NOT NULL DEFAULT 0,
    "calledAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "serviceTicketId" TEXT,
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "queue_turns_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "queue_turns_number_ck" CHECK ("number" > 0),
    CONSTRAINT "queue_turns_call_count_ck" CHECK ("callCount" >= 0),
    -- Llamada, en el sillón o atendida: siempre se sabe con quién.
    CONSTRAINT "queue_turns_stylist_ck"
      CHECK ("status" IN ('WAITING', 'NO_SHOW', 'CANCELLED') OR "stylistId" IS NOT NULL),
    -- Atendida es lo mismo que «tiene comanda»: caja no se queda sin enterarse.
    CONSTRAINT "queue_turns_done_ck"
      CHECK ("status" <> 'DONE' OR "serviceTicketId" IS NOT NULL),
    -- Fuera de la fila siempre dice cuándo salió; dentro, nunca.
    CONSTRAINT "queue_turns_closed_ck"
      CHECK (("status" IN ('DONE', 'NO_SHOW', 'CANCELLED')) = ("closedAt" IS NOT NULL))
);

-- CreateTable
CREATE TABLE "queue_day_counters" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "queue_day_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "queue_turns_serviceTicketId_key" ON "queue_turns"("serviceTicketId");

-- CreateIndex
CREATE INDEX "queue_turns_tenantId_businessDate_status_idx" ON "queue_turns"("tenantId", "businessDate", "status");

-- CreateIndex
CREATE INDEX "queue_turns_tenantId_stylistId_status_idx" ON "queue_turns"("tenantId", "stylistId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "queue_turns_tenantId_businessDate_number_key" ON "queue_turns"("tenantId", "businessDate", "number");

-- Una profesional atiende a una clienta cada vez. Dos «llamar siguiente» seguidos —un
-- doble toque, dos pestañas— no pueden dejarle dos clientas llamadas: el segundo choca aquí.
CREATE UNIQUE INDEX "queue_turns_one_active_per_stylist"
  ON "queue_turns"("stylistId")
  WHERE "status" IN ('CALLED', 'IN_SERVICE');

-- CreateIndex
CREATE UNIQUE INDEX "queue_day_counters_tenantId_businessDate_key" ON "queue_day_counters"("tenantId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_queueDisplayTokenHash_key" ON "tenants"("queueDisplayTokenHash");

-- AddForeignKey
ALTER TABLE "queue_turns" ADD CONSTRAINT "queue_turns_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_turns" ADD CONSTRAINT "queue_turns_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_turns" ADD CONSTRAINT "queue_turns_preferredStylistId_fkey" FOREIGN KEY ("preferredStylistId") REFERENCES "stylists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_turns" ADD CONSTRAINT "queue_turns_stylistId_fkey" FOREIGN KEY ("stylistId") REFERENCES "stylists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_turns" ADD CONSTRAINT "queue_turns_serviceTicketId_fkey" FOREIGN KEY ("serviceTicketId") REFERENCES "service_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_day_counters" ADD CONSTRAINT "queue_day_counters_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
