# ADR-0002: Stack tecnológico NestJS + PostgreSQL + Prisma

- **Estado:** Aceptado
- **Fecha:** 2026-09-02

## Contexto

Se requiere un stack TypeScript de extremo a extremo, con tipado fuerte, contrato OpenAPI
y despliegue en contenedores.

## Decisión

| Pieza | Elección | Motivo |
| ----- | -------- | ------ |
| Runtime | Node.js ≥ 20.11 LTS | Soporte a largo plazo, `crypto.randomUUID` nativo |
| Framework | NestJS 11 | DI de primera clase (habilita la inversión del ADR-0001), módulos, guards, interceptors |
| Lenguaje | TypeScript 5.7 en modo `strict` | El tipado es la primera línea de tests |
| Base de datos | PostgreSQL 16 | Transacciones serializables, `numeric` exacto, índices parciales para soft delete |
| ORM | Prisma 6 | Migraciones versionadas, cliente tipado, `$extends` para tenancy y soft delete |
| Contrato | OpenAPI 3.1 vía `@nestjs/swagger` | Generado del código: no puede divergir del runtime |
| Validación | `class-validator` en el borde HTTP | Los DTOs validan forma; el dominio valida invariantes |
| Hashing | `@node-rs/argon2` | Argon2id, binarios precompilados (sin `node-gyp` en CI ni en la imagen) |

## No-duplicación (regla operativa)

La prohibición de duplicar código se implementa, no se enuncia:

- **Shared kernel** en `src/shared/` con primitivas de dominio (`Entity`, `AggregateRoot`,
  `ValueObject`, `Money`, `Email`, `Phone`, `TimeRange`), puertos de aplicación y
  adaptadores comunes.
- **`PrismaRepositoryBase`**: implementa una sola vez paginación, ordenación, filtrado,
  soft delete y ámbito de tenant para todos los repositorios.
- **Casos de uso CRUD genéricos** parametrizados por repositorio y mapeador, para módulos
  de catálogo sin reglas propias.
- **Decorador `@ApiCrudResource()`** que compone en una línea la documentación Swagger
  repetitiva (paginación, errores 400/401/403/404, esquema de respuesta envuelta).

## Consecuencias

- Acoplamiento a Prisma **confinado** a `infrastructure/persistence/`: el resto del sistema
  no conoce `PrismaClient`.
- `@node-rs/argon2` es un binario nativo por plataforma: la imagen Docker debe construirse
  para la arquitectura destino (`linux/amd64` o `linux/arm64`); no se puede copiar
  `node_modules` desde el host.

## Riesgo aceptado

`prisma` (CLI, dependencia de desarrollo) arrastra `deepmerge-ts < 8` con un aviso de
agotamiento de pila (GHSA-ggr8-5vv4-36mx). Solo se ejecuta en tiempo de build sobre
ficheros de configuración propios; no forma parte de la imagen de producción ni procesa
entrada de usuario. Se revisará al publicarse Prisma con la dependencia actualizada.

## Alternativas descartadas

- **TypeORM.** Migraciones menos fiables y tipado más débil en consultas compuestas.
- **Drizzle.** Excelente tipado y SQL más cercano, pero ecosistema de migraciones menos
  maduro para un equipo que rotará; se reconsiderará si Prisma estorba.
- **bcrypt.** Argon2id es la recomendación actual de OWASP frente a ataques con GPU.
