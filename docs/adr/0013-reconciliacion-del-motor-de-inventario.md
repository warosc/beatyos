# ADR-0013: Reconciliación del motor de inventario

- **Estado:** Aceptado
- **Fecha:** 2026-09-03
- **Cumple:** [ADR-0001](0001-arquitectura-hexagonal.md), [ADR-0010](0010-dinero-y-precision-decimal.md), [ADR-0011](0011-inventario-y-consistencia.md), [ADR-0012](0012-lotes-caducidad-y-fefo.md)

## Contexto

El módulo de inventario existía en dos versiones incompatibles.

Por un lado, un dominio probado —`Batch`, `StockAllocationService`— escrito según el
ADR-0012, con reparto FEFO, coste real por lote y 83 tests. **No lo usaba nadie**: era
código huérfano.

Por otro, un `InventoryService` de 23 líneas minificadas que sí estaba conectado a la API,
sin ningún test, y que era el que atendía las peticiones de `apps/web`. Ese servicio tenía
tres defectos, y conviene nombrarlos con precisión porque son de gravedad muy distinta.

### 1. Pérdida de escrituras en las existencias

```ts
const oldQty = Number(product.stockOnHand);
const newQty = oldQty + dto.quantity;
await prisma.product.update({ where: { id }, data: { stockOnHand: newQty } });
```

Leer, sumar en JavaScript y escribir el total **no es atómico**. Dos recepciones
simultáneas leen el mismo valor de partida y la segunda pisa a la primera: una caja entera
de producto desaparece del sistema. El ledger registra las dos entradas y la caché muestra
una, de modo que la divergencia solo sale a la luz en el recuento físico, semanas después y
sin forma de saber cuándo empezó.

No es un fallo teórico. Ocurre en cuanto dos personas trabajan a la vez, que es la
situación normal de un salón un sábado por la mañana.

### 2. Dinero en coma flotante

`Number(product.costPrice)` y una media calculada con `/` violan el ADR-0010 de forma
directa. El coste medio se redondeaba con `toFixed(2)` sobre un `number`, con lo que el
error se acumulaba recepción tras recepción.

### 3. FEFO inexistente

Los lotes se creaban y se listaban. **Ninguna salida los consumía**: el stock bajaba del
producto y los lotes se quedaban con su cantidad original para siempre. La trazabilidad que
el Reglamento (CE) 1223/2009 exige —«qué lote se le aplicó a esta clienta»— no estaba
implementada, solo aparentada.

Además, el filtro por semáforo de existencias se traía la tabla entera y la filtraba en
JavaScript con un `.filter()`, de modo que la pantalla se volvía más lenta con cada alta y
los totales de paginación no correspondían con lo que se veía.

## Decisión

**Se sustituye el motor por completo y se conserva la API intacta.**

Las rutas, los nombres de campo y el formato de cada respuesta son byte a byte los mismos.
`apps/web` no se ha tocado ni una línea. Esto es precisamente lo que un adaptador bien
puesto compra (ADR-0001): la posibilidad de cambiar lo de dentro sin negociar con lo de
fuera.

### 1. El módulo pasa a hexagonal

```
inventory/
  domain/          Product, Batch, InventoryMovement, StockAllocationService, puertos
  application/     casos de uso
  infrastructure/  http/ (controladores, DTOs, presentadores) + persistence/ (Prisma)
```

`Product` y `InventoryMovement` no existían como dominio: la lógica vivía repartida entre
el servicio y consultas de Prisma. Ahora el semáforo de existencias, la media ponderada, el
tope de reposición y las reglas de baja son métodos del agregado, y se prueban sin base de
datos.

### 2. La caché de existencias no se calcula, se aplica

Es la decisión central y la que arregla la pérdida de escrituras.

`Product.applyDelta` recibe **la variación, nunca el valor final**, y el puerto lo traduce
a una sentencia condicional:

```sql
UPDATE "products"
   SET "stockOnHand" = "stockOnHand" + :delta
 WHERE "id" = :id AND "stockOnHand" >= :cantidad   -- solo en las salidas
```

Comprobación y escritura ocurren bajo el mismo bloqueo de fila, sin ventana entre una y
otra. `count = 0` significa «no había bastante **en el momento de escribir**», que es el
único momento que cuenta.

La otra mitad del mecanismo es igual de importante y menos evidente: **`update` no escribe
`stockOnHand`**. Si lo hiciera, un caso de uso que lee el producto, aplica la variación
atómica y después guarda el coste medio recalculado escribiría el stock que leyó *antes* de
la variación, deshaciéndola en silencio. La exclusión está documentada en el puerto y
replicada en los dobles en memoria, porque un doble que se desvíe del contrato deja de
probar nada (ADR-0009).

