-- Los salones de demostración deben poder aceptar una reserva al arrancar. Se añade un
-- horario únicamente a la estilista demo y únicamente cuando todavía no tiene ninguno;
-- nunca se reemplaza una jornada configurada por el usuario.
INSERT INTO "stylist_schedules" (
  "id", "tenantId", "stylistId", "dayOfWeek", "startMinutes", "endMinutes",
  "createdAt", "updatedAt"
)
SELECT
  CONCAT(
    SUBSTRING(MD5('beautyos:schedule:' || stylist."id" || ':' || day_number::text), 1, 8), '-',
    SUBSTRING(MD5('beautyos:schedule:' || stylist."id" || ':' || day_number::text), 9, 4), '-',
    '7', SUBSTRING(MD5('beautyos:schedule:' || stylist."id" || ':' || day_number::text), 14, 3), '-',
    '8', SUBSTRING(MD5('beautyos:schedule:' || stylist."id" || ':' || day_number::text), 18, 3), '-',
    SUBSTRING(MD5('beautyos:schedule:' || stylist."id" || ':' || day_number::text), 21, 12)
  ),
  stylist."tenantId", stylist."id", day_number, 540, 1080, NOW(), NOW()
FROM "stylists" stylist
JOIN "users" app_user ON app_user."id" = stylist."userId"
CROSS JOIN GENERATE_SERIES(1, 6) AS day_number
WHERE app_user."email" IN ('estilista@bella-vista.es', 'estilista@salon-b.es')
  AND stylist."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "stylist_schedules" schedule
    WHERE schedule."stylistId" = stylist."id" AND schedule."deletedAt" IS NULL
  );
