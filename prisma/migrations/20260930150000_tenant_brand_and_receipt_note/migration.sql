-- Personalización por salón: combinación de colores de la interfaz y una línea libre al
-- pie de los comprobantes.
ALTER TABLE "tenants"
  ADD COLUMN "brandTheme" TEXT NOT NULL DEFAULT 'terracota',
  ADD COLUMN "receiptNote" TEXT;