Lo mismo se aplica a los lotes: `BatchRepository.consume` es condicional, y el `CHECK` de
`product_batches` queda como última red.

### 3. El ledger no admite modificación, ni siquiera por tipo

`MovementRepository` **no declara** `update`, `softDelete` ni `restore`, y su adaptador no
hereda de `PrismaRepositoryBase` para no recibirlos por herencia. Un repositorio que no
ofrece modificar es un repositorio que no se puede usar para modificar, y la garantía deja
de depender de que nadie llame al método equivocado. El trigger
`inventory_movements_append_only` cubre lo que entre por fuera de la aplicación.

### 4. FEFO de verdad, con un asiento por lote

`ConsumeStockUseCase` calcula el reparto primero —sin mutar nada— y solo después escribe.
Una salida imposible se rechaza entera, no a mitad de camino con medio lote consumido.

Cada tramo genera **su propio asiento en el kardex**, con su lote y su coste real. Esa es
la diferencia entre poder responder a una reclamación y no poder.

`AdjustStockUseCase` no reimplementa el reparto: delega en `ConsumeStockUseCase` cuando la
salida no indica lote. Dos motores de inventario acaban divergiendo (ADR-0002).

### 5. El filtro de existencias baja a la base de datos

El semáforo se resuelve con una referencia de campo de Prisma
(`stockOnHand <= reorderPoint`) y no con SQL crudo. La diferencia no es de estilo: el SQL
crudo **no pasa por la extensión** que inyecta el `tenantId` y filtra los borrados
(ADR-0003), de modo que una consulta cruda devolvería productos de todos los salones salvo
que alguien se acordase de filtrarlo a mano cada vez.

### 6. `Product.tracksBatches`

El ADR-0012 lo decidió y el esquema no lo tenía. Se añade con `DEFAULT false`: activar la
trazabilidad en todo el catálogo existente obligaría a inventar un lote para cada producto
ya recibido, y un lote inventado es peor que no tener lote porque parece trazabilidad.

## Consecuencias

**Lo que se gana.** El fallo de concurrencia queda cerrado y demostrado: diez recepciones
simultáneas suman treinta unidades, y de dos salidas que compiten por las últimas
existencias solo una prospera. El coste de cada servicio pasa a ser exacto en lugar de
estimado. La trazabilidad por lote existe de verdad. La pantalla de inventario deja de
degradarse con el tamaño del catálogo.

**Lo que cuesta.** El módulo pasa de 4 archivos a 10, y una recepción que antes eran dos
consultas ahora son cinco dentro de una transacción. Es el precio de que la operación sea
atómica y quede auditada; una recepción por minuto no nota la diferencia.

**Un fallo que apareció al probar.** `PrismaRepositoryBase.restore` limpia `deletedAt` con
un `updateMany` y no puede saber que en este agregado dar de baja implica además desactivar
el producto. Sin corregirlo, un producto recuperado reaparecía en el catálogo pero seguía
sin poder venderse —peor que no recuperarlo, porque nadie lo nota hasta que alguien intenta
cobrarlo—. El adaptador ahora sobrescribe `restore` y pasa por `markRestored`, de modo que
la regla sigue viviendo en la entidad.

**Lo que no cambia.** La API. Tres tests de integración fijan por escrito, campo a campo,
la forma exacta que lee `apps/web`, porque una premisa que nadie comprueba dura hasta el
primer refactor.

## Alternativas descartadas

**Bloqueo optimista con una columna `version`.** Habría funcionado, pero obliga a
reintentar en el cliente y convierte cada recepción concurrente en un 409 que la encargada
no entiende. El `UPDATE` condicional resuelve el mismo problema sin pedirle nada a quien
usa el sistema.

**`SELECT ... FOR UPDATE` antes de calcular.** Correcto y más caro: serializa a todos los
que tocan el producto durante toda la transacción, incluidas las lecturas del reparto FEFO.
La sentencia condicional bloquea solo la fila y solo mientras escribe.

**Recalcular `stockOnHand` desde el ledger en cada consulta.** Elimina la caché y con ella
la posibilidad de divergencia, pero convierte la pantalla de inventario en una suma sobre
todo el histórico de cada producto. Se conserva la caché y se añade
`MovementRepository.balanceOf` para poder **comprobar** que no ha divergido, que es lo que
da la garantía sin pagar el coste.

**Arreglar el `InventoryService` existente sin reescribirlo.** Habría dejado la lógica de
negocio en un servicio acoplado a Prisma, sin dominio que probar y sin sitio donde poner
FEFO. El defecto no era una línea, era la ausencia de una capa.
