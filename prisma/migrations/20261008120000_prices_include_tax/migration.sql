-- ADR-0021: los precios llevan el IVA incluido.
--
-- Hasta ahora el catálogo guardaba el precio sin IVA y el impuesto se sumaba encima, así que
-- no todo precio se podía cobrar exacto (con el 12 %, Q45.50 no sale de ninguna base de dos
-- decimales) y los descuentos se guardaban sin IVA. Desde aquí `price`, `unitPrice` y
-- `discountAmount` son lo que paga, o deja de pagar, la clienta.
--
-- La conversión usa la misma regla con la que se calculaban (IVA = base × tasa, redondeado
-- half-up, que es lo que hace ROUND con numéricos positivos), así que ningún precio cambia
-- para la clienta: lo que ayer salía en caja es exactamente lo que queda guardado.

-- 1. Catálogo.
UPDATE "products" SET "price" = "price" + ROUND("price" * "taxRate" / 100, 2);
UPDATE "services" SET "price" = "price" + ROUND("price" * "taxRate" / 100, 2);

-- 2. Citas. Su precio es una copia del catálogo al reservar y no guarda tasa propia: se toma
-- la del servicio, que es la que se le habría aplicado al cobrarla.
UPDATE "appointment_services" AS a
SET "price" = a."price" + ROUND(a."price" * s."taxRate" / 100, 2)
FROM "services" AS s
WHERE s."id" = a."serviceId";

-- 3. Ventas ya emitidas. Total, IVA, base imponible y comisiones no se tocan: solo se
-- expresan con IVA el precio unitario y el descuento, que es como se leen a partir de ahora.
-- El descuento pasa a ser lo que dejó de pagar la clienta: el precio de lista con IVA menos
-- lo que pagó. En una línea con cantidad mayor que uno, precio × cantidad − descuento puede
-- diferir un céntimo del total por el redondeo de entonces; manda el total guardado.
UPDATE "invoice_lines"
SET
  "discountAmount" = CASE
    WHEN "discountAmount" > 0 THEN
      ("lineSubtotal" + "discountAmount")
        + ROUND(("lineSubtotal" + "discountAmount") * "taxRate" / 100, 2)
        - "lineTotal"
    ELSE 0
  END,
  "unitPrice" = "unitPrice" + ROUND("unitPrice" * "taxRate" / 100, 2);

UPDATE "invoices" AS i
SET "discountTotal" = COALESCE(
  (SELECT SUM(l."discountAmount") FROM "invoice_lines" AS l WHERE l."invoiceId" = i."id"),
  0
);
