# ADR-0017: Normalización arquitectónica de compras

- **Estado:** Aceptado
- **Fecha:** 2026-09-07 (actualizado 2026-09-11 al cerrar R1)
- **Cumple:** [ADR-0001](0001-arquitectura-hexagonal.md), [ADR-0002](0002-stack-tecnologico.md), [ADR-0007](0007-api-rest-versionada.md), [ADR-0008](0008-manejo-de-errores.md), [ADR-0010](0010-dinero-y-precision-decimal.md)
- **Depende de:** [ADR-0013](0013-reconciliacion-del-motor-de-inventario.md)

## Contexto

Compras era la última excepción estructural del repositorio, y el README lo decía sin
adornos. Tres archivos: un `purchases.service.ts` de 371 líneas con `PrismaService` y
`QueryScopeStore` inyectados, un controlador con once endpoints escritos a línea por
endpoint, y el módulo. **Sin capa de dominio, sin puertos y sin un solo test unitario.**

El control de dependencias que el proyecto ejecuta sobre sí mismo devolvía exactamente dos
coincidencias en veintisiete mil líneas, y las dos eran de este archivo.

La ausencia de esa capa no era un problema estético. Producía cuatro consecuencias
concretas, y conviene nombrarlas por separado porque son de gravedad muy distinta.

### 1. Los errores de la base no se traducían

La traducción vive en `withMappedErrors`, que invocan los repositorios. Compras no tenía
repositorio, así que ningún error de persistencia pasaba por ahí y el filtro global no
tiene rama para los errores de Prisma. Dar de alta un proveedor con un código ya existente
—acción rutinaria, error de usuario— devolvía **500 con un cuerpo genérico** en lugar del
409 `SUPPLIER_CODE_EXISTS`.

Lo llamativo es que la traducción ya existía: `suppliers_tenant_code_uq` estaba en la tabla
de constraints desde el principio. Lo que faltaba era el camino que llevara hasta ella.

### 2. Una carrera en la recepción de mercancía

```ts
const remaining = roundQuantity(Number(line.quantity) - Number(line.receivedQuantity));
if (receipt.quantity > remaining) throw ...;   // comprobación en JavaScript
await this.receiveStock.execute({ ... });
await prisma.purchaseOrderLine.update({ data: { receivedQuantity: { increment: q } } });
```

Es el patrón leer-comprobar-escribir que el ADR-0013 acababa de eliminar de inventario,
reintroducido aquí. Dos personas descargando el mismo albarán leen ambas cero recibido,
ambas superan la validación y ambas suman. El `CHECK` `receivedQuantity <= quantity` de la
base impedía la corrupción —eso hay que decirlo—, pero al precio de un error de restricción
sin traducir: **un 500 en una operación de mostrador**, justo por el defecto anterior.

### 3. Las cantidades vivían en coma flotante

`0,3 − 0,1` da `0,19999999999999998`, y comparar esa cifra con los `0,2` que alguien
intentaba recibir rechazaba una recepción legítima. La versión anterior lo corregía
redondeando el resultado de la resta, con un comentario que lo explicaba. Funcionaba, y
dejaba la puerta abierta: cualquier operación nueva que olvidara el redondeo volvía a
introducir el fallo.

### 4. No había nada que probar sin base de datos

El módulo tenía 95,2 % de cobertura de sentencias, y las 189 sentencias venían **enteras**
de la suite de integración. Sin dominio no hay test unitario posible, y las ramas se
quedaban en 72,1 %, la segunda peor cifra del repositorio. Una cobertura así mide líneas
ejecutadas, no reglas afirmadas.

## Decisión

**Se normaliza el módulo a la arquitectura del resto y se conserva la API.**

Las rutas, los métodos, los permisos, los códigos de error y los nombres de campo son los
mismos. Las veintiuna pruebas de integración que existían pasan **sin tocar una sola
línea**, que es la única forma seria de afirmar que el comportamiento no ha cambiado.

### 1. El módulo pasa a hexagonal

```
purchases/
  domain/          PurchaseOrder, Supplier, Quantity, puertos
  application/     un caso de uso por intención
  infrastructure/  http/ (controladores, DTOs, presentadores) + persistence/ (Prisma)
```

`PurchaseOrder` y `Supplier` no existían como dominio: la lógica vivía repartida entre el
servicio y las consultas. Ahora la máquina de estados, la cantidad pendiente, el cálculo de
totales y la regla de que a un proveedor de baja no se le pide nada son métodos del
agregado, y se prueban sin base de datos.

### 2. El agregado decide; el repositorio escribe condicionalmente

