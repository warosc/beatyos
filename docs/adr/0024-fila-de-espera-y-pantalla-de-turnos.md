# ADR-0024: Fila de espera de clientas sin cita y pantalla de turnos

- **Estado:** Aceptado
- **Fecha:** 2026-10-12
- **Cumple:** [ADR-0001](0001-arquitectura-hexagonal.md), [ADR-0003](0003-estrategia-multi-tenant.md), [ADR-0006](0006-autorizacion-rbac.md)
- **Depende de:** [ADR-0019](0019-comandas-de-servicio.md), [ADR-0023](0023-agenda-por-equipo-cambios-aprobados-y-recordatorios.md)

## Contexto

Buena parte de las clientas del salón llega sin cita. Hoy recepción las apunta de palabra,
nadie sabe quién va antes y la profesional que queda libre pregunta en voz alta a quién le
toca.

La propiedad tiene un sistema propio de turnos (repositorio `warosc/colas`, «QueueNova /
Digiturnos») pensado para oficinas de atención: FastAPI, PostgreSQL, Redis, MinIO,
Prometheus, Grafana, nginx y un grabador de pantalla en Electron. Pidió incorporarlo al
salón, **adaptado a un salón de belleza** y **sin levantar todos sus contenedores**, en la VPS
donde ya corre BeautyOS (2 núcleos, 3,7 GB, una pila Docker por salón).

Al revisarlo:

- Redis es obligatorio para arrancar: `event_queue` se conecta al importarse y la API no
  levanta sin él. El inicio de sesión también lo usa sin protección.
- No es multi-inquilino: no hay `tenantId` en ninguna tabla. Haría falta una copia por salón.
- Tiene usuarios, roles, servicios y personal propios: doble inicio de sesión y los mismos
  datos cargados dos veces.
- Tiene huecos que habría que cerrar antes de exponerlo: el primer `POST /auth/register`
  con la base vacía crea un administrador, `POST /turns/create` admite `priority_code` sin
  autenticar (colarse en la fila) y fuera de `ENVIRONMENT=production` arranca con un secreto
  JWT de ejemplo.
- Su licencia dice «PROPIETARIO - Ufinet Latam … prohibida la reproducción o uso sin
  autorización expresa».

Lo valioso de `colas` no es su código sino su experiencia de uso: el número del día, «llamar
siguiente» sin que dos agentes se lleven al mismo, volver a llamar, la pantalla de la sala
con campanita y voz, y el ticket impreso.

## Decisión

### 1. Un módulo nativo (`src/salon/queue`), no `colas` desplegado aparte

La fila vive dentro de BeautyOS, con su login, sus roles, sus profesionales, su catálogo y su
aislamiento por salón. **No añade ningún contenedor**: corre en la API y la web de cada
instancia. De `colas` se toman las ideas, reescritas con las piezas que BeautyOS ya tenía.

### 2. El turno es un agregado propio, `QueueTurn`

| Estado | Significa |
| ------ | --------- |
| `WAITING` | En la fila |
| `CALLED` | Una profesional la llamó; la pantalla lo anuncia |
| `IN_SERVICE` | Ya está en el sillón |
| `DONE` | Atendida: tiene comanda |
| `NO_SHOW` | La llamaron y no apareció |
| `CANCELLED` | Se fue, o se anotó por error |

- **Número del día por salón.** Empieza en 1 cada mañana, en la zona horaria del salón
  (`businessDate`). Lo da `queue_day_counters` con un `INSERT … ON CONFLICT DO UPDATE …
  RETURNING` en la misma transacción: dos recepciones a la vez no reciben el mismo número y
  un alta que falla no lo consume. No es el `upsert` de Prisma porque, con el filtro de salón
  que añade la extensión, Prisma lo emula con lectura y escritura y el primer turno del día
  anotado desde dos sitios chocaría.
- **Lo que pide es una intención, no un cargo.** `serviceIds` es un `text[]` sin claves
  foráneas: sirve para decidir quién puede atenderla. Lo que se cobra lo declara la
  profesional al terminar, en la comanda, que vuelve a validar contra el catálogo.
- **Volver a la fila conserva el sitio.** El orden es la llegada (`createdAt`), que no cambia.
- **Lo que quedó en espera la víspera no se vuelve a llamar.** Un turno llamado o en el
  sillón de otro día sigue visible para su profesional hasta que lo cierre.

### 3. «Llamar siguiente»: por orden de llegada, respetando a quién pidió y qué sabe hacer

La profesional se lleva a la primera de la fila que **ella** puede atender: si la clienta
pidió a otra, o pide un servicio que no tiene asignado (`Stylist.canPerform`, la regla de la
agenda), se la salta **sin que pierda su sitio**.

La concurrencia la resuelve la base, no la aplicación:

- El cambio de estado es un `UPDATE … WHERE id = ? AND status = <el leído>`. Si otra profesional
  se la llevó en el mismo instante, no hay fila que actualizar (`QUEUE_TURN_CHANGED`) y se
  pasa a la siguiente candidata.
- Un índice único parcial impide que una profesional tenga dos turnos `CALLED`/`IN_SERVICE`
  (`QUEUE_STYLIST_BUSY`), aunque se pulse dos veces o se escriba por fuera de la aplicación.
