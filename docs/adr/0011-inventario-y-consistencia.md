# ADR-0011: Inventario por movimientos (ledger append-only)

- **Estado:** Aceptado
- **Fecha:** 2026-09-02

## Contexto

El stock cambia por compras, ventas, consumo interno en servicios, mermas, caducidades y
ajustes de recuento. Guardar solo un contador `stock` en `Product` hace imposible
responder "por qué tengo 7 y no 9", y expone a condiciones de carrera bajo concurrencia.

## Decisión

**El stock es un dato derivado; la verdad es el registro de movimientos.**

- `InventoryMovement` es **append-only**: nunca se actualiza ni se borra. Una entrada
  errónea se corrige con un movimiento compensatorio (`ADJUSTMENT`), preservando la
  trazabilidad completa.
- Cada movimiento lleva `quantityDelta` **con signo**, tipo (`PURCHASE_IN`, `SALE_OUT`,
  `SERVICE_CONSUMPTION`, `ADJUSTMENT`, `RETURN_IN`, `WASTE_OUT`), motivo, referencia al
  documento origen (`sourceType` + `sourceId`), coste unitario y actor.
- `Product.stockOnHand` es una **caché materializada** actualizada en la **misma
  transacción** que el movimiento. Es una optimización de lectura, no la fuente de verdad:
  un job de conciliación recalcula desde el ledger y alerta ante discrepancias.

### Control de concurrencia

El descuento de stock se hace con un `UPDATE ... WHERE "stockOnHand" >= :cantidad` y se
comprueba el número de filas afectadas. Si son cero, el dominio lanza
`InsufficientStockError`. Esto evita el *lost update* del patrón leer-comprobar-escribir
sin necesidad de bloqueo pesimista ni de nivel de aislamiento serializable.

### Coste de inventario

**Media móvil ponderada (WAC)**, recalculada en cada entrada. Se elige sobre FIFO por
lotes porque el coste de implementación y de explicación al usuario final es mucho menor,
y la volatilidad de precio en consumibles de peluquería no justifica el seguimiento por
lote. Cambiar a FIFO exigiría un ADR nuevo y una tabla de lotes.

## Fuera de alcance en v1 (deuda consciente)

**Lotes y caducidad.** Afecta a tintes y productos químicos, y es previsible que se
requiera en v2 por normativa. Se deja anotado aquí para que la decisión de omitirlo sea
visible y no se descubra como un olvido.

## Consecuencias

- La tabla de movimientos es la de mayor crecimiento del sistema; se indexa por
  `(tenantId, productId, occurredAt)` y se prevé partición temporal.
- Toda mutación de stock pasa por un único servicio de dominio: no existe ningún
  `UPDATE product SET stock` disperso por los casos de uso.
- El histórico permite reconstruir el stock a cualquier fecha pasada, lo que habilita
  valoración de inventario y auditoría contable sin trabajo adicional.
