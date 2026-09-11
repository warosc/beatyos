# ADR-0014: Ventas, cobros y arqueo de caja

- **Estado:** Aceptado
- **Fecha:** 2026-09-03
- **Cumple:** [ADR-0001](0001-arquitectura-hexagonal.md), [ADR-0002](0002-stack-tecnologico.md), [ADR-0010](0010-dinero-y-precision-decimal.md)
- **Depende de:** [ADR-0013](0013-reconciliacion-del-motor-de-inventario.md)

## Contexto

Ventas y caja eran dos servicios planos, sin dominio y sin un solo test, escritos en
paralelo al resto del sistema. Atendían peticiones reales del punto de venta, así que no
eran prototipos: eran el código que cobraba a las clientas.

Tenían cuatro defectos de gravedad muy distinta.

### 1. Un segundo motor de inventario

`SalesService.create` descontaba existencias por su cuenta:

```ts
const balance = Number(product.stockOnHand) - line.quantity;
await prisma.product.update({ where: { id }, data: { stockOnHand: balance } });
await prisma.inventoryMovement.create({ ... });
```

Es el mismo patrón de lectura-suma-escritura que el ADR-0013 acababa de eliminar del módulo
de inventario, reintroducido aquí. Pero el problema mayor no es la pérdida de escrituras:
es que **no toca los lotes**. Un tinte con `tracksBatches` se vendía sin descontar de ningún
lote, con lo que la trazabilidad que exige el Reglamento (CE) 1223/2009 quedaba rota
precisamente en la operación que entrega el producto a la clienta —que es la única que
importa cuando hay una reacción adversa—. Además, `remainingQuantity` y `stockOnHand`
divergían desde la primera venta.

Dos motores de existencias en el mismo sistema, uno respetando los lotes y otro
saltándoselos, es la violación literal de la regla «nunca duplicar» del ADR-0002.

### 2. Dinero en coma flotante, con tolerancia confesa

```ts
const tax = (subtotal * Number(item.taxRate)) / 100;
if (Math.abs(total - paid) > 0.01) throw new ConflictException(...);
```

Esa tolerancia de un céntimo es la admisión de que las cifras no cuadraban. Un céntimo por
venta son decenas de quetzales al año que nadie sabe explicar, y en el arqueo de caja el
descuadre lo ve el usuario esa misma noche.

### 3. El arqueo se calculaba dos veces, en dos sitios

`CashService` computaba el efectivo esperado una vez al pintar la caja abierta y otra al
cerrarla, con dos trozos de código distintos. Basta con que uno de los dos olvide un tipo de
movimiento para que el arqueo cuadre en pantalla y no al cerrar —la peor combinación
posible, porque el descuadre aparece cuando ya no se puede investigar—.

### 4. Estados que no existían

Toda factura nacía `PAID`. No había cobro parcial, ni deudor, ni anulación, ni devolución.

## Decisión

### 1. La venta delega el inventario, no lo reimplementa

`RegisterSaleUseCase` llama a `ConsumeStockUseCase`, que el módulo de inventario exporta
justamente para esto. La venta obtiene FEFO real, coste por lote y descuento atómico sin
escribir una línea de lógica de existencias, y el movimiento del kardex queda apuntando a la
factura que lo originó.

Un producto con `trackStock = false` se salta el descuento: hay artículos que se facturan y
no se inventarían —un bono, una tarjeta regalo— y exigirles stock haría imposible venderlos.

### 2. Toda la aritmética en `Money`, sin tolerancias

El impuesto se aplica **después** del descuento: cobrar IVA sobre dinero que el cliente no
desembolsa es incorrecto. La comisión se calcula sobre la base imponible y nunca sobre el
total con impuesto, porque el IVA no es ingreso del salón sino dinero recaudado para
Hacienda, y pagar comisión sobre él sería pagar por recaudar.

El total del documento se obtiene **sumando los totales de línea**, no como
`subtotal + taxTotal`. Con varios tipos de IVA, redondear el impuesto una vez sobre la base
agregada puede dar un céntimo distinto que redondearlo línea a línea; lo que el cliente ve
desglosado en el papel son las líneas, y que el total case con ellas es lo que evita la
factura que el cliente rechaza.

La comparación entre lo cobrado y el total es exacta. `Money` cuadra o no cuadra.

### 3. Un solo sitio calcula el efectivo esperado

`CashSession.expectedAmount(cashSales)` vive en el agregado, y tanto la pantalla como el
cierre pasan por él. `cashSales` entra como parámetro porque los cobros pertenecen a las
facturas, no a la caja: incluirlos en el agregado obligaría a cargar todas las facturas del
día para abrir una pantalla.

Al cerrar, la cifra se **congela**. Recalcularla después daría un número distinto si alguien
anota algo, y el arqueo dejaría de ser un hecho histórico.

