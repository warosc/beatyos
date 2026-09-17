# Architecture Decision Records

Registro cronológico e inmutable de las decisiones arquitectónicas del proyecto.
Un ADR nunca se edita una vez aceptado: se **supersede** con uno nuevo.

| ADR | Título | Estado |
| --- | ------ | ------ |
| [0001](0001-arquitectura-hexagonal.md) | Arquitectura hexagonal con DDD por módulos | Aceptado |
| [0002](0002-stack-tecnologico.md) | Stack tecnológico: NestJS + PostgreSQL + Prisma | Aceptado |
| [0003](0003-estrategia-multi-tenant.md) | Multi-tenancy shared-schema con discriminador `tenantId` | Aceptado |
| [0004](0004-soft-delete-y-auditoria.md) | Soft delete y auditoría transversal | Aceptado |
| [0005](0005-autenticacion-jwt-refresh.md) | Autenticación JWT con refresh token rotativo | Aceptado |
| [0006](0006-autorizacion-rbac.md) | Autorización RBAC con permisos granulares | Aceptado |
| [0007](0007-api-rest-versionada.md) | API REST versionada por URI y contrato OpenAPI | Aceptado |
| [0008](0008-manejo-de-errores.md) | Errores de dominio y traducción a HTTP | Aceptado |
| [0009](0009-estrategia-de-testing.md) | Pirámide de tests y umbral de cobertura | Aceptado |
| [0010](0010-dinero-y-precision-decimal.md) | Representación monetaria en enteros de la unidad menor | Aceptado |
| [0011](0011-inventario-y-consistencia.md) | Inventario por movimientos (ledger append-only) | Aceptado |
| [0012](0012-lotes-caducidad-y-fefo.md) | Lotes, caducidad y consumo FEFO | Aceptado |
| [0013](0013-reconciliacion-del-motor-de-inventario.md) | Reconciliación del motor de inventario | Aceptado |
| [0014](0014-ventas-cobros-y-arqueo-de-caja.md) | Ventas, cobros y arqueo de caja | Aceptado |
| [0015](0015-informes-e-indicadores.md) | Informes e indicadores | Aceptado |
| [0016](0016-fotos-de-clienta-y-almacen-de-objetos.md) | Fotos de clienta y almacén de objetos | Aceptado |
| [0017](0017-normalizacion-arquitectonica-de-compras.md) | Normalización arquitectónica de compras | Aceptado |
| [0018](0018-comisiones-y-metas-de-profesional.md) | Comisiones por profesional y metas con recompensa | Aceptado |

## Formato

Cada ADR sigue la estructura: **Contexto** (qué fuerza la decisión), **Decisión** (qué se
hace, en imperativo), **Consecuencias** (lo bueno y lo malo que aceptamos) y
**Alternativas descartadas** (con el motivo del descarte, que es la parte que más valor
tiene dentro de seis meses).
