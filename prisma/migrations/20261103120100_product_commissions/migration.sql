-- ADR-0027: comisión en productos.
--
-- Cada profesional gana un % en servicios (la columna de siempre) y otro en productos. Todas
-- las profesionales existentes empiezan con el 10 % en productos. Un producto puede tener una
-- comisión especial que manda sobre la de la profesional, igual que ya pasa en servicios.

ALTER TABLE "stylists" ADD COLUMN "productCommissionRate" DECIMAL(5,2) NOT NULL DEFAULT 10;
ALTER TABLE "products" ADD COLUMN "commissionRate" DECIMAL(5,2);

ALTER TABLE "stylists"
  ADD CONSTRAINT "stylists_product_commission_valid"
  CHECK ("productCommissionRate" BETWEEN 0 AND 100);

ALTER TABLE "products"
  ADD CONSTRAINT "products_commission_valid"
  CHECK ("commissionRate" IS NULL OR "commissionRate" BETWEEN 0 AND 100);
