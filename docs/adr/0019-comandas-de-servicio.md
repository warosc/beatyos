# ADR-0019: Comandas de servicio: la estilista declara, caja cobra

- **Estado:** Aceptado
- **Fecha:** 2026-09-28
- **Cumple:** [ADR-0001](0001-arquitectura-hexagonal.md), [ADR-0006](0006-autorizacion-rbac.md), [ADR-0010](0010-dinero-y-precision-decimal.md)
- **Depende de:** [ADR-0014](0014-ventas-cobros-y-arqueo-de-caja.md), [ADR-0018](0018-comisiones-y-metas-de-profesional.md)

## Contexto

La propietaria pide separar dos responsabilidades que hoy se mezclan en el punto de venta:
la estilista termina un servicio y **declara** qué le hizo a la clienta, y la persona de
caja **cobra**. Los servicios que la estilista puede declarar los configura antes la
administración. Hasta ahora, o cobraba la propia estilista desde `/ventas` —mezclando
quien hace el trabajo con quien recibe el dinero—, o recepción tenía que enterarse de
palabra de qué cobrar.

## Decisión

### 1. Un agregado nuevo, `ServiceTicket` (comanda), y no una factura en borrador

La comanda guarda profesional, clienta, cita opcional y servicios. **No guarda precios.** Se
descartó reutilizar `Invoice` en estado `DRAFT` porque una factura consume número de la
serie fiscal, que no admite huecos (ADR-0014): cada comanda anulada dejaría un salto.

Estados: `PENDING → CHARGED` (con `invoiceId`) o `PENDING → CANCELLED` (con motivo). Solo
una comanda pendiente cambia; lo cobrado se corrige anulando la factura por su cauce.

### 2. Cobrar una comanda **es** una venta

`ChargeServiceTicketUseCase` traduce la comanda a líneas de servicio con `stylistId` y llama
a `RegisterSaleUseCase`. Precio, impuesto, comisión de la profesional (cascada del
ADR-0018), cobro en efectivo contra la caja abierta y visita en la ficha salen idénticos a
los de mostrador. `RegisterSaleUseCase.execute` acepta un paso `withinTransaction` que corre
en su misma unidad de trabajo: ahí se marca la comanda cobrada, de modo que factura y
comanda se confirman o se revierten juntas.

### 3. El importe que ve caja sale de la misma regla que la factura

El listado calcula cada línea con `buildInvoiceLine`, la función que usa la factura. Lo que
caja ve es exactamente lo que se le pedirá cobrar; si el precio cambió entre la vista y el
cobro, la venta rechaza el pago con `PAYMENT_TOTAL_MISMATCH` y caja refresca.

### 4. Solo servicios preparados por la administración

Al registrar, cada servicio debe estar activo y, si la estilista tiene habilidades
asignadas (`StylistService`), estar entre ellas. Es la regla `Stylist.canPerform` que ya
usa la agenda. La pantalla de Comisiones gana «Servicios por estilista» para asignarlas.

### 5. Permisos con ámbito propio

| Permiso | Recepción | Encargada | Estilista |
| ------- | :-------: | :-------: | :-------: |
| `service-tickets.read` | ✓ | ✓ | |
| `service-tickets.read.own` | | | ✓ |
| `service-tickets.create` | ✓ | ✓ | |
| `service-tickets.create.own` | | | ✓ |
| `service-tickets.cancel` | ✓ | ✓ | |
| `service-tickets.cancel.own` | | | ✓ |

Cobrar exige `service-tickets.read` + `invoices.create` + `payments.create`: la estilista
declara pero no cobra desde la comanda.

### 6. Concurrencia e invariantes

`update` escribe con `WHERE status = 'PENDING'`; dos cajas cobrando a la vez provocan que la
segunda falle con `SERVICE_TICKET_NOT_PENDING` y su factura se revierta. En base:
una comanda no anulada por cita (índice único parcial), `CHARGED ⇒ invoiceId` y
`CANCELLED ⇒ cancellationReason`.

## Consecuencias

- Registrar desde una cita la completa en la misma transacción. Anular después la comanda
  no reabre la cita: el estado `COMPLETED` es terminal.
- Si un servicio se retira del catálogo con comandas pendientes, estas no se pueden cobrar;
  caja las anula y la estilista las registra de nuevo.
- Caja y la estilista se enteran por sondeo (20–30 s), no por notificación push. Suficiente
  para un mostrador; un canal en tiempo real queda fuera de alcance.

## Alternativas descartadas

- **Factura `DRAFT`**: consume numeración fiscal (ver 1).
- **Congelar precio en la comanda**: habría dos documentos con precio y la posibilidad de que
  discrepen; el que tiene que sobrevivir a un cambio de tarifa es la factura.
- **Anidar unidades de trabajo**: el puerto `UnitOfWork` no promete reentrada; el paso
  `withinTransaction` hace explícito qué corre dentro.
