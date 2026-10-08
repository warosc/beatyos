# ADR-0021: Precios con IVA incluido

- **Estado:** Aceptado
- **Fecha:** 2026-10-08
- **Cumple:** [ADR-0010](0010-dinero-y-precision-decimal.md)
- **Enmienda:** [ADR-0014](0014-ventas-cobros-y-arqueo-de-caja.md) §2, en cómo se obtiene el impuesto de una línea

## Contexto

El catálogo guardaba el precio **sin** IVA y la factura sumaba el impuesto encima. Para la
dueña el precio de un producto o servicio es lo que paga la clienta, así que las pantallas
de alta convertían lo que ella escribía en una base sin IVA. Eso tenía tres problemas:

- **No todo precio era cobrable.** Con el 12 %, ninguna base de dos decimales da Q45.50
  (40.62 da 45.49 y 40.63 da 45.51). La pantalla tenía que avisar de que se ajustaba un
  céntimo, y lo que se escribía no era lo que se cobraba.
- **Los descuentos se guardaban sin IVA.** Un descuento de Q10 en caja había que traducirlo
  a una base, y el cuadre de caja y el historial mostraban Q8.93 de descuento donde la
  clienta había dejado de pagar Q10.
- **El inventario mostraba un precio y la caja otro** cuando un producto se daba de alta
  sin pasar por esa conversión.

## Decisión

### 1. `price` es lo que paga la clienta

En productos, servicios y líneas de cita, `price` lleva el IVA dentro. En las líneas de
factura, `unitPrice` y `discountAmount` también. `taxRate` se conserva: es el dato interno
con el que se separa el impuesto.

### 2. El IVA se separa del total, no se suma a la base

`buildInvoiceLine` calcula, en este orden:

1. `lineTotal = unitPrice × quantity − discountAmount` — lo que paga la clienta;
2. `taxAmount = lineTotal − redondeo(lineTotal / (1 + tasa))` — `Money.includedTax`;
3. `lineSubtotal = lineTotal − taxAmount` — la base imponible.

Se mantiene lo esencial del ADR-0014 §2: el impuesto recae solo sobre lo que la clienta
desembolsa (el descuento se resta antes), la comisión se calcula sobre la base imponible y
el total del documento es la suma de los totales de línea. Lo que cambia es que el total de
la línea ya no depende de qué bases existen: cualquier importe en céntimos es cobrable.

### 3. Margen sobre el precio sin IVA

El coste de compra va sin IVA, así que el margen de un producto se mide contra
`price − IVA incluido`. Medirlo contra el precio con IVA lo inflaría.

### 4. Migración de los datos existentes

`20261008120000_prices_include_tax` suma a cada precio guardado el IVA que se le aplicaba,
con la misma regla de redondeo, de modo que ningún importe cambia para la clienta. En las
ventas ya emitidas no se tocan total, IVA, base ni comisiones: solo se reexpresan con IVA el
precio unitario y el descuento (precio de lista con IVA menos lo pagado).

## Consecuencias

- La dueña escribe un precio y ese es, al céntimo, el que ve en inventario y el que se
  cobra en caja. Las pantallas ya no reparten base e impuesto.
- Caja, comprobante, cuadre e historial muestran descuentos con IVA, como los vivió la
  clienta. El IVA aparece como «IVA incluido», no como un sumando.
- `priceWithTax` en la respuesta de servicios es ahora igual a `price`. Se conserva para no
  romper a quien lo lee.
- En ventas antiguas con cantidad mayor que uno, `unitPrice × quantity − discountAmount`
  puede diferir un céntimo de `lineTotal` por el redondeo con que se emitieron. El total
  guardado es el que vale, y ningún cálculo vuelve a derivarlo de esos campos.
