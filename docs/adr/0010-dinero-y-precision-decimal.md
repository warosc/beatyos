# ADR-0010: Representación monetaria en enteros de la unidad menor

- **Estado:** Aceptado
- **Fecha:** 2026-09-02

## Contexto

El sistema factura, cobra, calcula impuestos, descuentos, comisiones de estilistas y
cuadra caja. Un céntimo de deriva en un arqueo no es un redondeo: es un fallo funcional
que el usuario detecta y que destruye la confianza en el producto.

## Decisión

**El dinero nunca es `float`.**

- **En la base de datos**: `Decimal(12, 2)` de PostgreSQL (`numeric`), aritmética exacta.
- **En el dominio**: value object `Money` que envuelve un **entero de la unidad menor**
  (céntimos) más el código ISO-4217 de moneda. Inmutable; toda operación devuelve una
  instancia nueva.
- **En la frontera JSON**: se serializa como **cadena decimal** (`"1250.00"`), nunca como
  número. `JSON.parse` en JavaScript convierte a `double` y `0.1 + 0.2 !== 0.3`.
- `Money` **rechaza operar entre monedas distintas**: es un error de dominio, no una
  conversión implícita.
- El redondeo es explícito, *half-up*, y solo en el último paso: los importes intermedios
  (impuesto por línea, comisión por servicio) mantienen precisión y se redondean al
  asentarse en el documento.

Prisma devuelve `Decimal.js`; la conversión a `Money` ocurre en el **mapeador del
repositorio**, de modo que ningún tipo de Prisma entra en el dominio (ADR-0001).

## Consecuencias

- Los clientes deben tratar los importes como cadenas y usar aritmética decimal en su
  lado. Documentado en el README y anotado en el esquema OpenAPI.
- Multi-moneda queda soportada estructuralmente desde el día uno, aunque hoy cada
  inquilino opere en una sola: la moneda se guarda junto a cada importe y no se asume.
- El reparto de un descuento global entre líneas produce restos de un céntimo. Se asigna
  el resto a la línea de mayor importe, de forma determinista, para que la suma de líneas
  cuadre siempre con el total del documento.

## Alternativas descartadas

- **`float` / `number` de JavaScript.** Descartado sin discusión.
- **`Decimal.js` en el dominio.** Correcto en precisión, pero mete una librería de terceros
  en el núcleo y no aporta la semántica de moneda ni las invariantes de negocio.
