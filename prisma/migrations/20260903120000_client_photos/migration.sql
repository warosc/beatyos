-- ---------------------------------------------------------------------------
-- Fotos del historial de clienta (ADR-0016)
-- ---------------------------------------------------------------------------
--
-- El fichero vive en el almacen de objetos; esta tabla guarda la referencia y el
-- significado. Un `bytea` por foto infla las copias de seguridad, se pasea entero en
-- cualquier consulta que olvide excluir la columna y convierte un `pg_dump` de minutos en
-- uno de horas.

CREATE TYPE "ClientPhotoKind" AS ENUM ('BEFORE', 'AFTER', 'REFERENCE', 'FORMULA', 'OTHER');
CREATE TYPE "PhotoConsentSource" AS ENUM ('IN_PERSON', 'ONLINE', 'VERBAL');

CREATE TABLE "client_photos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "serviceId" TEXT,
    "kind" "ClientPhotoKind" NOT NULL DEFAULT 'OTHER',
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" CHAR(64) NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "originalName" TEXT,
    "caption" TEXT,
    "notes" TEXT,
    "takenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consentGivenAt" TIMESTAMPTZ(3) NOT NULL,
    "consentSource" "PhotoConsentSource" NOT NULL DEFAULT 'IN_PERSON',
    "allowsMarketing" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "deletedBy" TEXT,
    "purgedAt" TIMESTAMPTZ(3),

    CONSTRAINT "client_photos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "client_photos_tenantId_clientId_takenAt_idx" ON "client_photos" ("tenantId", "clientId", "takenAt");
CREATE INDEX "client_photos_tenantId_appointmentId_idx" ON "client_photos" ("tenantId", "appointmentId");
CREATE INDEX "client_photos_tenantId_deletedAt_idx" ON "client_photos" ("tenantId", "deletedAt");

ALTER TABLE "client_photos" ADD CONSTRAINT "client_photos_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "client_photos" ADD CONSTRAINT "client_photos_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "client_photos" ADD CONSTRAINT "client_photos_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "client_photos" ADD CONSTRAINT "client_photos_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Invariantes
-- ---------------------------------------------------------------------------

-- Dos filas apuntando al mismo objeto harian que borrar una dejara a la otra sirviendo un
-- fichero que ya no existe. Parcial como el resto: una foto dada de baja libera su ruta.
CREATE UNIQUE INDEX "client_photos_storage_key_uq"
  ON "client_photos" ("storageKey")
  WHERE "deletedAt" IS NULL;

-- Un fichero de cero bytes no es una foto, y uno declarado con tamano negativo es un error
-- de quien lo subio. La aplicacion ya lo comprueba; esto lo cierra tambien para el SQL
-- directo y para cualquier importacion futura.
ALTER TABLE "client_photos"
  ADD CONSTRAINT "client_photos_size_positive" CHECK ("sizeBytes" > 0);

-- Las dimensiones son opcionales, pero si estan, tienen que ser reales.
ALTER TABLE "client_photos"
  ADD CONSTRAINT "client_photos_dimensions_valid" CHECK (
    ("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0)
  );

-- Solo se admiten imagenes. Es la ultima barrera de la comprobacion que hace la aplicacion
-- leyendo los bytes magicos del fichero: sin esto, una fila insertada a mano podria apuntar
-- a un HTML que el navegador ejecutaria al abrir la URL firmada.
ALTER TABLE "client_photos"
  ADD CONSTRAINT "client_photos_mime_is_image" CHECK ("mimeType" LIKE 'image/%');

-- Un objeto purgado no puede seguir visible: purgar borra el fichero, y una foto sin
-- fichero que la interfaz intente abrir es un enlace roto sin explicacion.
ALTER TABLE "client_photos"
  ADD CONSTRAINT "client_photos_purged_implies_deleted" CHECK (
    "purgedAt" IS NULL OR "deletedAt" IS NOT NULL
  );
