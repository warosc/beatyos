# ADR-0018: Comisiones por profesional y metas con recompensa

- **Estado:** Aceptado
- **Fecha:** 2026-09-11
- **Cumple:** [ADR-0001](0001-arquitectura-hexagonal.md), [ADR-0006](0006-autorizacion-rbac.md), [ADR-0010](0010-dinero-y-precision-decimal.md), [ADR-0015](0015-informes-e-indicadores.md)
- **Depende de:** [ADR-0014](0014-ventas-cobros-y-arqueo-de-caja.md)

## Contexto

Dos peticiones de la propietaria llegaron juntas y comparten la misma cifra de origen —lo
que una profesional factura—, así que se resuelven con el mismo ADR: **pagar una comisión
por servicio o producto vendido**, y **premiar con un objetivo de facturación** cuando se
cumple. Ninguna de las dos existía; no había ni una columna de comisión en la base ni un
concepto de meta en el dominio.

## Decisión

### 1. La comisión es un dato del profesional, no un módulo aparte

`Stylist` gana `commissionRate` (tarifa general) y cada entrada de `skills[]` puede traer
su propia `commissionRate` opcional. No hace falta una tabla ni un agregado nuevos: una
comisión no tiene ciclo de vida propio, es un porcentaje que la propietaria ajusta desde la
misma ficha donde ya edita horario y habilidades.

### 2. Cascada de tres niveles, resuelta por el agregado

`stylist.commissionFor(serviceId, serviceCommission)` decide, en este orden: la comisión de
la habilidad si existe → la del servicio si existe → la general de la profesional. Vive en
`Stylist` porque es la profesional quien tiene la última palabra sobre su propia tarifa; el
servicio solo propone un valor por defecto para cuando ella no ha fijado nada más específico.

Un producto no tiene habilidad que ajustarlo, así que usa directamente la tarifa general —
no hay cascada que recorrer.

### 3. Sin profesional asignado no hay comisión

Una línea de venta sin `stylistId` no calcula tarifa alguna. Devengar una comisión sin saber
a quién pagársela crea un pasivo sin destinatario, y no hay forma de corregirlo después sin
adivinar quién debería haberla cobrado.

### 4. La comisión se congela en la línea, igual que el precio y el impuesto

`RegisterSaleUseCase` resuelve `commissionRate` una vez, al emitir, y la escribe en
`InvoiceLine`. Es el mismo principio que ya aplican precio e impuesto (ADR-0014): si la
propietaria cambia la tarifa general de una profesional mañana, las facturas de hoy no
deben recalcularse solas. La comisión que se muestra en un reporte histórico es la que
regía cuando se hizo la venta.

### 5. Las metas son un módulo propio, y el progreso no se guarda

`goals/` sigue la misma estructura de dominio/aplicación/infraestructura que el resto.
`Goal` no es una plantilla recurrente: cada periodo que se quiere premiar es una fila nueva,
con su métrica (`SERVICE_REVENUE` o `PRODUCT_REVENUE`), su objetivo en `Money` y la
descripción de la recompensa.

El progreso **no se persiste como contador**. Se calcula al vuelo sumando las líneas de
venta de la profesional dentro del periodo — el mismo enfoque que ya usan los indicadores
del ADR-0015, y por el mismo motivo: no hay un contador que desincronizar, y una venta
anulada deja de contar sin que nadie tenga que corregir nada a mano.

### 6. `achievedAt` es de una sola dirección

La primera vez que el progreso alcanza el objetivo se fija `achievedAt` y se persiste. Una
anulación posterior puede bajar la cifra «real», pero la meta sigue marcada como cumplida:
la recompensa, si se entregó, ya se entregó, y retirarla porque una venta se anuló después
sería penalizar a la profesional por algo que no depende de ella. `markAchieved` es
idempotente para que recalcular el progreso en cada lectura nunca la «des-cumpla».

### 7. Ámbito propio para consultar, ajeno para administrar

`goals.read.own` deja que cada profesional vea sus propias metas — con el filtro impuesto
por el servidor, no por lo que la petición pida, igual que el resto de rutas `.own` del
proyecto (ADR-0006). Crear, listar todas y cancelar una meta exige `goals.create` /
`goals.read` / `goals.delete` completos: es una herramienta de la propietaria para motivar
al equipo, no algo que una profesional se asigne a sí misma.

### 8. El trofeo es una lectura de `statusAt(now)`, no un estado guardado

`ACTIVE` / `ACHIEVED` / `EXPIRED` se calculan comparando `achievedAt` y `periodEnd` contra
la hora actual en el momento de pintar, igual que el resto de estados derivados del
proyecto. Nada en la base dice «expirada»: lo dice la fecha, y la interfaz colorea el
trofeo en consecuencia.

## Consecuencias

**Lo que se gana.** Una comisión que se puede ajustar por profesional y afinar por servicio
sin migrar nada cuando cambie, con seis meses de facturas históricas que no se alteran
retroactivamente. Un sistema de metas que no arrastra un contador que mantener y que no
puede quedar en un estado inconsistente por una venta anulada fuera de orden.

**Lo que cuesta.** El progreso de una meta recorre las líneas de venta del periodo en cada
lectura en lugar de leer un entero; es aceptable con el volumen de un salón y es el mismo
trueque que ya acepta el resto de indicadores (ADR-0015).

## Alternativas descartadas

**Un módulo `commissions/` separado, con su propia tabla.** La comisión no tiene invariantes
ni transiciones propias — es un porcentaje y una cascada de precedencia. Separarlo en un
agregado aparte habría exigido sincronizarlo con `Stylist` sin ganar nada a cambio.

**Recalcular la comisión al generar el reporte, en vez de congelarla en la línea.** Es
consistente con el resto del sistema (precio e impuesto se congelan) que no lo sea la
comisión: un reporte de comisiones de un mes cerrado cambiaría cada vez que alguien tocara
la ficha de una profesional.

**Un contador de progreso en `Goal`, actualizado en cada venta.** Exige que
`RegisterSaleUseCase` conozca las metas activas de la profesional y las actualice dentro de
la misma transacción, acoplando dos módulos que hoy no se conocen. Sumar al vuelo evita el
acoplamiento al precio de una consulta más al leer, no al vender.
