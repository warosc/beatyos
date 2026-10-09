-- ---------------------------------------------------------------------------
-- Agenda: solicitudes de cambio y recordatorios
-- ---------------------------------------------------------------------------
--
-- 1. Una profesional ya no mueve sus citas: pide el cambio y la encargada lo aprueba.
--    La solicitud vive aquí hasta que alguien decide.
-- 2. Los recordatorios a la clienta dejan rastro de cada intento —enviado, fallido o
--    descartado por no tener teléfono— y la cita guarda el hash del enlace con el que la
--    clienta confirma o cancela.

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ReminderChannel" AS ENUM ('WHATSAPP', 'SMS', 'LOG', 'MANUAL');

-- CreateEnum
CREATE TYPE "ReminderDeliveryStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN "confirmationTokenHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "appointments_confirmationTokenHash_key" ON "appointments"("confirmationTokenHash");

-- CreateTable
CREATE TABLE "appointment_change_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "stylistId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "currentStartsAt" TIMESTAMPTZ(3) NOT NULL,
    "proposedStartsAt" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointment_change_requests_pkey" PRIMARY KEY ("id"),
    -- Una solicitud decidida siempre dice cuándo; una pendiente, nunca.
    CONSTRAINT "appointment_change_requests_decision_ck"
      CHECK (("status" = 'PENDING') = ("decidedAt" IS NULL))
);

-- CreateIndex
CREATE INDEX "appointment_change_requests_tenantId_status_createdAt_idx" ON "appointment_change_requests"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "appointment_change_requests_tenantId_stylistId_createdAt_idx" ON "appointment_change_requests"("tenantId", "stylistId", "createdAt");

-- CreateIndex
CREATE INDEX "appointment_change_requests_appointmentId_idx" ON "appointment_change_requests"("appointmentId");

-- Como mucho una solicitud pendiente por cita: pedirla dos veces no llena la bandeja de la
-- encargada, y dos aprobaciones seguidas no pueden mover la cita a horas distintas.
CREATE UNIQUE INDEX "appointment_change_requests_one_pending_per_appointment"
  ON "appointment_change_requests"("appointmentId")
  WHERE "status" = 'PENDING';

-- CreateTable
CREATE TABLE "appointment_reminders" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "channel" "ReminderChannel" NOT NULL,
    "recipient" TEXT,
    "status" "ReminderDeliveryStatus" NOT NULL,
    "error" TEXT,
    "providerId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "appointment_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "appointment_reminders_tenantId_createdAt_idx" ON "appointment_reminders"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "appointment_reminders_appointmentId_createdAt_idx" ON "appointment_reminders"("appointmentId", "createdAt");

-- AddForeignKey
ALTER TABLE "appointment_change_requests" ADD CONSTRAINT "appointment_change_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_change_requests" ADD CONSTRAINT "appointment_change_requests_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_reminders" ADD CONSTRAINT "appointment_reminders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_reminders" ADD CONSTRAINT "appointment_reminders_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
