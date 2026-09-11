# ADR-0004: Soft delete y auditoría transversal

- **Estado:** Aceptado
- **Fecha:** 2026-09-02

## Contexto

Un salón no puede perder el historial de una clienta ni de una factura por un borrado
accidental, y existen obligaciones contables y de protección de datos que exigen saber
**quién cambió qué y cuándo**.

## Decisión

### Soft delete

Toda tabla de negocio lleva `deletedAt: DateTime?` y `deletedBy: String?`. Borrar es
sellar la fila, nunca `DELETE`.

- Una **extensión de Prisma** añade `deletedAt: null` a toda lectura. Recuperar filas
  borradas exige el flag explícito `includeDeleted`, disponible solo para roles con el
  permiso correspondiente `*.restore`.
- Los índices únicos usan **índices parciales** (`WHERE "deletedAt" IS NULL`) para que un
  correo liberado por borrado pueda reutilizarse sin romper la unicidad de los vivos.

### Auditoría

Dos mecanismos complementarios, deliberadamente distintos:

1. **Columnas de autoría en la fila** (`createdBy`, `updatedBy`, `deletedBy` +
   `createdAt`, `updatedAt`, `deletedAt`): responden "quién tocó esto por última vez"
   sin un `JOIN`.
2. **Tabla `AuditLog` append-only**: responde "qué pasó exactamente". Registra actor,
   acción, entidad, id, diff `before`/`after` en `Json`, IP, user-agent y correlation id.
   Se escribe desde un interceptor, no desde cada caso de uso.

El `AuditLog` **no** tiene soft delete ni `UPDATE`: es un registro inmutable.

### Contradicción resuelta

El derecho de supresión del RGPD choca con el soft delete. Se resuelve distinguiendo
**borrado operativo** (soft delete, reversible, el caso habitual) de **anonimización**
(operación explícita que sobreescribe los datos personales del cliente conservando las
filas contables con un identificador seudónimo). La segunda es un caso de uso propio, con
permiso propio y registro en `AuditLog`; no se implementa como un `DELETE` físico.

## Consecuencias

- Las tablas crecen indefinidamente: se prevé archivado por partición temporal del
  `AuditLog` cuando supere volumen operativo.
- Los campos sensibles (`passwordHash`, tokens) se **redactan** antes de persistir el diff.
- Olvidar el filtro de borrado es imposible por construcción: la extensión lo aplica por
  defecto y omitirlo requiere acción explícita.