Es la decisión central, y la que arregla la carrera.

`PurchaseOrder` **no cambia de estado por su cuenta**. Expone `assertCanSubmit()`,
`assertCanCancel()`, `assertReceivable()` y `planReceipt()`: criterios, no escrituras. La
transición la aplica el repositorio con una sentencia condicionada al estado de partida, y
devuelve `boolean`:

```sql
UPDATE "purchase_order_lines"
   SET "receivedQuantity" = "receivedQuantity" + :q
 WHERE "id" = :id AND "receivedQuantity" <= "quantity" - :q
```

`false` significa «no cabía **en el momento de escribir**», que es el único momento que
cuenta. Comprobación y escritura ocurren bajo el mismo bloqueo de fila, sin ventana entre
una y otra, y quien llega segundo recibe un 422 que explica lo ocurrido en lugar de un 500.

Que el agregado no tenga `setStatus` es deliberado: tenerlo invitaría a saltarse esa
condición desde cualquier caso de uso nuevo.

El umbral `quantity − :q` se toma del agregado y no de una lectura propia porque **la
cantidad pedida de una línea es inmutable**: ningún endpoint la modifica después de crear
el pedido. Lo único que se mueve es `receivedQuantity`, y de eso se ocupa la sentencia.

### 3. Las cantidades son un value object de milésimas enteras

`Quantity` guarda un entero de milésimas, igual que `Money` guarda céntimos y por el mismo
motivo: el esquema declara `Decimal(12, 3)`, así que la cantidad ya está definida sobre esa
rejilla y representarla con `number` la saca de ella. Con el entero, `0,3 − 0,1` es
exactamente `0,2` y no hay ningún redondeo que recordar.

`toNumber()` existe porque la frontera con inventario habla en `number`. La conversión
ocurre en un solo sitio y hacia fuera, nunca entre dos operaciones del dominio.

### 4. La recepción sigue delegando en inventario, y ahora es visible

`ReceivePurchaseOrderUseCase` llama a `ReceiveStockUseCase`, que el módulo de inventario
exporta justamente para esto: reparto FEFO, coste real por lote, asiento del kardex y
descuento atómico. Compras no escribe una línea de lógica de existencias.

Lo que cambia no es la delegación —ya existía— sino que ahora se puede afirmar sin base de
datos: el caso de uso recibe el puerto, y un test unitario comprueba que una recepción
mueve el kardex. Si alguien reimplantara aquí el descuento de stock, ese test lo detectaría.

### 5. Los presentadores sustituyen a las filas de Prisma

El controlador devolvía filas del ORM tal cual, de modo que cualquier columna nueva en el
esquema aparecía en la API sin que nadie lo decidiera. Ahora hay presentadores explícitos.

Los importes salen como cadena decimal canónica de dos decimales y las cantidades de tres,
que es lo que el ADR-0010 exige en la frontera JSON. Prisma normalizaba los ceros —`"105"`
en vez de `"105.00"`—, que es justo la ambigüedad que aquel ADR existe para evitar y que el
resto de módulos ya no tenía. Es el **único** cambio de formato de esta refactorización, y
está acotado: todos los consumidores conocidos convierten con `Number()` antes de usar el
valor.

### 6. Numeración: puerto propio, no el de ventas

`DocumentNumberGenerator` ya admite `PURCHASE_ORDER` en su unión de tipos, y aun así
compras estrena `PurchaseOrderNumberGenerator`. El motivo no es descuido: los dos guardan
el prefijo con convenios distintos. Ventas almacena `"F-2026-"` y concatena; compras
almacena `"OC"` y compone `OC-2026-000001`. Unificarlos hoy cambiaría el número visible de
todos los pedidos futuros de las series ya abiertas.

La garantía sí es la misma —serie consecutiva y sin huecos, contador reservado con un
`upsert` con `increment` dentro de la transacción que crea el pedido—. Queda anotado como
deuda con nombre: unificar exige una migración que reescriba el prefijo de las filas
existentes, y eso es un cambio de datos, no una refactorización.

### 7. Restaurar un proveedor lo reactiva

`PrismaRepositoryBase.restore` solo limpia `deletedAt`, y no puede saber que en este
agregado dar de baja también deja al proveedor sin poder recibir pedidos. Es exactamente el
fallo que el ADR-0013 describió al recuperar un producto, y se resuelve igual: el adaptador
sobrescribe `restore` y pasa por `Supplier.markRestored`, de modo que la regla siga viviendo
en la entidad y valga para cualquier otra vía de restauración.

## Multi-tenancy

