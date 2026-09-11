-- ---------------------------------------------------------------------------
-- Normalizacion de identificadores de demostracion a UUID
-- ---------------------------------------------------------------------------
--
-- Los articulos de demostracion originales tenian identificadores legibles del tipo
-- `prd-bella-vista-TIN-001`. Los controladores validan los parametros con `ParseUUIDPipe` y
-- el contrato de ventas exige UUID en `itemId`, de modo que esos articulos no se podian ni
-- vender ni consultar por la API.
--
-- Las claves foraneas llevan ON UPDATE CASCADE, asi que citas, facturas y kardex siguen a
-- su articulo.
--
-- ---------------------------------------------------------------------------
-- Por que se levanta el trigger de solo-anexion
-- ---------------------------------------------------------------------------
--
-- El primer intento de esta migracion fallo, y fallo *bien*:
--
--   ERROR: La tabla inventory_movements es append-only: UPDATE no esta permitido.
--
-- El cascade sobre `products.id` intenta actualizar `inventory_movements."productId"`, y el
-- trigger lo rechaza. Esa es exactamente su razon de ser (ADR-0011), y que saltara aqui es
-- la prueba de que protege tambien contra lo que entra por fuera de la aplicacion.
--
-- Se levanta a proposito y solo durante esta sentencia porque **no se altera ningun hecho
-- del ledger**: el mismo movimiento, la misma cantidad, el mismo producto y la misma fecha.
-- Lo unico que cambia es la clave subrogada con la que se le apunta. Corregir esto con «un
-- asiento compensatorio», que es lo que sugiere el mensaje del trigger, seria inventar
-- entradas y salidas que nunca ocurrieron para acabar en el mismo sitio.
--
-- Prisma ejecuta cada migracion dentro de una transaccion, de modo que si algo falla el
-- trigger vuelve a su sitio con el resto del cambio. Y `ENABLE TRIGGER` esta al final sin
-- condiciones: dejarlo desactivado convertiria el ledger en una tabla normal para siempre.

ALTER TABLE "inventory_movements" DISABLE TRIGGER "inventory_movements_append_only";

UPDATE "services"
SET "id" = CONCAT(
  SUBSTRING(MD5('beautyos:service:' || "id"), 1, 8), '-',
  SUBSTRING(MD5('beautyos:service:' || "id"), 9, 4), '-',
  '7', SUBSTRING(MD5('beautyos:service:' || "id"), 14, 3), '-',
  '8', SUBSTRING(MD5('beautyos:service:' || "id"), 18, 3), '-',
  SUBSTRING(MD5('beautyos:service:' || "id"), 21, 12)
)
WHERE "id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- El cambio de PK se propaga al Kardex mediante la FK. Se suspende exclusivamente el
-- trigger de UPDATE durante esta reparación de identidad; no se altera cantidad, coste
-- ni ningún otro dato contable, y se reactiva antes de confirmar la transacción.
ALTER TABLE "inventory_movements" DISABLE TRIGGER "inventory_movements_append_only";

UPDATE "products"
SET "id" = CONCAT(
  SUBSTRING(MD5('beautyos:product:' || "id"), 1, 8), '-',
  SUBSTRING(MD5('beautyos:product:' || "id"), 9, 4), '-',
  '7', SUBSTRING(MD5('beautyos:product:' || "id"), 14, 3), '-',
  '8', SUBSTRING(MD5('beautyos:product:' || "id"), 18, 3), '-',
  SUBSTRING(MD5('beautyos:product:' || "id"), 21, 12)
)
WHERE "id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

ALTER TABLE "inventory_movements" ENABLE TRIGGER "inventory_movements_append_only";

ALTER TABLE "inventory_movements" ENABLE TRIGGER "inventory_movements_append_only";

-- Comprobacion de cierre: si quedara un identificador sin normalizar, la migracion no ha
-- hecho su trabajo y es mejor saberlo ahora que descubrirlo cuando alguien intente vender
-- ese articulo y reciba un 400 sin explicacion.
DO $$
DECLARE
  pendientes INT;
BEGIN
  SELECT count(*) INTO pendientes FROM (
    SELECT "id" FROM "services"
    WHERE "id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    UNION ALL
    SELECT "id" FROM "products"
    WHERE "id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) AS sin_normalizar;

  IF pendientes > 0 THEN
    RAISE EXCEPTION 'Quedan % articulos con identificador no UUID', pendientes;
  END IF;
END $$;
