# ADR-0020: Anulación de ventas cobradas con reversa

- **Estado:** Aceptado
- **Fecha:** 2026-09-30
- **Cumple:** [ADR-0006](0006-autorizacion-rbac.md), [ADR-0010](0010-dinero-y-precision-decimal.md), [ADR-0013](0013-reconciliacion-del-motor-de-inventario.md)
- **Enmienda:** [ADR-0014](0014-ventas-cobros-y-arqueo-de-caja.md) §4 y su alternativa rechazada «Permitir anular una factura cobrada, revirtiendo los cobros automáticamente»

## Contexto

El ADR-0014 decidió que una factura con cobros no se anula: primero se devuelve el dinero.
La regla era correcta, pero el cauce para devolver nunca llegó a existir. `Payment.refund()`
estaba en el dominio y ningún caso de uso ni endpoint lo usaba, así que, en la práctica,
**una venta cobrada no se podía corregir**. Con el punto de venta en uso, un cobro a la
clienta equivocada o un servicio mal marcado dejaba un descuadre permanente en ventas,
comisiones, metas y caja.

El ADR-0014 rechazó revertir cobros automáticamente por una razón concreta: la reversión de
un cobro en efectivo tendría que decidir por su cuenta **de qué sesión de caja sale el
dinero**, y esa decisión es de quien está en el mostrador.

## Decisión

### 1. Una sola operación deliberada, solo de la propietaria

`POST /sales/:id/void` con motivo obligatorio anula la venta y deshace lo que hizo. Exige
`invoices.void`, que sigue siendo exclusivo de la propietaria (la encargada no lo tiene: es
una de las palancas con las que se tapa un descuadre).

### 2. Devolver y luego anular, dentro de la misma transacción

Se mantiene el invariante del ADR-0014: `Invoice.void()` sigue rechazando una factura con
dinero cobrado. El caso de uso primero devuelve cada cobro (`Payment.refund`, y
`Invoice.registerRefund` baja lo cobrado) y después anula. Son los dos actos que pedía el
ADR-0014, encadenados en una unidad de trabajo para que no pueda quedar uno sin el otro.

### 3. El efectivo sale siempre de la caja abierta

Es la respuesta a la objeción del ADR-0014. No hay decisión automática que tomar: el
efectivo se entrega desde el cajón que está abierto, que es el que tiene delante quien lo
devuelve. La pantalla lo dice antes de confirmar. **Sin caja abierta no se anula una venta
con cobros en efectivo** (`CASH_REFUND_REQUIRES_OPEN_SESSION`).

La devolución se anota como movimiento de tipo `REFUND` en esa caja, con el número de la
venta como referencia, y se valida contra todo lo que debería haber en el cajón (fondo,
ventas en efectivo y movimientos). No se registra a mano (`REFUND_REQUIRES_VOID`): un
movimiento suelto dejaría la venta contando en ventas, comisiones y metas.

Para que la devolución no se cuente dos veces, `cashTotalForSession` pasa a sumar lo
**cobrado bruto** de la sesión, sin restar devoluciones. Así una caja ya cerrada nunca cambia
a posteriori: su arqueo sigue diciendo lo que se cobró y se contó aquel día, y la devolución
aparece en la caja de donde salió el dinero. Antes de esta decisión no existía ninguna
devolución en los datos, de modo que el cambio no altera cifras históricas.

### 4. Tarjeta y transferencia quedan devueltas; el reembolso va por su medio

Los cobros sin efectivo pasan a `REFUNDED` y el resumen del periodo los muestra como
devueltos por método (por `refundedAt`). El reembolso real se hace en el datáfono o por
transferencia; la aplicación no habla con el banco.

### 5. El stock vuelve a los mismos lotes

`ReturnSaleStockUseCase` lee los asientos `SALE_OUT` que dejó la venta y repone cada lote con
lo que salió de él, anotando `RETURN_IN` con el mismo coste. Guiarse por los asientos y no
por las líneas evita repartir otra vez por FEFO, que devolvería el género a otro lote y
rompería la trazabilidad.

### 6. Lo demás se ajusta solo o se documenta

- Reportes, comisiones y avance de metas ya excluyen las facturas `VOID`. Una meta ya
  alcanzada no se revierte (ADR-0018 §6).
- La clienta pierde la visita y el gasto (`Client.revertVisit`). `lastVisitAt` no retrocede:
  la fecha anterior no se guarda.
- La cita queda libre (`appointmentId` a nulo) para poder cobrarse otra vez. La relación
  queda en la auditoría.
- La comanda de la estilista, si la hubo, sigue `CHARGED` (ADR-0019): se corrige anulando la
  factura, no reabriendo la comanda. Si hay que volver a cobrar, se hace desde Ventas.

## Fuera de alcance

Devoluciones parciales, anular una sola línea y notas de crédito. La serie `CREDIT_NOTE`
existe en el esquema, pero comparte el prefijo `F-` de las facturas y habría que separarla
antes de usarla.

## Consecuencias

- Una venta cobrada por error se corrige en un paso y deja rastro completo en la auditoría:
  motivo, cobros devueltos, caja usada, lotes repuestos y cita liberada.
- El arqueo distingue una devolución de un gasto o una retirada.
- Anular una venta en efectivo obliga a tener la caja abierta. Es deliberado: el dinero tiene
  que salir de algún cajón concreto.
