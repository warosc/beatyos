# ADR-0003: Multi-tenancy shared-schema con discriminador `tenantId`

- **Estado:** Aceptado
- **Fecha:** 2026-09-02

## Contexto

El producto es un **SaaS**: un despliegue sirve a muchos salones independientes. Cada
salón debe ver exclusivamente sus clientes, su agenda, su inventario y su caja. Una fuga
entre inquilinos es el fallo más grave que puede tener el sistema.

> **Supuesto explícito.** El enunciado dice "plataforma SaaS para salones" sin fijar el
> modelo de aislamiento. Se asume multi-tenant. Si el objetivo real fuera una instalación
> por salón, este ADR es el único que cambia el esquema de raíz.

## Decisión

**Shared database, shared schema**: una sola base de datos, una sola instancia de cada
tabla, con columna discriminadora `tenantId` en toda entidad de negocio.

El aislamiento se aplica en **tres niveles concéntricos**, de forma que ningún olvido
individual produzca una fuga:

1. **Contexto de petición.** `TenantContext` (`AsyncLocalStorage`) recibe el `tenantId`
   del claim del JWT en el guard de autenticación. No se lee jamás del body, la query
   ni de una cabecera manipulable por el cliente.
2. **Extensión de Prisma.** `withTenantScope()` inyecta `where: { tenantId }` en toda
   lectura y `data: { tenantId }` en toda escritura de los modelos con tenant. Es la
   red de seguridad: un repositorio que olvide filtrar sigue quedando acotado.
3. **Esquema.** Toda clave única de negocio es compuesta con `tenantId`
   (p.ej. `@@unique([tenantId, email])`), de modo que dos salones puedan tener un cliente
   con el mismo correo y la base de datos impida colisiones entre inquilinos.

Modelos **globales** (sin `tenantId`): `Tenant` y `Permission`. Se listan explícitamente en
`TENANT_EXEMPT_MODELS`; cualquier modelo nuevo es tenant-scoped por defecto —la omisión
falla hacia el lado seguro.

Un usuario `PLATFORM_ADMIN` puede operar entre inquilinos mediante un token con
`tenantId: null`, lo que obliga a indicar el tenant de forma explícita en cada operación.

## Consecuencias

**Positivas**

- Coste por inquilino mínimo; una sola migración para todos.
- Reportes agregados de plataforma sin federar consultas.

**Negativas**

- El aislamiento es lógico, no físico: un fallo en la capa 2 sería sistémico. Se compensa
  con tests de integración dedicados exclusivamente a fuga entre inquilinos.
- Vecino ruidoso: un salón muy grande afecta a los índices comunes. Aceptable en la escala
  prevista; la salida sería particionar por `tenantId`.
- Todo índice de consulta frecuente debe empezar por `tenantId` o el planificador
  escaneará datos ajenos.

## Alternativas descartadas

- **Un esquema por inquilino.** Mejor aislamiento, pero migrar N esquemas y el coste de
  conexiones lo hacen inviable con miles de salones.
- **Una base de datos por inquilino.** Aislamiento máximo, coste operativo máximo.
  Reservado para clientes enterprise si aparece la demanda.
- **Row Level Security de PostgreSQL.** Es la opción técnicamente superior y la evolución
  natural de este ADR. Se descarta ahora porque Prisma no gestiona `SET LOCAL` por
  transacción de forma nativa y forzaría SQL crudo sobre el pool. La capa 2 es su
  sustituto a nivel de aplicación.
