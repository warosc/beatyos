# ADR-0015: Informes e indicadores

- **Estado:** Aceptado
- **Fecha:** 2026-09-03
- **Cumple:** [ADR-0001](0001-arquitectura-hexagonal.md), [ADR-0010](0010-dinero-y-precision-decimal.md)
- **Depende de:** [ADR-0013](0013-reconciliacion-del-motor-de-inventario.md), [ADR-0014](0014-ventas-cobros-y-arqueo-de-caja.md)

## Contexto

`ReportsService` era el último módulo plano: dos métodos, sin dominio y sin un solo test,
alimentando la pantalla que se abre nada más entrar al sistema.

Un informe tiene una propiedad incómoda: **nadie revisa sus cifras**. Un error en una
factura lo detecta el cliente; un error en el gráfico de ventas diarias no lo detecta nadie
hasta que alguien lo contrasta con la caja, meses después.

Tenía tres defectos, y el primero llevaba en producción desde el primer día.

### 1. Los días se agrupaban en UTC

```ts
const key = invoice.issuedAt!.toISOString().slice(0, 10);
```

Guatemala es UTC−6. Una venta de las 19:00 del día 5 ocurre a las 01:00 UTC del día 6, de
modo que **toda la facturación posterior a las 18:00 locales se contabilizaba en el día
siguiente**. En un salón, la franja de tarde es buena parte del total: el gráfico mostraba
lunes flojos porque el domingo se había comido su facturación, y el cierre de mes cortaba
por un sitio que no era medianoche.

El mismo fallo estaba en el cálculo de ocupación, que usaba `getUTCDay()` para decidir qué
horario aplicaba a cada día. Con seis horas de desplazamiento, un tramo de madrugada se leía
con el día de la semana equivocado y a un lunes se le asignaba el horario del domingo.

### 2. Tercera copia del cálculo de caja

`dashboard()` calculaba el efectivo esperado con su propia fórmula. Sumando la de la pantalla
de caja y la del cierre, la misma cuenta estaba escrita **tres veces**. Basta con que una
olvide un tipo de movimiento para que el panel y el arqueo den cifras distintas sin que nadie
sepa cuál creer.

### 3. Dinero en coma flotante

`Number(invoice.total)`, sumas acumuladas y `toFixed(2)` al final. En un agregado de cientos
de facturas, el error se acumula antes de redondear.

Además el módulo cargaba en memoria todas las facturas del periodo **con sus líneas y las
relaciones anidadas** para acabar sumando dos campos de cada una, y la moneda estaba
codificada como `'GTQ'`.

## Decisión

### 1. Los cálculos son funciones puras sobre hechos

`reporting.ts` no toca la base de datos: entran `SaleFact`, `SaleLineFact`,
`AppointmentFact` y `ScheduleFact` —con el dinero ya en `Money`— y sale un informe. Por eso
se prueban con datos escritos a mano en lugar de sembrar un año de ventas, y por eso el
fallo de zona horaria se puede fijar en un test de tres líneas.

El puerto `ReportingRepository` devuelve esos hechos y no filas. Su forma la dicta la
pregunta —«cuánto se ha vendido este mes»— y no el agregado: reutilizar
`InvoiceRepository.search` obligaría a paginar y rehidratar facturas completas con sus líneas
para acabar sumando un campo de cada una.

### 2. Los días son días **del salón**

`instantToCalendarDay(instant, timeZone)` para agrupar y `dayOfWeekInZone` para la
capacidad. La serie diaria se recorre **por días de calendario**, no sumando 24 horas: en un
cambio de hora un día dura 23 o 25, y avanzar en milisegundos acabaría saltándose una jornada
o repitiéndola.

La respuesta incluye `timeZone` y `period`. Un dato como «retención del 34 %» no significa
nada sin saber sobre qué ventana se ha medido.

### 3. Una sola fórmula para el efectivo esperado

El panel pide la caja a `GetCurrentCashSessionUseCase`, que pasa por
`CashSession.expectedAmount`. `CashModule` exporta el caso de uso además del puerto
precisamente para que nadie tenga la tentación de repetir la cuenta (ADR-0002).

