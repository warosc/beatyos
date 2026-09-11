-- ---------------------------------------------------------------------------
-- Seguimiento por lote, opcional por producto (ADR-0012)
-- ---------------------------------------------------------------------------
--
-- El ADR-0012 decidio que el seguimiento por lote fuera una propiedad del producto y no
-- del sistema entero. La columna faltaba: sin ella, el motor de inventario no puede
-- distinguir un tinte —que exige trazabilidad por el Reglamento (CE) 1223/2009— de un
-- secador, y acabaria pidiendo un numero de lote para todo o para nada.
--
-- El valor por defecto es `false` a proposito. Activar la trazabilidad en todo el catalogo
-- existente obligaria a inventar un lote para cada producto ya recibido, y un lote
-- inventado es peor que no tener lote: parece trazabilidad y no lo es.

ALTER TABLE "products"
  ADD COLUMN "tracksBatches" BOOLEAN NOT NULL DEFAULT false;