- `CHECK`s: llamada, en el sillón o atendida ⇒ con profesional; atendida ⇒ con comanda;
  `closedAt` presente exactamente en los estados finales.

No se usa Redis: el `SELECT … FOR UPDATE SKIP LOCKED` de `colas` se sustituye por la escritura
condicional, que da la misma garantía sin mantener un bloqueo abierto.

Recepción puede asignar un turno concreto a otra profesional (`POST /queue/:id/call`): se salta
la preferencia de la clienta, que cambió de idea, pero **nunca** la habilidad.

### 4. Terminar un turno es registrar su comanda

`FinishQueueTurnUseCase` llama a `RegisterServiceTicketUseCase` —el mismo de «Clienta sin
cita» en «Mi día»— y cierra el turno con el id de la comanda **en la misma transacción**. Si
la comanda no se puede registrar (servicio no asignado, profesional inactiva), el turno sigue
en atención. Caja la cobra como cualquier otra (ADR-0019).

### 5. Permisos

| Permiso | Recepción | Encargada | Profesional |
| ------- | :-------: | :-------: | :---------: |
| `queue.read` | ✓ | ✓ | |
| `queue.read.own` | | | ✓ |
| `queue.create` | ✓ | ✓ | |
| `queue.attend` | ✓ | ✓ | |
| `queue.attend.own` | | | ✓ |
| `queue.manage-display` | | ✓ | |

La propietaria los tiene todos. Con `.own` la profesional ve solo las que puede atender y las
suyas, llama a la siguiente y atiende sus turnos; **no elige a quién**: saltarse el orden es de
quien habla con la clienta que espera. Terminar exige además poder registrar comandas
(`service-tickets.create`, o `.own` para los turnos propios): no es una puerta trasera.

### 6. La pantalla de la sala: un enlace que es la credencial

Mismo patrón que el enlace de la cita (ADR-0023): `POST /queue/display-link` emite 144 bits de
azar, se guarda su SHA-256 en `tenants.queueDisplayTokenHash` y se enseña **una sola vez**.
Emitir otro retira el anterior. La ruta pública (`/pantalla/:token`, API
`/public/queue-display/:token`) solo enseña número, nombre corto («Ana G.»), profesional y los
números en espera; nunca servicios, teléfono ni ficha. Un salón suspendido no la enseña. Los
logs redactan el enlace.

La pantalla se actualiza por un canal SSE público que solo dice «la fila cambió» y vuelve a
pedir la vista. Con cada llamada nueva —o cuando sube `callCount` al volver a llamar— suena una
campanita (Web Audio) y una voz lo anuncia (`speechSynthesis`). Los navegadores exigen un toque
antes de sonar: la pantalla arranca con «Activar sonido», que además la pone a pantalla
completa y pide que no se apague (`wakeLock`).

### 7. Avisos en vivo por el canal de la agenda

Los cambios de la fila se publican en el bus de la agenda con `kind: 'queue'`. Recepción y las
profesionales ya tienen ese canal abierto todo el día; un aviso de la fila solo invalida la
fila, no la agenda.

## Consecuencias

- Cero contenedores y cero RAM añadidos en la VPS. Se despliega con la rutina de siempre; la
  migración es solo aditiva.
- El catálogo pasa a **101 permisos**: el access token de una propietaria ronda los 3,0 KB.
  La cookie que lo guarda no puede pasar de 4 KB; quedan unos 28 permisos de margen antes de
  tener que sacar los permisos del token.
- El bus de avisos es de proceso, como el de la agenda: con más de una réplica de la API
  habría que llevarlo a Redis pub/sub. La pantalla vuelve a pedir la vista cada minuto y el
  tablero cada 30 s, así que un aviso perdido se nota como retraso, no como dato que falta.
- La zona horaria del día de la fila sale de `DEFAULT_TIMEZONE`, igual que la agenda (deuda
  anotada en el README).
- Quedan fuera, a propósito: kiosco de autoservicio, prioridades con reglas de equidad,
  reservas con check-in desde la fila y todo lo de grabaciones y métricas de `colas`.

## Alternativas descartadas

- **Desplegar `colas` recortado al lado (API + PostgreSQL + Redis + frontend estático).**
  Unos 250 MB más, una copia por salón, segundo login, datos duplicados, huecos de seguridad
  que parchear en código ajeno y una licencia que no lo permite sin autorización. La
  integración con comandas y caja habría sido un puente entre dos bases.
- **Reutilizar `Appointment` con `source = WALK_IN`.** Una cita ocupa un intervalo y la
  restricción `EXCLUDE` de solapamiento la protege; un turno en espera no tiene hora ni
  profesional. Forzarlo habría llenado la agenda de citas ficticias.
- **Bloqueo con Redis o `SELECT … FOR UPDATE`.** La escritura condicional más el índice
  parcial dan la misma garantía sin infraestructura nueva ni bloqueos abiertos.
- **Sondeo cada pocos segundos desde la TV.** Llena el registro de la API con miles de líneas
  al día y anuncia tarde. El canal SSE abre una línea de registro y avisa al instante.