Hay un test de integración que compara el `expected` del panel con el `expectedAmount` de la
caja: si alguien vuelve a duplicar la fórmula, ese test los separa.

### 4. La facturación del profesional es la base imponible

El impuesto no es ingreso del salón sino dinero recaudado para Hacienda, así que no es
rendimiento de nadie. Además es la misma base sobre la que se calcula la comisión, y mezclar
las dos magnitudes daría un porcentaje aparente distinto del pactado.

La cifra global de ventas sí lleva el impuesto, porque ahí lo que se mide es lo que entró por
caja. Son dos magnitudes distintas a propósito, y el informe las nombra por separado.

Solo se atribuyen líneas de **servicio**: un producto que la recepcionista adjunta al ticket
no es trabajo de quien atendió, y atribuírselo inflaría su cifra con ventas que no ha hecho.

### 5. Detalles que evitan informes engañosos

- **La serie diaria va completa**, con los días sin ventas a cero. Omitirlos haría que un
  gráfico de líneas uniera el lunes con el jueves en recta y aparentara una caída suave donde
  hubo tres días cerrados.
- **Los rankings desempatan por nombre.** Sin desempate, dos productos con las mismas ventas
  bailan de posición entre recargas sin que nada haya cambiado.
- **La ocupación se recorta al 100 %.** Un solapamiento heredado puede dar 103 %, y una
  ocupación superior al total es una cifra que nadie sabe interpretar.
- **El ticket medio sin ventas es cero, no `NaN`.** Una división por cero que llega a la
  interfaz se pinta como «NaN Q» y quien lo ve piensa que el sistema está roto.
- **El rango máximo es de 366 días.** Un informe sin límite acaba pidiendo el histórico
  entero, y esa consulta tumba la base en el momento en que alguien la lanza desde el móvil un
  sábado.
- **Las citas se filtran por solapamiento**, no por hora de inicio: una que empieza a las
  23:30 y acaba a las 00:30 pertenece a los dos días.

## Consecuencias

**Lo que se gana.** El gráfico de ventas diarias deja de estar desplazado un día para las
tardes. La ocupación aplica el horario correcto. El panel y el arqueo no pueden discrepar.
Los importes son exactos. Las consultas piden solo las columnas que se usan.

**Lo que cuesta.** El módulo pasa de 2 archivos a 6. El informe ejecutivo lanza cuatro
consultas en lugar de tres, aunque en paralelo.

**Un cambio de significado.** La facturación por profesional ahora es sin IVA, así que las
cifras serán menores que en la versión anterior. Es la corrección de un error, no una
regresión: antes se le atribuía a cada persona un impuesto que el salón solo recauda.

**Cobertura.** El módulo pasa de 0 a 44 tests: 32 de dominio y 12 de integración.

## Alternativas descartadas

**Agregar en SQL con `GROUP BY date_trunc('day', ...)`.** Más rápido y correcto si se
convierte la zona en la consulta (`AT TIME ZONE`). Se descartó por ahora porque mueve el
cálculo de indicadores a SQL crudo, donde no pasa por la extensión que filtra el `tenantId`
(ADR-0003) y donde no se puede probar sin base de datos. Con volúmenes de un salón, traer las
ventas del mes y agregarlas en memoria es holgadamente suficiente; el día que un cliente tenga
veinte sedes, esta es la primera optimización a hacer y el puerto ya está en su sitio para
absorberla sin tocar los cálculos.

**Vistas materializadas actualizadas por trigger.** Resuelven el rendimiento y crean un
problema peor: una cifra precalculada que diverge de los datos es indistinguible de una
correcta, y detectar la divergencia exige justamente el cálculo que la vista pretendía
evitar.

**Guardar la zona horaria en cada factura en lugar de leerla de la configuración.** Sería lo
correcto si un salón pudiera cambiar de zona, que en la práctica no ocurre. Añadiría una
columna a cada documento para un caso que no existe.
