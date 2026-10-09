# ADR-0022: Cumpleaños de la clienta sin año

- **Estado:** Aceptado
- **Fecha:** 2026-10-09
- **Cumple:** [ADR-0004](0004-soft-delete-y-auditoria.md) (anonimización)

## Contexto

La ficha de la clienta pedía la fecha de nacimiento completa y la API devolvía su edad. El
salón solo la usa para felicitarla y para el filtro de cumpleaños próximos de las campañas.
Preguntar el año incomoda a muchas clientas, y guardar un dato que no se necesita es un
riesgo sin beneficio: lo que no se tiene no se puede filtrar ni perder.

## Decisión

- La clienta tiene un **cumpleaños** de día y mes (`Birthday`), sin año. En la base son dos
  columnas, `birthMonth` y `birthDay`, con un `CHECK` que exige las dos o ninguna y un día
  que el mes tenga (febrero admite el 29).
- La API lo recibe y lo devuelve como `birthday: "MM-DD"`. Desaparecen `birthDate` y `age`
  del contrato.
- Quien cumple el 29 de febrero lo celebra el 28 en los años no bisiestos.
- La migración `20261009120000_birthday_without_year` conserva el día y el mes de las fechas
  ya registradas y **descarta el año**. No se puede deshacer: es el objetivo.

## Consecuencias

- El formulario pide «Cumpleaños (opcional)» con dos selectores, día y mes, y la ficha
  muestra «Cumple el 17 de abril», sin edad.
- No hay forma de calcular la edad de una clienta. Si algún día hiciera falta —por ejemplo,
  servicios con restricción de edad—, habría que pedir un dato nuevo y decidirlo aparte.

## Alternativas descartadas

- **Seguir guardando la fecha completa y solo dejar de mostrar la edad.** El dato seguiría en
  la base, en los respaldos y en cualquier exportación: el riesgo no cambia, solo se esconde.
- **Guardar una fecha con un año inventado (p. ej. 2000).** Ahorra una migración de columnas,
  pero un año falso parece un dato real: cualquier cálculo de edad que se escribiera después
  daría un número equivocado sin que nadie lo notara.
