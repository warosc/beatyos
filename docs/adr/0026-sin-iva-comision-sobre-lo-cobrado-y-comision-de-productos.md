# ADR-0026: Sin IVA en el cobro, comisión sobre lo que paga la clienta y comisión de productos

- **Estado:** Aceptado
- **Fecha:** 2026-11-03
- **Enmienda:** [ADR-0021](0021-precios-con-iva-incluido.md) (el IVA de venta pasa a ser cero), [ADR-0018](0018-comisiones-y-metas-de-profesional.md) §2 (base y porcentaje de la comisión), [ADR-0014](0014-ventas-cobros-y-arqueo-de-caja.md) §2 (la comisión ya no va sobre la base imponible)

## Contexto

La dueña dejó de cobrar IVA a sus clientas. Con el sistema como estaba:

- **La comisión salía más baja de lo pactado.** Se calculaba sobre la base sin IVA: si la
  clienta pagaba Q30 por un servicio con comisión del 20 %, la profesional ganaba Q5.36 y no
  Q6.00. Para el salón ya no hay IVA que descontar.
- **Los formularios hablaban de un IVA que no existe.** «Q 26.79 para el salón + Q 3.21 de
  IVA» confundía a la dueña, que piensa en lo que cobra.
- **Un producto vendido usaba el % de servicios de la profesional.** No había forma de
  pactar otro porcentaje para productos (el habitual es un 10 %), y en los informes las dos
  comisiones salían sumadas en una sola cifra.
- **Al cerrar la caja no se veía cuánto pagar a cada una.** Las comisiones se pagan a diario
  al cerrar, y había que sacarlas del informe ejecutivo a mano.

## Decisión

### 1. El salón no cobra IVA

- `services.taxRate` y `products.taxRate` pasan a 0 en todos los salones (migración
  `20261103120000_remove_sales_tax`) y su valor por defecto es 0, también en el dominio.
- La API deja de aceptar `taxRate` al crear o editar servicios y productos: con
  `forbidNonWhitelisted`, nadie puede volver a meter un IVA de venta por error. Las
  respuestas lo siguen trayendo (siempre 0) por compatibilidad.
- Las facturas ya emitidas conservan su IVA: son el registro de lo que se cobró. El recibo
  solo muestra «IVA incluido» si la venta lo lleva.
- **Las compras sí llevan IVA.** El proveedor lo cobra y la orden tiene que cuadrar con su
  factura, así que una línea de compra sin tipo indicado usa el 12 % fijo del proveedor, no
  el tipo de venta del producto.

### 2. La comisión es un porcentaje de lo que paga la clienta

`buildInvoiceLine` calcula `commissionAmount = lineTotal × %`, después del descuento: Q30 al
20 % son Q6.00. Las metas se miden sobre la misma base. Solo afecta a las ventas nuevas: las
comisiones ya guardadas no se recalculan.

### 3. Comisión de productos

- Cada profesional tiene **% en servicios** (`stylists.commissionRate`, la de siempre) y
  **% en productos** (`stylists.productCommissionRate`, 10 % al empezar).
- Un producto puede tener una **comisión especial** (`products.commissionRate`) que manda
  sobre el % en productos, igual que la de un servicio manda sobre el % en servicios.
- Solo generan comisión los productos **cobrados en una venta con la profesional
  asignada**. Los insumos que se gastan en cabina no son líneas de venta y nunca dan
  comisión. Una línea sin profesional tampoco.

### 4. Servicios y productos nunca se suman en los informes

El rendimiento por profesional separa lo vendido, las unidades y la comisión de servicios y
de productos. El informe ejecutivo muestra los dos totales por separado.

### 5. Comisiones a pagar al cerrar la caja

`GET /sales/summary` trae, para el periodo del turno, la comisión de servicios, la de
productos y el total de cada profesional (`commissions`). El resumen del turno, el diálogo
de cierre y el corte impreso de 80 mm la muestran. Es **informativo**: no registra ningún
movimiento ni cambia el efectivo esperado. Cuenta las mismas facturas que el resumen (todas
menos anuladas y borradores).

## Consecuencias

- Con los mismos precios, el salón ya no separa el 12 % y las comisiones suben en esa
  proporción. Hay que avisar a las dueñas antes de actualizar.
- Lo vendido por profesional y el progreso de las metas se miden sobre el total: un periodo
  anterior a este cambio no se compara directamente con uno posterior.
- El margen de un producto se mide contra su precio de venta. Si el salón ya no puede
  acreditar el IVA de sus compras, el margen real es menor que el mostrado; es una decisión
  contable que el sistema no toma.
- Las ventas con tarjeta o transferencia hechas con la caja cerrada no caen en ningún turno
  y no aparecen en ningún cierre, aunque sí en el informe ejecutivo.
- Volver a cobrar IVA exige una migración inversa y devolver `taxRate` a los formularios.

## Alternativas descartadas

- **Un interruptor por salón.** Era lo más flexible, pero se decidió quitarlo para todos:
  ningún salón lo cobra hoy y un interruptor deja dos caminos de cálculo que probar siempre.
- **Seguir calculando la comisión sobre la base imponible.** Con el IVA a cero da lo mismo
  en las ventas nuevas, pero dejaba la regla escrita al revés de como se paga y fallaría en
  cuanto quedara un servicio con tipo distinto de cero.
- **Registrar el pago de comisiones como salida de caja al cerrar.** Se descartó por ahora:
  la dueña decide de dónde salen, y una salida automática descuadraría el efectivo cuando
  las paga de otra forma.
