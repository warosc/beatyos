# ADR-0006: Autorización RBAC con permisos granulares

- **Estado:** Aceptado
- **Fecha:** 2026-09-02

## Contexto

Los perfiles de un salón son heterogéneos: la recepcionista agenda pero no ve márgenes,
la estilista consulta su propia agenda, la encargada compra y cuadra caja, la propietaria
lo ve todo. Un enum de roles se queda corto en cuanto el negocio matiza.

## Decisión

**RBAC de dos niveles: el rol agrupa permisos; el código comprueba permisos, nunca roles.**

- Un **permiso** es una cadena `recurso.acción` (`appointments.create`,
  `reports.financial.read`). Es un dato en tabla, no un enum compilado.
- Un **rol** es un conjunto con nombre de permisos, con ámbito de tenant. Los roles del
  sistema (`PLATFORM_ADMIN`, `OWNER`, `MANAGER`, `RECEPTIONIST`, `STYLIST`) se siembran y
  no se pueden borrar; cada salón puede definir roles propios.
- Un usuario puede tener varios roles; sus permisos efectivos son la **unión**.
- El guard `PermissionsGuard` lee los permisos del claim del access token. Sin consulta a
  BD por petición; el precio es la latencia de propagación de un cambio de permisos, que
  queda acotada por la vida del access token y es forzable vía `tokenVersion` (ADR-0005).

```ts
@RequirePermissions('appointments.create')   // así
@Roles('MANAGER')                            // nunca
```

**Denegación por defecto.** El guard es global. Un endpoint sin `@RequirePermissions` ni
`@Public` se rechaza con 403: olvidar la anotación cierra el endpoint en lugar de abrirlo.

**Ownership.** Los permisos responden "qué acciones"; no responden "sobre qué filas".
Para casos como "una estilista solo ve su propia agenda" se añade el sufijo de ámbito
`.own` (`appointments.read.own`), y el caso de uso restringe por el `stylistId` del actor.
La comprobación de pertenencia vive en el **dominio**, no en el guard: es una regla de
negocio, no de transporte.

## Consecuencias

- Añadir un permiso es una migración de datos (seed), no un despliegue de código.
- El seed de permisos debe ser idempotente y ejecutarse en cada despliegue, o un rol
  quedaría sin el permiso recién introducido.

### Tamaño del token: medido, no estimado

Llevar los permisos dentro del JWT tiene un coste que hay que dar en cifras y no en
impresiones. **Medido** sobre el catálogo real de 80 permisos:

| Rol | Permisos | Access token |
| --- | -------- | ------------ |
| `OWNER` | 80 | **2 377 bytes** |
| `STYLIST` | 5 | ~640 bytes |
| `PLATFORM_ADMIN` | 1 (`*`) | ~520 bytes |

La primera redacción de este ADR afirmaba "por debajo de 2 KB". Era falso, y lo destapó
un test de integración: el DTO de refresco topaba la longitud en 2 048 bytes y rechazaba
el token con un 400. Queda escrito aquí porque el número importa más que la intuición.

**Por qué 2,4 KB es aceptable hoy:** el límite práctico no es el token sino la cabecera
completa. nginx admite 8 KB por defecto (`large_client_header_buffers`), Node 16 KB y los
balanceadores gestionados suelen rondar los 16 KB. Con 2,4 KB queda margen sobrado.

**Cuándo deja de serlo:** el catálogo crece con el producto. El umbral de acción es
**4 KB** por token —la mitad del buffer más restrictivo del camino—. Al alcanzarlo, y no
antes, las salidas por orden de coste:

1. Acortar los códigos de permiso en el token (`app.c` en vez de `appointments.create`)
   con un mapa de traducción. Reduce a la tercera parte sin cambiar el modelo.
2. Mapa de bits por recurso: índice fijo por permiso y un entero por recurso.
3. Volver a consultar los permisos en cada petición, con caché en memoria compartida.

La tercera es la que muchos equipos eligen desde el principio; se descarta aquí porque
reintroduce un `SELECT` por petición para resolver un problema que hoy no existe.

## Alternativas descartadas

- **ABAC / políticas tipo OPA.** Más expresivo, pero introduce un lenguaje de políticas y
  un motor externo que no se justifica para el número de reglas actual.
- **Roles como enum en código.** Simple hasta el primer cliente que pide "como la
  recepcionista, pero además con caja". Entonces se paga entero.
