# ADR-0027: Baja de profesionales

- **Estado:** Aceptado
- **Fecha:** 2026-11-03
- **Cumple:** [ADR-0004](0004-soft-delete-y-auditoria.md)
- **Depende de:** [ADR-0018](0018-comisiones-y-metas-de-profesional.md), [ADR-0024](0024-fila-de-espera-y-pantalla-de-turnos.md)

## Contexto

Cuando una profesional deja el salón tiene que desaparecer de la agenda, el punto de venta,
la fila de turnos y las metas, sin perder lo que hizo. La API ya tenía borrado lógico para
profesionales, pero ninguna pantalla lo usaba. Lo único que había era «Desactivar» en Equipo,
que apaga el **usuario** y no la ficha de profesional, así que seguía apareciendo en todas
partes. Además:

- Darla de baja con citas futuras dejaba esas citas sin nadie que las atendiera.
- Una comanda suya sin cobrar ya no se podía cobrar, y se perdía su comisión.
- Varias pantallas resuelven el nombre de la profesional con lecturas que excluyen a las
  borradas: sus ventas pasadas se quedaban sin nombre.

## Decisión

### 1. Un solo «Dar de baja», con el borrado lógico de siempre

`DELETE /stylists/:id` sella `deletedAt`. Las lecturas normales ya la excluyen, así que deja
de aparecer en la agenda, la caja, los turnos, las reservas y los selectores. Se reactiva
con `POST /stylists/:id/restore`, desde la tarjeta «Dadas de baja» de Comisiones y jornadas.

### 2. Lo pendiente bloquea la baja

No se puede dar de baja con:

- citas por atender o en curso (`SCHEDULED`, `CONFIRMED`, `IN_PROGRESS` que aún no terminan);
- comandas sin cobrar (`PENDING`);
- turnos de la fila que ya son suyos (`CALLED`, `IN_SERVICE`).

La API rechaza con `422 STYLIST_HAS_PENDING_WORK`. Como los errores solo llevan código y
mensaje, `GET /stylists/:id/retirement` devuelve la lista para que la dueña los reasigne o
cierre y vuelva a intentar. Las clientas en espera que la **pidieron** no bloquean: una
preferencia es un deseo, no una cita, y pasan a la fila general en la misma transacción.

Lo pendiente se lee con un puerto propio (`StylistOffboarding`) implementado dentro del
módulo de profesionales, porque agenda, cola y comandas ya dependen de él y consultarlos
desde aquí cerraría un ciclo.

### 3. Su acceso se apaga con la baja

La baja desactiva su usuario (y cierra sus sesiones), salvo que sea dueña: dejar de atender
no puede dejar al salón sin quien lo administra. Reactivarla vuelve a encender un usuario
que estuviera inactivo. Todo ocurre en una sola unidad de trabajo.

«Desactivar» en Equipo sigue siendo solo quitar el acceso: son decisiones distintas, y la
baja tiene reglas que se resuelven en Comisiones y jornadas. Equipo lo dice junto al botón.

### 4. Su historial conserva su nombre

Ventas, recibos reimpresos, comandas, la fila, la agenda, los informes y las metas leen su
nombre incluyendo a las borradas, con la marca «(dada de baja)». El recibo de la clienta la
quita: a la clienta no le dice nada.

### 5. No se le asigna nada nuevo

Una venta nueva no puede llevar a una profesional dada de baja o inactiva
(`STYLIST_NOT_AVAILABLE`), porque devengaría una comisión que nadie le va a pagar. De
vacaciones sí, para poder cobrar una comanda suya. Tampoco se le pueden poner metas nuevas.
La capacidad de la agenda en los informes deja de contar sus horarios.

## Consecuencias

- Guardar los roles de su usuario no la devuelve al equipo: el alta automática de la ficha
  de profesional encuentra la borrada y no la toca. Lo cubre una prueba de integración.
- Reactivarla falla con 409 si, mientras estaba de baja, otra profesional activa tomó su
  correo (el índice único de correo es parcial).
- Entre la revisión y la baja podría agendarse una cita. La baja vuelve a comprobarlo dentro
  de la transacción; queda una ventana mínima que no justifica bloquear filas.
- Solo la dueña puede dar de baja y reactivar (`stylists.delete`, `stylists.restore`). Dárselo
  a la encargada exige migrar los permisos de rol en cada salón.

## Alternativas descartadas

- **Usar el estado `INACTIVE` en lugar del borrado lógico.** Conservaba los nombres sin
  más, pero cada lista nueva tendría que acordarse de filtrarla, y olvidarlo una vez es
  exactamente el problema que había. Con el borrado lógico, olvidarse deja un nombre como
  «Profesional», no a alguien que ya no está ofreciéndose en la agenda.
- **Cancelar sus citas futuras automáticamente.** Dejaba clientas sin cita sin que nadie las
  llamara. Reasignarlas es una decisión de la dueña.
- **Que «Desactivar» en Equipo diera también de baja.** Mezclaba quitar el acceso
  (seguridad, a veces temporal) con dejar el equipo, y obligaba al núcleo de usuarios a
  depender del salón.
