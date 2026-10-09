# ADR-0023: Agenda por equipo, cambios aprobados por la encargada y recordatorios

- **Estado:** Aceptado
- **Fecha:** 2026-10-08
- **Cumple:** [ADR-0001](0001-arquitectura-hexagonal.md), [ADR-0003](0003-estrategia-multi-tenant.md), [ADR-0006](0006-autorizacion-rbac.md)
- **Depende de:** [ADR-0019](0019-comandas-de-servicio.md)

## Contexto

La agenda era una lista de tarjetas por día. No había horas, ni columnas por profesional, ni
forma de ver los huecos libres: agendar consistía en teclear una fecha y hora y descubrir el
choque al pulsar «Reservar». En el móvil había que desplazarse de lado sobre 760 px. La API
ya calculaba huecos (`/appointments/availability`) y nadie lo usaba.

La propiedad pidió tres cosas concretas:

1. Agendar fácil desde el teléfono.
2. Que la encargada vea la agenda de todo el equipo, y cada profesional la suya.
3. Que la profesional **pueda reprogramar, pero con permiso de la encargada**: le llega un
   aviso y la cita solo se mueve si ella lo autoriza.

Además pidió recordatorios a la clienta. La clienta todavía **no** reserva en línea.

## Decisión

### 1. Los cambios de la profesional son una solicitud, no un movimiento

Nuevo agregado `AppointmentChangeRequest` (`PENDING → APPROVED | REJECTED | WITHDRAWN`). La
profesional propone una hora (`POST /appointments/:id/change-requests`, con
`appointments.update.own`). Aprobar (`appointments.approve-changes`, nuevo, de encargada y
propietaria) **mueve la cita con `RescheduleAppointmentUseCase`**, el mismo de recepción,
en la misma transacción. No hay una segunda vía de mover citas que pueda olvidar el horario
o el solapamiento.

- La propuesta se valida ya al pedirla (jornada y choques), para no hacer perder el tiempo a
  la encargada; y se revalida al aprobar, porque la agenda puede haber cambiado. Si ya no
  cabe, la aprobación falla y la solicitud sigue pendiente.
- Como mucho una pendiente por cita: índice único parcial en PostgreSQL.
- Recepción mueve citas cuando llama la clienta, pero no decide sobre lo que pide el equipo.

### 2. Saltarse el horario exige permiso

`force: true` se aceptaba de cualquiera que pudiera agendar, incluida la propia profesional.
Ahora exige `appointments.override-schedule` (recepción y encargada). Reasignar una cita
comprueba además que la nueva profesional hace sus servicios, y la disponibilidad respeta el
ámbito `.own`.

### 3. Huecos con cualquier profesional y en la hora del salón

`GET /appointments/availability` admite omitir `stylistId`: busca en todo el equipo que sepa
hacer los servicios, con una consulta de citas para todos. Cada hueco dice con quién es. La
rejilla se alinea a la hora local del salón (`gridOffsetMs`), no a UTC. `excludeAppointmentId`
deja libre el hueco de la cita que se está moviendo.

### 4. Lo que se pinta lo resuelve el servidor

`AgendaDirectory` resuelve en una consulta por tipo los nombres, teléfonos, colores, servicios,
cambio pendiente y último recordatorio de cada cita. `GET /agenda/shifts` da la jornada (ya
descontadas las ausencias) y los bloqueos de cada profesional, para sombrear lo que no es
jornada. Los bloqueos de agenda (`POST /agenda/blocks`) son ausencias de como mucho un día que
**no pueden tapar citas**.

### 5. Avisos en vivo por Server-Sent Events

Los repositorios publican en un puerto `AgendaEvents` cada vez que guardan; la interfaz abre
`GET /agenda/stream` y, al recibir un aviso, vuelve a pedir la agenda por la vía normal. El
aviso **no lleva datos**: solo qué cambió. A quien solo ve su agenda se le dice si es suyo,
sin revelar de quién es si no lo es. Publicar desde el repositorio y no desde cada caso de uso
hace que el aviso llegue también cuando la cita cambia desde otro módulo (registrar lo
realizado la completa).

