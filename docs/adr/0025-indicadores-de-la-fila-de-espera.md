# ADR-0025: Indicadores de la fila de espera para decidir

- **Estado:** Aceptado
- **Fecha:** 2026-10-13
- **Cumple:** [ADR-0006](0006-autorizacion-rbac.md), [ADR-0015](0015-informes-e-indicadores.md)
- **Depende de:** [ADR-0024](0024-fila-de-espera-y-pantalla-de-turnos.md)

## Contexto

Con la fila de espera en marcha (ADR-0024), la propietaria pidió cifras para decidir: cuánto
esperan las clientas sin cita, cuántas se van sin que las atiendan y cuándo hace falta más
gente. Y recepción necesitaba, en el día a día, ver de un vistazo quién está libre y qué
esperas se están alargando, para no perder clientas en el mostrador.

Para medir la espera faltaba un dato: `calledAt` es la **última** llamada —sube al volver a
llamar y se borra al devolver a la fila—, así que no dice cuándo terminó la espera.

## Decisión

### 1. `firstCalledAt`: el final de la espera

Columna nueva en `queue_turns`, fijada en la primera llamada y que ya no cambia. La espera de
una clienta es de su llegada (`createdAt`) a `firstCalledAt`. Migración aditiva; los turnos que
ya existían se rellenan con `calledAt` o, si se borró, con `startedAt`.

### 2. Indicadores como funciones puras sobre hechos, como los informes

`summarizeQueue` (dominio) recibe los turnos del periodo y devuelve las cifras; el adaptador de
Prisma solo lee las columnas que usa y, de cada turno atendido, el total de la factura con la
que se cobró su comanda. Se prueban con datos escritos a mano.

| Cifra | Definición |
| ----- | ---------- |
| Llegadas | Turnos cuyo día del salón cae en el periodo |
| Se perdieron | Se fueron (`CANCELLED`) + no vinieron (`NO_SHOW`) + seguían en la fila al cerrar su día |
| Tasa de abandono | Perdidas sobre las **resueltas**: las de hoy que aún esperan no cuentan |
| Espera | De la llegada a la primera llamada: media, mediana, p90 y máximo, en minutos |
| Aguante | Cuánto esperaron las que se fueron sin que las llamaran |
| Sillón | Del inicio al final de las atendidas |
| Cobrado | Facturas pagadas (o en parte) de las comandas de la fila |

Además, por hora local de llegada (tramo continuo, con las horas sin nadie), por día, por día
de la semana (llegadas **por cada** lunes del periodo, no el total), por profesional (atendidas,
cuántas la pidieron por su nombre, sillón medio) y por servicio pedido.

### 3. Conclusiones, solo con muestras suficientes

El dominio extrae conclusiones con datos, no con texto —hora con más llegadas, hora con más
espera, cuánto aguantan las que se van, día con más llegadas, profesional más pedida— y solo
con **tres o más** muestras: por debajo, una media es la anécdota de una clienta. La pantalla
las redacta con la decisión que sugieren.

### 4. Permiso de informes, no de la fila

`GET /queue/stats` exige `reports.read`. Recepción opera la fila, pero las cifras del negocio
son de quien ve los informes (propietaria y encargada), igual que el resto de indicadores.

### 5. Espera aproximada en la sala

El tablero y la pantalla calculan la espera media de **hoy**. La pantalla y el ticket solo la
enseñan con tres o más llamadas, y por debajo de 5 minutos dicen «menos de 5 min»: una cifra
exacta sonaría a promesa.

### 6. Gráficos

Forma de énfasis: lo que se pierde en el rojo de estado y el resto en un gris neutro; una sola
serie en la tinta de la marca. Validado con el comprobador de paletas: gris y rojo se separan
para el daltonismo (ΔE 21,7 en claro, 10,8 en oscuro). El gris queda por debajo de 3:1 sobre la
tarjeta, así que cada gráfico lleva sus cifras en las columnas y una tabla equivalente. Columnas
de ≤ 24 px desde una única línea base, sin doble eje (llegadas y espera por hora son dos
gráficos), y tooltip por columna con ratón y teclado.

## Consecuencias

- La recepción ve los indicadores de hoy, el estado del equipo y llama por una profesional libre
  con un toque. Las esperas de 15 y 30 minutos se señalan con color y texto.
- Lo que quedó en espera al cerrar el día cuenta como perdido: no hay proceso nocturno que lo
  cierre, y no hace falta para medirlo.
- La espera mide hasta la **primera** llamada. Una clienta devuelta a la fila y llamada de nuevo
  esperó algo más de lo que dice la cifra; se acepta, porque la primera llamada es cuando el
  salón empezó a atenderla.
- El periodo tiene el mismo tope de un año que los informes.

## Alternativas descartadas

- **Calcular la espera con `calledAt`.** Cambia con cada nueva llamada y se borra al devolver a
  la fila: daría esperas más largas o ninguna.
- **Una tabla de eventos del turno** (como `turn_events` en `colas`). Más completa, pero para
  estas cifras basta una columna, y la auditoría ya guarda cada cambio.
- **Un gráfico con dos ejes** (llegadas y espera por hora). Inventa una relación que no está en
  los datos; van en dos gráficos alineados por la hora.
