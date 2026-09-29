-- ---------------------------------------------------------------------------
-- Comandas de servicio (ADR-0019)
-- ---------------------------------------------------------------------------
--
-- La profesional registra los servicios que realizo a una clienta; caja los ve como
-- pendientes y, al cobrarlos, se emite la factura con la logica de ventas de siempre. La
-- comanda no guarda precios: la factura es el documento que los congela.

-- CreateEnum
CREATE TYPE "ServiceTicketStatus" AS ENUM ('PENDING', 'CHARGED', 'CANCELLED');

-- CreateTable
CREATE TABLE "service_tickets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "stylistId" TEXT NOT NULL,
    "clientId" TEXT,
    "clientName" TEXT NOT NULL,
    "appointmentId" TEXT,
    "invoiceId" TEXT,
    "status" "ServiceTicketStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "chargedAt" TIMESTAMPTZ(3),
    "chargedBy" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledBy" TEXT,
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "deletedBy" TEXT,

    CONSTRAINT "service_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_ticket_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_ticket_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_tickets_invoiceId_key" ON "service_tickets"("invoiceId");

-- CreateIndex
CREATE INDEX "service_tickets_tenantId_status_createdAt_idx" ON "service_tickets"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "service_tickets_tenantId_stylistId_createdAt_idx" ON "service_tickets"("tenantId", "stylistId", "createdAt");

-- CreateIndex
CREATE INDEX "service_tickets_appointmentId_idx" ON "service_tickets"("appointmentId");

-- CreateIndex
CREATE INDEX "service_ticket_lines_tenantId_idx" ON "service_ticket_lines"("tenantId");

-- CreateIndex
CREATE INDEX "service_ticket_lines_serviceId_idx" ON "service_ticket_lines"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "service_ticket_lines_ticketId_serviceId_key" ON "service_ticket_lines"("ticketId", "serviceId");

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_stylistId_fkey" FOREIGN KEY ("stylistId") REFERENCES "stylists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_ticket_lines" ADD CONSTRAINT "service_ticket_lines_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "service_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_ticket_lines" ADD CONSTRAINT "service_ticket_lines_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Invariantes
-- ---------------------------------------------------------------------------

-- Una cita se declara realizada una sola vez. Las anuladas no cuentan: anular una comanda
-- equivocada tiene que permitir registrar la correcta para la misma cita.
CREATE UNIQUE INDEX "service_tickets_active_appointment_uq"
  ON "service_tickets" ("appointmentId")
  WHERE "appointmentId" IS NOT NULL AND "status" <> 'CANCELLED' AND "deletedAt" IS NULL;

-- Cobrada significa que existe la factura que la cobro. Sin ella, caja no podria
-- justificar el ingreso ni la profesional su comision.
ALTER TABLE "service_tickets"
  ADD CONSTRAINT "service_tickets_charged_has_invoice"
  CHECK ("status" <> 'CHARGED' OR "invoiceId" IS NOT NULL);

-- Una anulacion sin motivo no se puede revisar despues.
ALTER TABLE "service_tickets"
  ADD CONSTRAINT "service_tickets_cancelled_has_reason"
  CHECK ("status" <> 'CANCELLED' OR "cancellationReason" IS NOT NULL);
