-- Tipo impositivo por defecto: del 21% (España) al 12% (Guatemala).
--
-- El diseño inicial partía del mercado español y ese 21% quedó como valor por defecto en
-- cuatro tablas. Cada servicio o producto creado sin indicar tipo nacía con un impuesto
-- que no le corresponde.
--
-- **Solo se cambia el valor por defecto, no las filas existentes.** Un documento ya
-- emitido conserva el tipo que se le aplicó: reescribirlo alteraría importes de facturas
-- cerradas, que es justo lo que no se puede hacer. Si hay datos de prueba con el tipo
-- anterior, se corrigen a mano o se vuelve a sembrar.
ALTER TABLE "services"             ALTER COLUMN "taxRate" SET DEFAULT 12;
ALTER TABLE "products"             ALTER COLUMN "taxRate" SET DEFAULT 12;
ALTER TABLE "purchase_order_lines" ALTER COLUMN "taxRate" SET DEFAULT 12;
ALTER TABLE "invoice_lines"        ALTER COLUMN "taxRate" SET DEFAULT 12;