**El cierre no rechaza el descuadre.** El dinero que hay en el cajón es el que hay, y una
caja que solo se deja cerrar cuando cuadra acaba cuadrando siempre porque alguien ajusta el
recuento hasta que el sistema lo acepta —que es exactamente el dato que se quería medir—.

El importe de un movimiento se guarda siempre positivo y el sentido lo da el tipo. Un
`CASH_IN` negativo sería una salida disfrazada de entrada: el informe la contaría como
ingreso y el arqueo cuadraría ocultando justo lo que debería destacar. `CORRECTION` es la
única excepción, porque existe para cuadrar un descuadre conocido y puede ir en los dos
sentidos.

### 4. Estados completos, y un cobro es un hecho

`ISSUED → PARTIALLY_PAID → PAID`, con `OVERDUE` y `VOID`. El sobrepago se rechaza en lugar
de dejar saldo negativo: un cobro de más es casi siempre un error de tecleo, y admitirlo
convierte la factura en un vale a favor del cliente que nadie ha decidido emitir.

Una factura **con cobros no se anula**: primero se devuelve el dinero. Anularla dejando los
cobros en pie descuadraría la caja de ese día. Los cobros no se editan —se devuelven, total
o parcialmente—, igual que en el ledger de inventario y por el mismo motivo: lo que ocurrió
con el dinero es un hecho.

### 5. Numeración consecutiva y sin huecos

`DocumentNumberGenerator` es un puerto aparte porque la garantía que ofrece es de otra
naturaleza. El `upsert` con `increment` reserva el número en una sola sentencia dentro de la
transacción que crea la factura: si el documento no llega a existir, el contador vuelve
atrás y no queda hueco. Un salto entre la 41 y la 43 hay que explicarlo en una inspección;
un número repetido, más todavía.

### 6. Un módulo de persistencia para romper el ciclo

Ventas necesita caja —un cobro en efectivo se imputa a la sesión abierta— y caja necesita
los cobros —el arqueo cuadra el efectivo del día—. `SalesPersistenceModule` expone solo los
puertos de persistencia, de modo que ambos dependen de los mismos adaptadores y ninguno del
otro.

Se descartó `forwardRef`: haría compilar el ciclo sin eliminarlo, y un ciclo que compila
sigue siendo un ciclo cuando alguien intente entender quién depende de quién.

## Consecuencias

**Lo que se gana.** Una venta de producto trazado descuenta del lote que caduca antes y deja
el asiento apuntando a la factura y al lote —trazabilidad completa desde el ticket hasta el
envase—. Los importes cuadran sin tolerancia. El arqueo usa una sola fórmula. Existen el
cobro parcial, el deudor, la anulación y la devolución.

**Lo que cuesta.** Los dos módulos pasan de 8 archivos planos a 16 en capas, y una venta
abre más consultas dentro de su transacción. Es el precio de que la operación sea atómica y
quede auditada.

**Lo que no cambia.** El contrato HTTP. `POST /sales` recibe `lines` y `payments` con los
mismos nombres y la caja sigue devolviendo `openingFloat`, `cashSales`, `expectedAmount` y
`movements` planos sobre la sesión, que es como `apps/web` ya los leía.

**Cobertura.** Los dos módulos pasan de 0 a 81 tests: 59 de dominio y 22 de integración,
incluidos los que comprueban contra PostgreSQL real que la venta descuenta por FEFO y que el
índice único impide dos cajas abiertas a la vez.

## Alternativas descartadas

**Que la venta escriba el movimiento de inventario ella misma, pero bien.** Habría exigido
duplicar el reparto FEFO, el cálculo del coste por lote y el descuento atómico. Dos copias
de esa lógica divergen: basta con que una corrección se aplique en un sitio y no en el otro
para volver al punto de partida.

**Un evento de dominio `VentaRegistrada` que el inventario escuche.** Desacopla más y
rompe la atomicidad: entre emitir la factura y descontar el stock habría una ventana en la
que el sistema dice haber vendido algo que sigue en la estantería. Cuando haya cola de
mensajes con garantías transaccionales será revisable; hoy la llamada directa dentro de una
transacción es lo correcto.

**Permitir anular una factura cobrada, revirtiendo los cobros automáticamente.** Más cómodo
y más peligroso: la reversión automática de un cobro en efectivo tendría que decidir por su
cuenta de qué sesión de caja sale el dinero, y esa decisión es de quien está en el
mostrador. Se exige devolver primero y anular después, que son dos actos deliberados.

**Guardar el importe de los movimientos de caja con signo.** Parecía más simple. Abre la
puerta a un `CASH_IN` negativo, y un informe que suma entradas por tipo contaría una salida
como ingreso.
