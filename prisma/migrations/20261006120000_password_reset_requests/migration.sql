-- ---------------------------------------------------------------------------
-- Solicitudes de contraseña para la propietaria
-- ---------------------------------------------------------------------------
--
-- «Olvidé mi contraseña» deja aquí un aviso que la propietaria ve en Equipo y resuelve
-- asignando una contraseña nueva. Es la vía de recuperación que funciona sin correo
-- saliente; el enlace por correo sigue emitiéndose para cuando haya proveedor.

-- CreateEnum
CREATE TYPE "PasswordResetRequestStatus" AS ENUM ('PENDING', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "password_reset_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "PasswordResetRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedBy" TEXT,

    CONSTRAINT "password_reset_requests_pkey" PRIMARY KEY ("id"),
    -- Una solicitud cerrada siempre dice cuándo; una pendiente, nunca.
    CONSTRAINT "password_reset_requests_resolution_ck"
      CHECK (("status" = 'PENDING') = ("resolvedAt" IS NULL))
);

-- CreateIndex
CREATE INDEX "password_reset_requests_tenantId_status_createdAt_idx" ON "password_reset_requests"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "password_reset_requests_userId_idx" ON "password_reset_requests"("userId");

-- Pedirla diez veces no llena la bandeja de la propietaria con diez avisos: como mucho uno
-- pendiente por usuario. El repositorio cuenta con este índice para no duplicar.
CREATE UNIQUE INDEX "password_reset_requests_one_pending_per_user"
  ON "password_reset_requests"("userId")
  WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "password_reset_requests" ADD CONSTRAINT "password_reset_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_requests" ADD CONSTRAINT "password_reset_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
