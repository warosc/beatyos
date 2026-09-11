# ADR-0008: Errores de dominio y traducción a HTTP

- **Estado:** Aceptado
- **Fecha:** 2026-09-02

## Contexto

Si el dominio lanza `NotFoundException` de NestJS, el dominio conoce HTTP y el ADR-0001
queda roto. Si la API filtra errores de Prisma, expone el esquema interno.

## Decisión

- El dominio lanza **excepciones de dominio** con código estable, sin conocer HTTP:
  `DomainError` → `EntityNotFoundError`, `BusinessRuleViolationError`, `ConflictError`,
  `ForbiddenActionError`, `DomainValidationError`.
- Un **filtro global** las traduce a estado HTTP en el borde. Es el único punto del
  sistema que conoce ambos mundos.
- Los errores de Prisma se traducen por código (`P2002` → 409, `P2025` → 404,
  `P2003` → 422). Nunca se propaga el mensaje original.
- Formato de error único, **RFC 9457 (Problem Details)** extendido:

```jsonc
{
  "type": "https://api.salon.app/errors/appointment-overlap",
  "title": "El horario solicitado se solapa con otra cita",
  "status": 409,
  "code": "APPOINTMENT_OVERLAP",        // estable, para los clientes
  "detail": "La estilista ya tiene una cita de 10:00 a 11:00",
  "instance": "/api/v1/appointments",
  "correlationId": "0f9c...",           // enlaza con logs y AuditLog
  "errors": [ { "field": "startsAt", "message": "..." } ]  // solo en 400/422
}
```

- **`code` es contrato**: los clientes ramifican sobre `code`, nunca sobre `title` o
  `detail`, que son texto para humanos y pueden traducirse o reescribirse sin aviso.
- Un 5xx nunca revela stack ni mensaje interno: registra todo con `correlationId` y
  devuelve un cuerpo genérico con ese id, que el usuario puede dar a soporte.

## Consecuencias

- Cada error de dominio nuevo exige una entrada en el mapa de traducción; el filtro falla
  hacia 500 y lo registra como omisión explícita, en lugar de adivinar un estado.
- Los tests unitarios afirman sobre tipos de error de dominio, no sobre códigos HTTP, lo
  que los mantiene independientes del transporte.
- **404 sobre 403 en recursos de otro inquilino**: un 403 confirmaría que el recurso
  existe. Fuera del propio tenant, todo es "no existe" (ver ADR-0003).