No cambia, y ahora se comprueba. El `tenantId` sigue entrando por el claim del token y
ningún `where` de este módulo lo menciona: lo inyecta la extensión de Prisma (ADR-0003).
Escribirlo a mano sería tanto ruido como riesgo.

Se añaden seis pruebas de integración dedicadas: un salón no ve los proveedores ni los
pedidos del otro, pedir por id un pedido ajeno da 404 y no 403, no se puede pedir a un
proveedor de otro salón ni recibir mercancía de su pedido, y cada salón numera su propia
serie desde el uno.

## Consecuencias

**Lo que se gana.** La carrera queda cerrada y demostrada con un test que coloca una entrega
ajena entre la lectura y la escritura. Los errores de restricción se traducen. Las
cantidades fraccionarias son exactas por construcción y no por un redondeo que hay que
recordar. El módulo pasa de 0 tests unitarios a 61, y las reglas de negocio se afirman en
milisegundos en lugar de necesitar PostgreSQL. El control de dependencias del repositorio
devuelve **cero coincidencias** por primera vez.

**Lo que cuesta.** El módulo pasa de 3 archivos a 11 y de 407 líneas a unas 1 600, comentarios
incluidos. Componer la respuesta exige dos consultas por lote —proveedores y productos— que
antes resolvía un `include` de Prisma; se hacen por lote y no por línea, de modo que no hay
N+1, pero son consultas que antes no estaban. Es el precio de que la respuesta la decida el
código y no el esquema.

**Lo que no cambia.** La API. Once endpoints, mismos permisos, mismos códigos de error,
mismos nombres de campo. Las veintiuna pruebas de integración anteriores pasan sin
modificarse, y se suman ocho nuevas.

**Lo que se conserva a propósito aunque no sea bonito.** Recibir o cancelar un pedido que no
existe devuelve 422 y no 404, porque es lo que la API viene devolviendo: la consulta original
filtraba por id y estado a la vez, y no distinguía «no existe» de «estado incorrecto».
Cambiarlo sería un cambio de contrato, y esta fase prometía no introducir ninguno. Queda
anotado para cuando se decida deliberadamente.

Los listados `GET /purchases` y `GET /suppliers` quedaron paginados al cerrar R1. Aceptan
`page`, `limit` y `sort`, con un máximo de 100 elementos, y conservan el arreglo de recursos
en `data` mientras añaden los metadatos comunes en `meta`.

## Alternativas descartadas

**Arreglar el servicio sin reescribirlo.** Añadir `withMappedErrors` y un `UPDATE`
condicional habría cerrado los dos defectos graves en muchas menos líneas. Se descarta
porque deja la lógica de negocio en un servicio acoplado a Prisma, sin dominio que probar y
sin sitio donde poner la siguiente regla. El defecto no era una línea, era la ausencia de
una capa —el mismo razonamiento del ADR-0013.

**Un repositorio de líneas de pedido.** Permitiría escribir una línea sin recalcular el
total del documento, que es el camino más corto a un pedido que no suma. El agregado es el
pedido entero, como la factura en el ADR-0014.

**Bloqueo optimista con una columna `version`.** Habría funcionado y obliga a reintentar en
el cliente, convirtiendo cada recepción concurrente en un 409 que la encargada no entiende.
La sentencia condicional resuelve lo mismo sin pedirle nada a quien usa el sistema.

**Solo `UPDATE` condicional, sin bloquear la cabecera.** La primera implementación de R1
usó esta opción. Protegía una misma línea, pero dos recepciones simultáneas de líneas
distintas podían calcular ambas `PARTIALLY_RECEIVED`, y una cancelación podía intercalarse
con la entrada de inventario. El cierre de R1 añadió `SELECT ... FOR UPDATE` sobre la
cabecera dentro de la unidad de trabajo. El coste de serializar operaciones de una misma
orden se acepta porque garantiza que estado, líneas, inventario y cancelación evolucionen
como una sola transición. El `UPDATE` condicional de cada línea se conserva como defensa.

**Reutilizar `DocumentNumberGenerator` de ventas.** Es lo correcto a medio plazo y se
descarta hoy por lo dicho en el punto 6: cambiaría los números visibles de las series ya
abiertas sin una migración que lo acompañe.

**Emitir los importes como los emitía Prisma.** Habría dejado la respuesta byte a byte
idéntica. Se descarta porque perpetúa en el único módulo que se estaba normalizando la
ambigüedad que el ADR-0010 existe para evitar, y porque el cambio es verificable: todos los
consumidores conocidos parsean con `Number()`.
