-- ---------------------------------------------------------------------------
-- Fila de espera: momento de la primera llamada (ADR-0025)
-- ---------------------------------------------------------------------------
--
-- `calledAt` es la última llamada: sube al volver a llamar y se borra al devolverla a la
-- fila. Para medir cuánto esperó una clienta hace falta la primera, que no cambia.
--
-- Aditiva. Los turnos que ya existían se rellenan con lo mejor que se sabe de ellos: la
-- última llamada o, si se borró, el inicio de la atención.

-- AlterTable
ALTER TABLE "queue_turns" ADD COLUMN     "firstCalledAt" TIMESTAMPTZ(3);

UPDATE "queue_turns"
SET "firstCalledAt" = COALESCE("calledAt", "startedAt")
WHERE "firstCalledAt" IS NULL AND COALESCE("calledAt", "startedAt") IS NOT NULL;
