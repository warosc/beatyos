-- ADR-0022: el cumpleaños de la clienta se guarda sin año.
--
-- El salón necesita saber cuándo felicitarla, no su edad. Se conserva el día y el mes de las
-- fechas ya registradas y se descarta el año: lo que no hace falta no se guarda.

ALTER TABLE "clients"
  ADD COLUMN "birthMonth" SMALLINT,
  ADD COLUMN "birthDay" SMALLINT;

UPDATE "clients"
SET
  "birthMonth" = EXTRACT(MONTH FROM "birthDate")::SMALLINT,
  "birthDay" = EXTRACT(DAY FROM "birthDate")::SMALLINT
WHERE "birthDate" IS NOT NULL;

ALTER TABLE "clients" DROP COLUMN "birthDate";

-- Los dos o ninguno, y un día que el mes tenga (febrero admite el 29).
ALTER TABLE "clients"
  ADD CONSTRAINT "clients_birthday_valid" CHECK (
    ("birthMonth" IS NULL AND "birthDay" IS NULL)
    OR (
      "birthMonth" BETWEEN 1 AND 12
      AND "birthDay" BETWEEN 1 AND (
        CASE "birthMonth" WHEN 2 THEN 29 WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30 ELSE 31 END
      )
    )
  );