El bus es en memoria (una réplica). La interfaz vuelve a pedir la agenda cada minuto, así que
un aviso perdido se nota como retraso, no como dato que falta.

### 6. Recordatorios con enlace para confirmar o cancelar

Un planificador en proceso (cada 5 minutos) busca, **entre salones**, cuáles tienen citas en
la ventana (`REMINDER_LEAD_HOURS`, 24 por defecto, y no menos de `REMINDER_MIN_LEAD_MINUTES`)
y procesa cada salón **dentro de su contexto**. Cada intento queda en
`appointment_reminders` (enviado, fallido o descartado por no tener teléfono). Tres fallos y
se deja de insistir; sin teléfono, no se reintenta.

- Canal por puerto `ReminderSender`: `log` por defecto (como el correo, elegir proveedor es
  decisión de despliegue con coste por mensaje) y Twilio para WhatsApp o SMS.
- Recepción puede enviarlo desde el WhatsApp del salón (`POST /appointments/:id/reminder`
  devuelve el texto y un enlace `wa.me`). Funciona sin proveedor contratado.
- El mensaje lleva un enlace `/cita/<token>` con el que la clienta confirma o cancela sin
  cuenta. Se guarda el SHA-256 del token; uno nuevo invalida el anterior; deja de valer al
  pasar la cita. El salón se averigua por el enlace (consulta entre salones por el hash) y
  todo lo demás corre en su contexto. No permite reservar ni mover.

### 7. Interfaz

Parrilla horaria con una columna por profesional (día) o por día (semana), lista y mes;
asistente de reserva en pasos que solo ofrece horas libres; ficha de la cita con las acciones
que tocan según su estado y los permisos de quien mira. La app se puede instalar en el
teléfono (manifiesto y service worker sin caché) y muestra avisos del sistema.

## Consecuencias

- La profesional no puede mover sus citas sin la encargada, y queda rastro de qué pidió y qué
  se contestó.
- Un enlace de confirmación es una credencial: limitado a su cita, sustituible y con fecha de
  caducidad natural.
- El bus de avisos y el planificador asumen una réplica. Con varias, el bus pasa a Redis
  pub/sub y el planificador necesita elegir una réplica o una cola, para no enviar dos veces.
- La zona horaria sigue saliendo de la configuración global (ver `stylists.module.ts`).
- WhatsApp por Twilio exige una plantilla aprobada por Meta para escribir a quien no ha
  escrito antes; el texto de `composeReminderMessage` es el que hay que registrar.
- Los avisos del sistema llegan con la app abierta o en segundo plano. Con la app cerrada
  haría falta Web Push (claves VAPID y un servicio de envío), que queda fuera.

## Alternativas descartadas

- **Dejar que la profesional mueva y avisar después.** Es lo que se quería evitar: la
  encargada organiza el día y la decisión es suya.
- **Un flag en la cita («cambio pedido») en lugar de un agregado.** Se perdería el histórico
  de peticiones y respuestas, y no habría dónde guardar el motivo del rechazo.
- **WebSockets.** El canal es de un solo sentido (servidor → navegador); SSE va sobre HTTP
  normal, atraviesa proxies y no necesita librería.
- **`EventSource` en el navegador.** No deja reaccionar a un 401 y el token de acceso caduca
  cada 15 minutos: se usa `fetch` con lectura del flujo y renovación de sesión.
- **Una librería de calendario (FullCalendar).** La vista con columnas por profesional es de
  pago y su peso no compensa en el móvil; la parrilla propia son unas pocas centenas de líneas.
- **Recordatorios con cron externo o una cola.** Para una réplica es complejidad sin
  beneficio; la marca de «recordada» vive en la cita, así que una pasada perdida se recupera
  en la siguiente.
