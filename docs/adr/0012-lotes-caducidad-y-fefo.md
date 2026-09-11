# ADR-0012: Lotes, caducidad y consumo FEFO

- **Estado:** Aceptado
- **Fecha:** 2026-09-02
- **Modifica:** [ADR-0011](0011-inventario-y-consistencia.md), que dejaba los lotes fuera de alcance

## Contexto

El ADR-0011 declaró los lotes «deuda consciente para v2» y eligió **media móvil ponderada**
como método de coste. Esa decisión se toma ahora explícitamente porque el producto los
necesita, y conviene decir por qué el motivo no es de conveniencia sino de seguridad.

Un salón de belleza no vende cajas de tornillos. Maneja:

- **tintes y decolorantes** con fecha de caducidad y número de lote impresos en el envase,
- **productos químicos** cuya eficacia y seguridad dependen de esa fecha,
- **cosmética** sujeta al Reglamento (CE) 1223/2009, que obliga a poder **trazar el lote**
  de un producto que provoque una reacción adversa.

Aplicar un tinte caducado no es un problema contable: es una reacción alérgica en el cuero
cabelludo de una clienta, y la obligación de decir exactamente qué lote se usó.

## Decisión

### 1. El lote es una entidad, no un campo

`ProductBatch` guarda número de lote, caducidad, cantidad recibida, cantidad restante,
coste unitario y proveedor. Un producto tiene tantos lotes como recepciones haya tenido.

**El seguimiento por lote es opcional por producto** (`Product.tracksBatches`). Un secador
de pelo no caduca y obligar a darle lote sería burocracia pura; un tinte sí. La distinción
la hace quien da de alta el producto, no el sistema.

### 2. Consumo FEFO, no FIFO

**First Expired, First Out**: se consume primero el lote que **caduca antes**, no el que
llegó antes.

Parece un matiz y no lo es. FIFO ordena por fecha de recepción; si un pedido reciente trae
producto con caducidad más corta —cosa habitual cuando el proveedor liquida existencias—,
FIFO lo deja al fondo y ese lote caduca en la estantería. FEFO lo saca primero. En un
sector donde la caducidad es el criterio que importa, **FIFO minimiza la antigüedad
contable y FEFO minimiza el desperdicio real**.

Como desempate, a igualdad de caducidad se consume el lote recibido antes.

### 3. El coste pasa a ser real por lote

Aquí es donde este ADR modifica al 0011. Con lotes, cada salida conoce **el coste exacto
del lote del que sale**, así que no hace falta promediar: el margen de un servicio deja de
ser una estimación.

- Productos **con lote**: coste real del lote consumido.
- Productos **sin lote**: se mantiene la media móvil ponderada del ADR-0011.

Conviven los dos métodos a propósito. La alternativa —forzar lotes en todo— cargaría al
salón con trabajo administrativo para productos donde el coste medio es perfectamente
adecuado.

`Product.costPrice` sigue existiendo como **coste de referencia** para valoración rápida y
para productos sin lote. Con lotes, la verdad está en el lote.

### 4. Un lote caducado se bloquea, no se avisa

Consumir de un lote caducado **falla**. No es un aviso que se pueda ignorar con un clic.

Se puede forzar, pero exige el permiso `inventory.adjust`, un motivo escrito, y queda en
la auditoría con el lote y la fecha. La diferencia entre un aviso y un bloqueo con salida
de emergencia es quién asume la decisión: con un aviso, la asume quien tiene prisa; con un
bloqueo, alguien que puede responder por ella.

### 5. El stock sigue siendo un dato derivado

No cambia respecto al ADR-0011. La verdad es el ledger de movimientos; `Product.stockOnHand`
es caché, y ahora también lo es la suma de `remainingQuantity` de los lotes vivos. El job
de conciliación comprueba **las tres** cifras y alerta ante cualquier discrepancia.

## Consecuencias

**Positivas**

- Trazabilidad completa: de una reacción adversa se llega al lote, al proveedor y a la
  fecha de recepción.
- El margen por servicio deja de ser aproximado en los productos que más cuestan.
- El desperdicio por caducidad baja porque el sistema saca primero lo que va a caducar.

**Negativas**

- **Más trabajo en la recepción de mercancía**: hay que teclear lote y caducidad. Es real y
  no se puede disimular; se mitiga permitiendo desactivar el seguimiento por producto.
- Una tabla más que crece con cada recepción. Los lotes agotados se archivan, no se borran:
  la trazabilidad los necesita años después.
- El cálculo de coste deja de ser una multiplicación y pasa a ser un reparto entre lotes.
  Una salida puede consumir de varios, y cada tramo lleva su propio coste.

## Alternativas descartadas

- **FIFO puro.** Estándar contable habitual, pero optimiza la antigüedad y no la
  caducidad. En este sector deja lotes a punto de vencer al fondo de la estantería.
- **LIFO.** No lo admite la normativa contable europea, y para producto perecedero es
  directamente perverso.
- **Solo media ponderada, con la caducidad como aviso.** Es lo más barato de construir y
  fue la opción del ADR-0011. Se descarta al entrar en alcance la trazabilidad: un aviso no
  permite responder «¿qué lote se le aplicó a esta clienta el 3 de marzo?».
- **Lotes obligatorios en todos los productos.** Uniforme y más simple de implementar, pero
  convierte dar de alta unas horquillas en un trámite con número de lote y fecha de
  caducidad. El sistema dejaría de usarse tal cual está diseñado.
