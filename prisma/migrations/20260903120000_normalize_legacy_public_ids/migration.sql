-- Los primeros datos demo usaban identificadores legibles (por ejemplo,
-- `cli-bella-vista-rosa`). Los DTO públicos de citas aceptan únicamente UUID, así
-- que esos registros podían seleccionarse en la agenda pero nunca reservarse.
--
-- La actualización es segura para datos existentes: las claves foráneas fueron
-- creadas con ON UPDATE CASCADE y el hash hace que el resultado sea determinista.
-- Se limita a filas que no tienen forma de UUID para no tocar datos ya normalizados.

UPDATE "clients"
SET "id" = CONCAT(
  SUBSTRING(MD5('beautyos:client:' || "id"), 1, 8), '-',
  SUBSTRING(MD5('beautyos:client:' || "id"), 9, 4), '-',
  '7', SUBSTRING(MD5('beautyos:client:' || "id"), 14, 3), '-',
  '8', SUBSTRING(MD5('beautyos:client:' || "id"), 18, 3), '-',
  SUBSTRING(MD5('beautyos:client:' || "id"), 21, 12)
)
WHERE "id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

UPDATE "stylists"
SET "id" = CONCAT(
  SUBSTRING(MD5('beautyos:stylist:' || "id"), 1, 8), '-',
  SUBSTRING(MD5('beautyos:stylist:' || "id"), 9, 4), '-',
  '7', SUBSTRING(MD5('beautyos:stylist:' || "id"), 14, 3), '-',
  '8', SUBSTRING(MD5('beautyos:stylist:' || "id"), 18, 3), '-',
  SUBSTRING(MD5('beautyos:stylist:' || "id"), 21, 12)
)
WHERE "id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
