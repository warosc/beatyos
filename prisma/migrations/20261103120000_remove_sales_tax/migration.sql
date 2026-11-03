-- ADR-0026: el salón deja de cobrar IVA.
--
-- Los precios no cambian: lo que paga la clienta sigue siendo lo mismo y ahora todo es
-- ingreso del salón. Se ponen a 0 todas las filas, también las dadas de baja, para que
-- restaurar un servicio o un producto no traiga el IVA de vuelta.
--
-- No se tocan:
--   * invoice_lines / invoices: son el registro de lo que ya se cobró, con su IVA de entonces.
--   * purchase_order_lines: el proveedor sí cobra IVA, y la orden tiene que cuadrar con su
--     factura (por eso su default sigue en 12).

ALTER TABLE "services" ALTER COLUMN "taxRate" SET DEFAULT 0;
ALTER TABLE "products" ALTER COLUMN "taxRate" SET DEFAULT 0;
ALTER TABLE "invoice_lines" ALTER COLUMN "taxRate" SET DEFAULT 0;

UPDATE "services" SET "taxRate" = 0 WHERE "taxRate" <> 0;
UPDATE "products" SET "taxRate" = 0 WHERE "taxRate" <> 0;
