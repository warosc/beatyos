# R0 Backend Audit

**Proyecto:** BeautyOS / AppSalonBelleza
**Encargo:** `BeautyOS R0 — Auditoría de Arquitectura con Claude Code.md`
**Auditor:** Claude Code (Opus 5) — Backend y Arquitectura
**Fecha:** 2026-09-07
**Alcance:** `src/`, `prisma/`, `test/`, `docker*`, `.github/workflows/`, `docs/adr/`. El frontend (`apps/web`) queda fuera salvo donde consume el contrato de la API.

---

## AVISO PREVIO — Cumplimiento de la regla «no modificar»

El encargo R0 prohíbe modificar archivos. **Esta regla se incumplió antes de que se pidiera el informe**, en la sesión de trabajo previa, y hay que declararlo antes que nada:

| Archivo | Cambio | Motivo |
| --- | --- | --- |
| `apps/web/src/app/api/purchases/route.ts` | Lista blanca de `action` (`submit\|receive\|cancel`) | `action` se concatenaba a la ruta sin validar; `action=../../users` se normaliza a `/api/v1/users` |
| `apps/web/src/app/api/clients/route.ts` | Rama 204 reescrita como `new NextResponse(null, …)` | `NextResponse.json(null, {status:204})` lanza |
| `apps/web/src/**/*.test.ts` (19 archivos nuevos) | 133 tests del BFF | Cobertura del proxy de Next |

Los tres son de `apps/web`, ninguno toca `src/`, `prisma/` ni `test/`. **El backend auditado en este documento está intacto.**

`git status --short` y `git diff --stat`, que el encargo pide ejecutar al cerrar, **no se pueden ejecutar: el directorio no es un repositorio git** (`fatal: not a git repository`). No hay control de versiones en esta copia de trabajo, de modo que no existe línea base contra la que diferenciar. Es en sí mismo un hallazgo (R0-BE-014).

---

## 1. Executive Summary

1. **No se ha encontrado ningún hallazgo CRITICAL.** No hay fuga entre inquilinos, ni bypass de autenticación, ni corrupción financiera demostrable.
2. **El aislamiento multi-tenant es el punto más fuerte del sistema.** Tres capas concéntricas —contexto por `AsyncLocalStorage`, extensión de Prisma, unicidades compuestas en el esquema— verificadas contra el código y ejercitadas por una suite dedicada.
3. **El `tenantId` entra por un único punto**: el claim del JWT en `guards.ts:66`. No se lee de body, query ni cabecera en ningún sitio del repositorio.
4. **La base de datos es de calidad excepcional** y sostiene invariantes que la aplicación no puede garantizar sola: `EXCLUDE USING gist` para el solapamiento de citas, triggers append-only sobre auditoría y kardex, índices únicos parciales para el soft delete, `CHECK` sobre importes y existencias.
5. **La regla de dependencia hexagonal se cumple en 13 de 14 módulos.** El control documentado devuelve exactamente **2 coincidencias**, ambas en compras.
6. **Compras es la única deuda arquitectónica real y el README ya la declara.** No tiene capa de dominio: 3 archivos, un servicio de 371 líneas acoplado a `PrismaService`.
7. **Esa ausencia tiene consecuencias medibles, no estéticas**: sin repositorio no pasa por `withMappedErrors`, de modo que una violación de restricción devuelve **500 en lugar de 409/422** (R0-BE-002).
8. **Compras contiene una carrera leer-comprobar-escribir** en la recepción de mercancía —el mismo patrón que el ADR-0013 eliminó de inventario—. El `CHECK` de la base impide la corrupción, pero el segundo concurrente recibe un 500 (R0-BE-003).
9. **`GET /purchases` y `GET /suppliers` no paginan** y arrastran relaciones anidadas. Incumple el ADR-0007 y crece sin cota con el histórico del salón (R0-BE-004).
10. **El CI está en rojo.** `npx prettier --check` —paso del job `static`— falla sobre **25 archivos**. Un gate que falla siempre es un gate que nadie mira (R0-BE-005).
11. **`PERMISSION_DENIED` está declarado en el enum de la base y en el tipo de puertos, y no se emite jamás.** Los 403 no dejan rastro de auditoría (R0-BE-006).
12. **El contrato OpenAPI está incompleto**: roles (0/5 endpoints documentados), usuarios (0/7), compras (0/11), inventario (8/12) (R0-BE-007).
13. **La cobertura cumple los cuatro umbrales, con margen mínimo en ramas**: 80,2 % frente a un mínimo de 80 %. Dos ramas nuevas sin test rompen el CI.
14. **Observabilidad insuficiente para producción**: hay logging estructurado con `correlationId`, sondas `live`/`ready` y `AuditLog`, pero **ni métricas ni trazas** (R0-BE-009).
15. **Veredicto: READY FOR R1.** Ningún hallazgo impide desplegar el núcleo funcional; los dos frentes de R1 son compras y observabilidad.

---

## 2. Repository Health

| Dimensión | Nota | Justificación |
| --- | ---: | --- |
| Architecture | **8,0** | La regla de dependencia se cumple en 13/14 módulos y el control automatizado devuelve solo 2 coincidencias en 27 000 líneas. Resta un punto entero porque la excepción no es una línea suelta: es un módulo completo sin capa de dominio. |
| Domain model | **8,0** | Agregados con invariantes reales (`CashSession.expectedAmount`, `Product.applyDelta`, `StockAllocationService` FEFO), value objects compartidos (`Money`, `TimeRange`, `Email`). Compras no tiene modelo y `core/roles` es anémico. |
| Database | **9,5** | Es lo mejor del repositorio. `EXCLUDE USING gist` con `btree_gist`, 2 triggers append-only, ~10 índices únicos parciales, ~20 `CHECK` con nombre, `Decimal(12,2)`, unicidad compuesta con `tenantId` y `COALESCE` para el centinela de plataforma. Falta únicamente Row Level Security, ya justificado en el ADR-0003. |
| Multi-tenancy | **9,0** | Tres capas verificadas y una suite propia (`tenant-isolation.integration.spec.ts`). Los dos huecos conocidos —escrituras anidadas y SQL crudo— están documentados y mitigados (`tenantFilter()`), y no hay SQL crudo de negocio en todo `src/`. |
| Security | **8,5** | Argon2id con parámetros OWASP, secretos distintos y validados a ≥32 caracteres, `refine` que rechaza CORS `*` y Swagger activo en producción, RBAC con denegación por defecto, respuesta uniforme en login, bloqueo por intentos, throttler de ámbito acotado, 404 sobre 403 fuera del tenant. Penaliza el 403 sin auditar y el rate limiting en memoria. |
| API design | **7,0** | Envoltura uniforme por interceptor, versionado por URI, RFC 9457 con `code` estable, `forbidNonWhitelisted`. Baja por el OpenAPI incompleto en 4 controladores y por dos colecciones sin paginar que contradicen el ADR-0007. |
| Testing | **8,0** | 1 115 tests reales, dobles que implementan el puerto de verdad, tests de fuga entre inquilinos de primera clase, y ADRs que citan fallos encontrados por los propios tests. Baja por compras y roles sin tests unitarios, por ramas al filo del umbral y por concurrencia probada solo en inventario. |
| Performance readiness | **6,5** | Índices bien diseñados (todos empiezan por `tenantId`), informes acotados a 366 días y resueltos con funciones puras, filtro de existencias empujado a la base. Baja por las dos colecciones sin cota y porque la agregación de informes es en memoria por decisión explícita. Sin pruebas de carga todavía. |
| Observability | **5,0** | Logging estructurado con correlación propagada, sondas `live`/`ready` con Terminus, `AuditLog` con diff y actor. **Cero métricas y cero trazas**: no hay `prom-client` ni OpenTelemetry en el árbol de dependencias. |
| Production readiness | **7,0** | Imagen multi-etapa, `USER node`, `HEALTHCHECK`, `enableShutdownHooks`, validación de entorno que aborta el arranque con configuración insegura. Baja por el CI en rojo, por la observabilidad y porque el rate limiting no sobrevive a la segunda réplica. |

**Media ponderada: 7,7 / 10.**

---

## 3. Verified Architecture

Lo que sigue está derivado del código, no del README.

### Estructura real

```
src/
├── shared/    4 702 líneas   kernel: domain / application (puertos) / infrastructure
├── core/      3 053 líneas   auth, users, roles, permissions, health
└── salon/    19 068 líneas   appointments, cash, catalog, clients, inventory,
                              purchases, reports, sales, stylists
```

| Módulo | domain | application | infrastructure | specs |
| --- | :-: | :-: | :-: | ---: |
| appointments | ✅ | ✅ | ✅ | 2 |
| cash | ✅ | ✅ | ✅ | 1 |
| catalog | ✅ | ✅ | ✅ | 2 |
| clients | ✅ | ✅ | ✅ | 2 |
| inventory | ✅ | ✅ | ✅ | 3 |
| **purchases** | **❌** | ✅ | ✅ | **0** |
| reports | ✅ | ✅ | ✅ | 1 |
| sales | ✅ | ✅ | ✅ | 1 |
| stylists | ✅ | ✅ | ✅ | 2 |
| core/auth | ✅ | ✅ | ✅ | 2 |
| core/users | ✅ | ✅ | ✅ | 1 |
| **core/roles** | ✅ | ✅ | ✅ | **0** |
| core/permissions | ✅ | — | — | 0 |
| core/health | — | — | — | 0 |

### Camino real de una petición

```
RequestContextMiddleware      abre AsyncLocalStorage: correlationId, IP, user-agent
        ↓
JwtAuthGuard (global)         verifica firma → RequestContextStore.patch({ tenantId })
        ↓
PermissionsGuard (global)     deniega por defecto si no hay @RequirePermissions ni @Public
        ↓
ScopedThrottlerGuard          'auth' solo donde se declara; short/medium/long globales
        ↓
ValidationPipe                whitelist + forbidNonWhitelisted + transform
        ↓
Controller (infrastructure)   sin lógica de negocio
        ↓
Use case (application)        orquesta; conoce puertos, no adaptadores
        ↓
Repository (infrastructure)   withMappedErrors(...) traduce fallos de persistencia
        ↓
PrismaService.client          devuelve la transacción activa si la hay
        ↓
applyGuardExtensions          inyecta tenantId + deletedAt; bloquea mutar append-only
        ↓
PostgreSQL                    EXCLUDE, CHECK, triggers, índices parciales
        ↓
ResponseEnvelopeInterceptor   { data, meta? }
        ↓
GlobalExceptionFilter         DomainError → HTTP; RFC 9457
```

Tres piezas merecen mención por ser mejores de lo habitual:

- **`PrismaService.transaction()` se une a la transacción activa** en lugar de anidar. Un caso de uso que llama a otro hereda la unidad de trabajo, que es lo que hace posible que `RegisterSaleUseCase` invoque a `ConsumeStockUseCase` de forma atómica.
- **La extensión degrada `findUnique` a `findFirst`** cuando ha inyectado `tenantId` o `deletedAt`, porque `findUnique` solo admite claves únicas. El `nextArgs` ya lleva los filtros, así que la llamada al cliente base no abre ningún hueco.
- **`RequestContextStore.runWithoutTenantScope`** pone el `await` dentro del ámbito. Sin eso, las promesas perezosas de Prisma saldrían del contexto antes de ejecutarse. Es un detalle que casi siempre se hace mal.

---

## 4. Architecture Violations

Control ejecutado, tal cual lo pide el encargo:

```bash
grep -rn "from '.*infrastructure" src/*/*/domain/ src/*/*/application/ --include=*.ts \
  | grep -v "\.spec\.ts:" | grep -v "import type"
```

**Resultado — 2 coincidencias, ambas en el mismo archivo:**

```
src/salon/purchases/application/purchases.service.ts:15:
  import { PrismaService } from '../../../shared/infrastructure/persistence/prisma/prisma.service';
src/salon/purchases/application/purchases.service.ts:16:
  import { QueryScopeStore } from '../../../shared/infrastructure/persistence/prisma/query-scope';
```

Control complementario — NestJS o Prisma dentro de `domain/`:

```bash
grep -rln "@nestjs\|@prisma/client" src/*/*/domain/ --include=*.ts | grep -v spec
```

**Resultado: ninguna coincidencia.** El dominio está limpio en los 13 módulos que lo tienen.

### Violaciones enumeradas

| # | Regla ADR-0001 | Ubicación | Estado |
| --- | --- | --- | --- |
| 1 | `domain/` no importa nada de fuera | — | ✅ Cumple en todo el repositorio |
| 2 | `application/` solo conoce dominio y puertos | `purchases.service.ts:15-16` | ❌ Importa `PrismaService` y `QueryScopeStore` |
| 3 | Nadie importa de `infrastructure/` salvo el módulo | `purchases.service.ts` | ❌ Misma causa |
| 4 | Inyección por token de puerto (`Symbol`) | `purchases.service.ts:21`, `:127` | ❌ `private prisma: PrismaService` es inyección por clase concreta |

Las cuatro son la misma causa raíz: compras no tiene puerto de repositorio porque no tiene dominio.

**No hay lógica de negocio en controladores** en ningún módulo: los controladores delegan siempre. **No hay lógica de negocio en adaptadores Prisma** salvo el mapeo, con la excepción de `prisma-role.repository.ts`, que hace comprobaciones de duplicado y de rol en uso dentro del repositorio (R0-BE-008).

---

## 5. Critical / High Findings

**Hallazgos CRITICAL: ninguno.**

Se buscó activamente fuga entre inquilinos —sección 8— y no se encontró vía explotable.

---

```text
ID:          R0-BE-005
Título:      El CI está en rojo: el gate de formato falla sobre 25 archivos
Severidad:   HIGH
Área:        CI / proceso
Archivo(s):  .github/workflows/ci.yml (job `static`), 25 archivos de src/ y test/
Línea(s):    ci.yml:47-48

Evidencia:
  $ npx prettier --check "src/**/*.ts" "test/**/*.ts"
  [warn] src/core/auth/application/password-reset.use-cases.ts
  [warn] src/core/auth/auth.module.ts
  ... (25 archivos)
  [warn] Code style issues found in 25 files.
  → exit code 1

  Los 25 están en src/core (11), src/salon (7), src/shared (2), test/integration (2)
  y src/core/*/module (3). Ninguno pertenece a apps/web, de modo que no los ha
  producido esta auditoría.

Problema:
  El job `static` de CI ejecuta exactamente ese comando y falla. El pipeline lleva
  rojo desde que se introdujeron esos archivos.

Impacto:
  Un gate que falla siempre deja de proteger. Los jobs `unit`, `integration` y
  `coverage` no dependen de `static`, así que siguen ejecutándose, pero el estado
  global del pipeline es fallo y deja de ser señal útil: nadie distingue "rojo de
  siempre" de "rojo porque acabo de romper algo". Es la vía por la que se cuela la
  siguiente regresión de verdad.

Cómo reproducir/verificar:
  npx prettier --check "src/**/*.ts" "test/**/*.ts"; echo $?

Recomendación:
  `npx prettier --write` sobre esos 25 archivos, en un commit único que no toque
  nada más para que el diff sea revisable de un vistazo. Después, hook de
  pre-commit con lint-staged para que no vuelva a acumularse.

Fase sugerida: R1
Confianza:     ALTA
```

---

```text
ID:          R0-BE-002
Título:      Compras no traduce los errores de persistencia: una restricción viola
             el contrato y devuelve 500
Severidad:   HIGH
Área:        Compras / manejo de errores (ADR-0008)
Archivo(s):  src/salon/purchases/application/purchases.service.ts
             src/shared/infrastructure/persistence/prisma/prisma-error.mapper.ts
             src/shared/infrastructure/http/filters/domain-exception.filter.ts
Línea(s):    purchases.service.ts:26-37 (create de proveedor), :168-260 (create de pedido)

Evidencia:
  1. Todo módulo con repositorio envuelve sus escrituras:
     $ grep -rln "withMappedErrors" src --include=*.ts | grep -v spec | grep -v mapper
     → 12 archivos: auth, users, appointments, cash, catalog, clients (x2),
       inventory, reports, sales, stylists, prisma-repository.base
     → purchases NO aparece. core/roles tampoco.

  2. `SuppliersService.create` llama directamente a
     `this.prisma.client.supplier.create(...)` sin try/catch.

  3. Existe el índice único parcial:
     CREATE UNIQUE INDEX "suppliers_tenant_code_uq"
       ON "suppliers" ("tenantId", "code") WHERE "deletedAt" IS NULL;

  4. `GlobalExceptionFilter` ramifica sobre `DomainError`,
     `MissingTenantScopeError` y `HttpException`. No tiene ninguna rama para
     `Prisma.PrismaClientKnownRequestError`.

Problema:
  La traducción de errores de Prisma vive en `withMappedErrors`, que se invoca
  desde los repositorios. Compras no tiene repositorio, así que P2002 y las
  violaciones de CHECK con nombre nunca llegan al traductor y caen en la rama
  genérica del filtro global.

Impacto:
  Dar de alta un proveedor con un código ya existente —acción rutinaria y error de
  usuario, no de programación— devuelve **500 con un cuerpo genérico** en lugar del
  409 `SUPPLIER_CODE_EXISTS` que el ADR-0008 promete. El cliente no puede ramificar
  sobre `code` porque no hay `code`. Además ensucia el log de errores con incidentes
  que no lo son, lo que degrada la señal cuando ocurra uno real.
  Afecta igualmente a `po_lines_quantities_valid` (ver R0-BE-003).

Cómo reproducir/verificar:
  Inspección del camino de llamada (los cuatro puntos de la evidencia son
  concluyentes por sí solos). No se ejecutó en runtime porque exigiría añadir un
  test de integración, prohibido en R0. Para confirmarlo en R1:
    POST /api/v1/suppliers { code: "PROV-1", name: "A" }   → 201
    POST /api/v1/suppliers { code: "PROV-1", name: "B" }   → se espera 500

Recomendación:
  A corto plazo, envolver las escrituras de `purchases.service.ts` en
  `withMappedErrors('Proveedor', …)` y añadir `suppliers_tenant_code_uq` y
  `po_lines_quantities_valid` a `CONSTRAINT_TRANSLATIONS`. La solución de fondo es
  el repositorio del R0-BE-001, que trae la traducción por construcción.

Fase sugerida: R1
Confianza:     ALTA
```

---

```text
ID:          R0-BE-003
Título:      Carrera leer-comprobar-escribir en la recepción de mercancía
Severidad:   HIGH
Área:        Compras / concurrencia
Archivo(s):  src/salon/purchases/application/purchases.service.ts
Línea(s):    300-330 (bucle de recepción)

Evidencia:
  const order = await this.prisma.client.purchaseOrder.findFirst({
    where: { id, status: { in: ['SUBMITTED','PARTIALLY_RECEIVED'] } },
    include: { lines: true },
  });
  for (const receipt of lines) {
    const line = order.lines.find(x => x.id === receipt.lineId);
    const remaining = roundQuantity(Number(line.quantity) - Number(line.receivedQuantity));
    if (!(receipt.quantity > 0) || receipt.quantity > remaining) throw ...;   // ← comprobación
    await this.receiveStock.execute({ ... });                                 // ← entrada de stock
    await this.prisma.client.purchaseOrderLine.update({
      where: { id: line.id },
      data: { receivedQuantity: { increment: receipt.quantity } },            // ← escritura
    });
  }

  PrismaService.transaction() no fija isolationLevel → READ COMMITTED (por defecto).

  Contraste: el ADR-0013 eliminó exactamente este patrón de inventario
  sustituyéndolo por un UPDATE condicional. Compras lo conserva.

  Red de seguridad existente:
  ALTER TABLE "purchase_order_lines"
    ADD CONSTRAINT "po_lines_quantities_valid" CHECK (
      "quantity" > 0 AND "receivedQuantity" >= 0
      AND "receivedQuantity" <= "quantity" AND "unitCost" >= 0 );

Problema:
  La comprobación de `remaining` usa el valor leído al abrir la transacción; el
  `increment` posterior es atómico pero la comprobación no. Dos recepciones
  simultáneas de la misma línea leen ambas `receivedQuantity = 0`, ambas superan la
  validación y ambas incrementan.

Impacto:
  **No hay corrupción de datos**: el CHECK `receivedQuantity <= quantity` rechaza la
  segunda escritura y PostgreSQL revierte la transacción entera, incluida la entrada
  de stock —el orden de las operaciones hace que el fallo caiga del lado seguro—.
  El impacto real es el modo de fallo: el segundo operario recibe un **500** (por
  R0-BE-002, la violación de CHECK no se traduce) en lugar de un 422
  `INVALID_RECEIPT_QUANTITY` explicando que otro acaba de recibir esa línea. En un
  almacén con dos personas descargando el mismo albarán, esto ocurre.

Cómo reproducir/verificar:
  Dos POST /api/v1/purchases/{id}/receive simultáneos sobre la misma línea con la
  cantidad pendiente completa. No existe test que lo cubra: `Promise.all` solo
  aparece en inventory.integration.spec.ts y reports.integration.spec.ts.

Recomendación:
  Trasladar el patrón del ADR-0013: UPDATE condicional
  `WHERE id = :id AND "receivedQuantity" + :cantidad <= "quantity"` y decidir sobre
  el número de filas afectadas. Añadir el test de concurrencia que hoy falta.

Fase sugerida: R1
Confianza:     ALTA
```

---

## 6. Medium / Low Findings

```text
ID:          R0-BE-001
Título:      Compras sin capa de dominio; `application` acoplado a Prisma
Severidad:   MEDIUM
Área:        Arquitectura (ADR-0001)
Archivo(s):  src/salon/purchases/**  (3 archivos en total)
Línea(s):    purchases.service.ts:15-16, :21-24, :127-135

Evidencia:
  $ find src/salon/purchases -type f
  src/salon/purchases/application/purchases.service.ts        371 líneas
  src/salon/purchases/infrastructure/http/purchases.controller.ts  36 líneas
  src/salon/purchases/purchases.module.ts

  Sin domain/. Sin entidad PurchaseOrder. Sin value objects. Sin puerto de
  repositorio. Sin un solo .spec.ts.

Problema:
  Las reglas de negocio —máquina de estados DRAFT→SUBMITTED→PARTIALLY_RECEIVED→
  RECEIVED/CANCELLED, validación de cantidad pendiente, composición del número de
  documento, cálculo de totales— viven en un servicio de aplicación que habla con
  Prisma. No hay nada que probar sin base de datos.

Impacto:
  Es la causa raíz de R0-BE-002, R0-BE-003 y R0-BE-004. La cobertura del módulo
  (95,2 % sentencias) procede **íntegramente de la suite de integración**: sin
  dominio no hay test unitario posible, y las ramas se quedan en 72,1 %, la segunda
  peor del repositorio. El README lo reconoce como la única excepción estructural.

Cómo reproducir/verificar:
  El grep de la sección 4; `find src/salon/purchases -type f`.

Recomendación: ver sección 7.
Fase sugerida: R1
Confianza:     ALTA
```

```text
ID:          R0-BE-004
Título:      `GET /purchases` y `GET /suppliers` no paginan y arrastran relaciones anidadas
Severidad:   MEDIUM
Área:        Compras / API / rendimiento (ADR-0007)
Archivo(s):  src/salon/purchases/application/purchases.service.ts:136-152, :26-37
             src/salon/purchases/infrastructure/http/purchases.controller.ts

Evidencia:
  class ListPurchasesQueryDto { @IsOptional() @IsEnum(PurchaseOrderStatus) status?: ... }
  // no declara page ni limit

  list(status?) {
    return this.prisma.client.purchaseOrder.findMany({
      where: status ? { status } : {},
      include: { supplier: {...}, lines: { include: { product: {...} } } },
      orderBy: { createdAt: 'desc' },
    });                                    // sin take, sin skip
  }

  SuppliersService.list(search?) → findMany sin take/skip.

  El ADR-0007 fija page/limit (máximo 100, por defecto 20) para toda colección.

Problema:
  Dos colecciones devuelven el histórico entero. La de pedidos, además, con
  proveedor, líneas y producto de cada línea.

Impacto:
  Doble. (a) El payload crece sin cota con la antigüedad del salón; un salón con dos
  años de pedidos devuelve miles de filas hidratadas en una sola respuesta.
  (b) Riesgo de contrato: `forbidNonWhitelisted: true` es global (main.ts:76), de
  modo que si un cliente envía `?page=1&limit=20` a `/purchases` recibe **400**,
  porque el DTO no declara esos campos. El BFF de `apps/web`
  (`app/api/purchases/route.ts`) ya reenvía page/limit cuando están presentes; hoy
  la pantalla no los manda para pedidos, así que el fallo está latente, no vivo.

Cómo reproducir/verificar:
  GET /api/v1/purchases?page=1&limit=20  → se espera 400 (property page should not exist)

Recomendación:
  Adoptar `PrismaRepositoryBase`, que ya implementa paginación, ordenación y filtrado
  una sola vez, al construir el repositorio del R0-BE-001. Recortar el `include` del
  listado: la pantalla no necesita el producto de cada línea para pintar la rejilla.

Fase sugerida: R1
Confianza:     ALTA
```

```text
ID:          R0-BE-006
Título:      `PERMISSION_DENIED` declarado en el esquema y en los puertos, nunca emitido
Severidad:   LOW
Área:        Seguridad / auditoría (ADR-0004, ADR-0006)
Archivo(s):  prisma/schema.prisma:1181  (enum AuditAction)
             src/shared/application/ports.ts:118  (unión de tipos)
             src/shared/infrastructure/security/guards.ts:139-160  (PermissionsGuard)

Evidencia:
  $ grep -rn "PERMISSION_DENIED" src prisma
  src/shared/application/ports.ts:118:  | 'PERMISSION_DENIED'
  prisma/schema.prisma:1181:  PERMISSION_DENIED
  → dos declaraciones, ningún uso.

  Acciones realmente emitidas:
  $ grep -rhoE "action: '[A-Z_]+'" src --include=*.ts | sort | uniq -c
    24 UPDATE   19 CREATE   11 DELETE    5 RESTORE   4 LOGIN_FAILED
     2 TOKEN_REUSE_DETECTED   1 TOKEN_REFRESH   1 LOGOUT   1 LOGIN
     1 EXPORT   1 ANONYMIZE
  → PERMISSION_DENIED: 0.

  `PermissionsGuard.canActivate` lanza `ForbiddenException` sin escribir auditoría.

Problema:
  El proyecto declara la acción y no la implementa. Un 403 no deja rastro.

Impacto:
  Bajo en integridad, relevante en detección. Hoy no se puede responder a «¿alguien
  ha estado tanteando endpoints para los que no tiene permiso?», que es la señal
  temprana de una cuenta comprometida o de un empleado curioseando. Los 401 sí
  quedan (`LOGIN_FAILED`); el escalón siguiente, no.

Análisis del riesgo de implementarlo (lo pide expresamente el encargo):
  • Riesgo real de inundación de tabla. `AuditLog` es append-only y sin soft delete
    (ADR-0004): crece y no se poda. Un bucle de cliente mal escrito contra un
    endpoint denegado genera un INSERT por petición.
  • El vector es acotable pero no nulo: el 403 exige un access token válido, así que
    el atacante debe estar autenticado y su cupo lo limitan los throttlers
    short/medium/long. No es un DoS anónimo.
  • El coste no es solo espacio: es un INSERT sincrónico en el camino de una
    petición que iba a ser rechazada, lo que abarata el ataque en lugar de encarecerlo.
  • Alternativas por orden de coste:
      1. Registrar el 403 en el log estructurado con `correlationId` y NO en
         `AuditLog`. Cubre la detección sin tocar el modelo de datos ni la latencia.
         Es la opción recomendada.
      2. Escribir en `AuditLog` con antirrebote por (usuario, permiso, ventana de
         5 min), de modo que N intentos den una fila.
      3. Escribir siempre, y añadir partición temporal y política de retención.
  • ¿Requiere ADR? Solo la opción 2 o 3. La 1 es una decisión de implementación
    dentro del ADR-0004 vigente. Si se elige 2 o 3, sí: cambia la naturaleza de
    `AuditLog` de «hechos de negocio» a «hechos de seguridad», que tienen volumen y
    retención distintos.

Recomendación:
  Implementar la opción 1 en R2 y retirar `PERMISSION_DENIED` del enum, o
  documentar en el ADR-0004 por qué se conserva sin uso. Un enum con un valor
  muerto hace creer que la funcionalidad existe.

Fase sugerida: R2
Confianza:     ALTA
```

```text
ID:          R0-BE-007
Título:      Contrato OpenAPI incompleto en cuatro controladores
Severidad:   MEDIUM
Área:        API (ADR-0007)
Archivo(s):  roles.controller.ts, users.controller.ts, purchases.controller.ts,
             inventory.controllers.ts, cash.controllers.ts, sales.controllers.ts

Evidencia (@ApiOperation frente a endpoints declarados):
  auth.controller.ts               8 / 7    ✅
  appointments.controller.ts      12 / 11   ✅
  catalog.controllers.ts          13 / 12   ✅
  stylists.controller.ts          12 / 11   ✅
  clients.controller.ts            8 / 7    ✅
  client-photos.controller.ts      6 / 5    ✅
  reports.controller.ts            3 / 2    ✅
  inventory.controllers.ts         8 / 12   ⚠️
  cash.controllers.ts              4 / 5    ⚠️
  sales.controllers.ts             3 / 4    ⚠️
  roles.controller.ts              0 / 5    ❌
  users.controller.ts              0 / 7    ❌
  purchases.controller.ts          0 / 11   ❌

Problema:
  23 endpoints sin descripción en el contrato, 23 de ellos en tres controladores que
  además están escritos en una línea por endpoint, lo que hace poco probable que se
  documenten por inercia.

Impacto:
  El ADR-0007 vende el OpenAPI como el artefacto del que los clientes generan sus
  SDK. Un cliente que genere desde este contrato obtiene métodos sin descripción ni
  códigos de error declarados para administración, usuarios y compras —justo la
  superficie más delicada—. No es un fallo de runtime: los endpoints aparecen en el
  esquema, pero sin semántica.

Cómo reproducir/verificar:
  Arrancar con SWAGGER_ENABLED=true y abrir /api/docs; comparar con el conteo.

Recomendación:
  Aplicar `@ApiCrudResource()` —el decorador que el ADR-0002 creó justo para esto—
  en roles y usuarios. Compras se documenta al reescribirlo en R1.

Fase sugerida: R2
Confianza:     ALTA
```

```text
ID:          R0-BE-008
Título:      `core/roles` sin tests unitarios y con comprobación de duplicado leer-escribir
Severidad:   MEDIUM
Área:        Core / testing / concurrencia
Archivo(s):  src/core/roles/infrastructure/persistence/prisma-role.repository.ts:17-19
Línea(s):    17 (create), 18 (update), 19 (delete)

Evidencia:
  Cobertura del módulo: 86,9 % sentencias / 60,0 % ramas → la peor del repositorio.
  0 archivos .spec.ts en src/core/roles.

  create: const duplicate = await findFirst({ where: { tenantId, code, deletedAt: null } });
          if (duplicate) throw new ConflictError('ROLE_CODE_EXISTS', ...);
          ... await role.create(...)                        ← leer-comprobar-escribir

  El repositorio no usa withMappedErrors (no aparece en el grep de la sección 5),
  pese a existir el índice "roles_tenant_code_uq".

  Además contiene reglas de negocio —«no se puede eliminar un rol asignado a
  usuarios»— dentro del adaptador de persistencia, no en el dominio.

Problema:
  Tres cosas a la vez: sin tests unitarios, con una carrera en la comprobación de
  unicidad, y con lógica de negocio en la capa equivocada.

Impacto:
  Dos administradores creando el mismo código de rol a la vez: uno recibe el 409
  correcto y el otro un 500, porque el índice único salta y nadie lo traduce. Es el
  mismo modo de fallo que R0-BE-002, en otro módulo. La regla «rol en uso» no se
  puede probar sin base de datos.

Recomendación:
  Envolver en `withMappedErrors`, añadir `roles_tenant_code_uq` a
  `CONSTRAINT_TRANSLATIONS`, y subir la regla de «rol en uso» al dominio con su
  test unitario.

Fase sugerida: R2
Confianza:     ALTA
```

```text
ID:          R0-BE-009
Título:      Sin métricas ni trazas
Severidad:   MEDIUM
Área:        Observabilidad
Archivo(s):  package.json, src/**

Evidencia:
  $ grep -rn "prom-client|opentelemetry|@opentelemetry|metrics" package.json src
  → sin coincidencias.

  Lo que sí existe: HttpLoggingInterceptor (método, ruta, estado, duración,
  correlationId, userId, tenantId), sondas /health/live y /health/ready con
  Terminus, AuditLog con diff before/after, propagación de x-correlation-id
  entrante.

Problema:
  Se puede reconstruir qué pasó en una petición concreta si se conoce su
  correlationId. No se puede responder a preguntas agregadas: percentil 95 de
  latencia, tasa de error por endpoint, saturación del pool de conexiones,
  duración de las transacciones.

Impacto:
  En producción esto significa enterarse de las degradaciones por el aviso del
  usuario en lugar de por una alerta. No impide desplegar; impide operar.

Recomendación:
  R3: `prom-client` con histograma de latencia por ruta y contadores de error, más
  las métricas del pool de Prisma. Trazas distribuidas solo cuando haya un segundo
  servicio con el que correlacionar; hoy no lo hay.

Fase sugerida: R3
Confianza:     ALTA
```

```text
ID:          R0-BE-010
Título:      Rate limiting en memoria: no sobrevive a la segunda réplica
Severidad:   LOW  (deuda ya documentada)
Área:        Seguridad / operación (ADR-0007)
Evidencia:   ThrottlerModule sin almacén externo; el propio ADR-0007 lo anota como
             «deuda operativa».
Impacto:     Con N réplicas, el límite efectivo de /auth/login pasa de 5 a 5·N
             intentos por ventana. El bloqueo por intentos fallidos del ADR-0005
             (failedLoginAttempts / lockedUntil, en base de datos) sigue actuando y
             es el que realmente contiene la fuerza bruta, así que la degradación es
             gradual y no un agujero.
Recomendación: Redis como almacén, o mover el límite al balanceador, antes de
             escalar a más de una instancia.
Fase sugerida: R3
Confianza:     ALTA
```

```text
ID:          R0-BE-011
Título:      Cobertura de ramas a 0,2 puntos del umbral
Severidad:   LOW
Área:        Testing
Evidencia:   Branches 80,2 % (2411/3006) frente a coverageThreshold.branches = 80.
Impacto:     Aproximadamente seis ramas nuevas sin cubrir bastan para romper el job
             `coverage`. El siguiente que toque compras o inventario se encontrará
             el CI en rojo por un motivo que no es suyo.
Recomendación: Subir las ramas de inventory (75,9 %) y core/auth (74,3 %), los dos
             módulos que arrastran la media, antes de añadir superficie nueva.
Fase sugerida: R2
Confianza:     ALTA
```

```text
ID:          R0-BE-012
Título:      758 warnings de ESLint, concentrados en los dobles y las suites de integración
Severidad:   LOW
Área:        Calidad
Evidencia:   0 errores, 758 warnings.
               370  @typescript-eslint/no-unsafe-member-access
               282  @typescript-eslint/no-unsafe-argument
                92  @typescript-eslint/require-await
                 7  no-unsafe-return   6  no-unsafe-call   1  no-unsafe-assignment
             Concentrados en test/doubles/*, test/integration/* y 4 archivos de src.
Problema:    `npm run lint` no lleva --max-warnings, así que el CI pasa con 758
             warnings. El frontend sí usa --max-warnings=0.
Impacto:     Bajo. La causa dominante es `response.body` de supertest, que es `any`
             por diseño. Pero un contador de 758 hace invisible el warning número 759.
Recomendación: Tipar el cuerpo de las respuestas en los helpers de test y fijar
             --max-warnings=0 cuando el número esté cerca de cero.
Fase sugerida: R2
Confianza:     ALTA
```

```text
ID:          R0-BE-013
Título:      La auditoría de compras se escribe fuera de la transacción
Severidad:   LOW
Área:        Compras / auditoría
Archivo(s):  purchases.service.ts:262-263, :332-338
Evidencia:   const order = await this.prisma.transaction(async () => { ... });
             await this.audit.record({ action: 'CREATE', entityType: 'PurchaseOrder', ... });
Problema:    Si el registro de auditoría falla, el pedido ya está confirmado.
Impacto:     Un pedido sin rastro de auditoría. No corrompe datos y el resto de
             módulos usa el interceptor, no esta llamada manual.
Recomendación: Mover dentro de la transacción al construir el repositorio (R0-BE-001).
Fase sugerida: R1
Confianza:     ALTA
```

```text
ID:          R0-BE-014
Título:      El directorio de trabajo no está bajo control de versiones
Severidad:   MEDIUM
Área:        Proceso
Evidencia:   $ git status --short
             fatal: not a git repository (or any of the parent directories): .git
             Existe .github/workflows/ci.yml, luego el proyecto está pensado para git.
Problema:    Esta copia no tiene historial.
Impacto:     Ninguna auditoría puede diferenciar contra una línea base, no hay forma
             de revertir un cambio, y el paso de control de cambios que el propio
             encargo R0 exige al cerrar es inejecutable. Para un repositorio de
             27 000 líneas con CI configurado, es un riesgo operativo de primer orden.
Recomendación: `git init`, commit inicial y remoto antes de cualquier trabajo de R1.
Fase sugerida: R1 (antes que nada)
Confianza:     ALTA
```

---

## 7. Purchases Gap Analysis

Cómo debería evolucionar en R1. **No se escribe código aquí**; es el diseño propuesto.

### Estado actual

```
purchases/
├── application/purchases.service.ts     371 líneas, 2 clases, acoplado a Prisma
├── infrastructure/http/purchases.controller.ts   36 líneas, 11 endpoints, 1 línea cada uno
└── purchases.module.ts
```

Cero dominio, cero puertos, cero tests unitarios, cero documentación OpenAPI.

### Estructura propuesta

```
purchases/
├── domain/
│   ├── purchase-order.entity.ts       AggregateRoot: estado, líneas, totales
│   ├── purchase-order-line.entity.ts  cantidad pedida / recibida / pendiente
│   ├── supplier.entity.ts             código, contacto, plazo de pago, estado
│   ├── receipt.vo.ts                  línea recibida: cantidad, lote, caducidad
│   ├── purchase-order.repository.ts   PUERTO (Symbol)
│   ├── supplier.repository.ts         PUERTO (Symbol)
│   └── purchases.errors.ts            errores con código estable
├── application/
│   ├── create-purchase-order.use-case.ts
│   ├── submit-purchase-order.use-case.ts
│   ├── receive-purchase-order.use-case.ts
│   ├── cancel-purchase-order.use-case.ts
│   └── supplier.use-cases.ts          CRUD genérico parametrizado (ADR-0002)
└── infrastructure/
    ├── persistence/prisma-purchase-order.repository.ts   extiende PrismaRepositoryBase
    ├── persistence/prisma-supplier.repository.ts
    └── http/purchases.controller.ts + purchases.dto.ts + purchases.response.ts
```

### Reglas que suben al dominio

| Regla | Hoy | Debe vivir en |
| --- | --- | --- |
| Máquina de estados del pedido | `updateMany` con `where: { status }` disperso | `PurchaseOrder.submit() / cancel() / receive()` |
| Cantidad recibida ≤ pedida | `if (receipt.quantity > remaining)` en el servicio | `PurchaseOrderLine.receive(quantity)` |
| Un pedido necesita ≥1 línea | `if (!input.lines.length)` al principio | Constructor del agregado |
| Tipo impositivo por defecto = el del producto | `taxRateOf` Map en el servicio | Argumento del caso de uso; la regla, en la línea |
| Total = Σ totales de línea | `Money.sum` en el servicio | `PurchaseOrder.recalculateTotals()` |
| Cierre automático al completar | `refreshed.every(...)` tras releer | `PurchaseOrder.isFullyReceived()` |

### Las tres correcciones que el rediseño trae de regalo

1. **Concurrencia (R0-BE-003).** El puerto declara
   `receiveLine(lineId, quantity): Promise<boolean>` y el adaptador lo resuelve con
   `UPDATE ... SET "receivedQuantity" = "receivedQuantity" + :q WHERE id = :id AND "receivedQuantity" + :q <= "quantity"`,
   decidiendo sobre el número de filas afectadas. Es literalmente el patrón del ADR-0013.
2. **Traducción de errores (R0-BE-002).** `PrismaRepositoryBase` ya envuelve en
   `withMappedErrors`; solo hay que añadir las dos restricciones a `CONSTRAINT_TRANSLATIONS`.
3. **Paginación (R0-BE-004).** `PrismaRepositoryBase` ya implementa page/limit/sort/filter.

### Lo que NO hay que tocar

El contrato HTTP. Los ADR-0013, 0014 y 0015 sustituyeron tres motores completos
manteniendo la API byte a byte, y `apps/web` no se enteró. Compras debe seguir la
misma disciplina: mismas rutas, mismos nombres de campo, misma forma de respuesta —
con la única salvedad de **añadir** `page`/`limit` a los dos listados, que es una
ampliación compatible.

### Orden sugerido

1. Entidades y value objects, con sus tests unitarios. Sin tocar el servicio.
2. Puertos y adaptadores Prisma sobre `PrismaRepositoryBase`.
3. Casos de uso, uno por operación.
4. Sustituir el servicio en el módulo; el controlador cambia de dependencia, no de forma.
5. Test de concurrencia de recepción + test de duplicado de proveedor (los dos que faltan).
6. `@ApiCrudResource()` en los 11 endpoints.

### Presupuesto de tests

El módulo debería pasar de 0 unitarios a ~55 (comparable a sales, 59) y de 20
integración a ~24, con las dos carreras cubiertas.

---

## 8. Multi-Tenant Threat Analysis

Es la propiedad crítica del sistema. Se auditó buscando activamente la fuga.

### Cadena verificada

```
JWT claim tenantId
  → JwtAuthGuard.canActivate (guards.ts:66)  ← ÚNICO punto de entrada
  → RequestContextStore.patch({ tenantId })
  → AsyncLocalStorage (aislado incluso a través de await)
  → applyGuardExtensions → where.tenantId / data.tenantId inyectados
  → repositorio
  → PostgreSQL con @@unique compuesto por tenantId
```

### Rutas de escape examinadas

| Vía | Resultado | Evidencia |
| --- | --- | --- |
| `tenantId` desde el body | ❌ Imposible | Ningún DTO lo declara; el único origen es `claims.tenantId` |
| Desde query | ❌ Imposible | `forbidNonWhitelisted` rechaza el campo no declarado |
| Desde cabecera | ❌ Imposible | Solo se leen `x-correlation-id`, `x-request-id`, `x-forwarded-for`, `authorization`; ninguna alimenta el tenant |
| Lectura sin filtro | ❌ Bloqueada | `MissingTenantScopeError` si `tenantId === null` en modelo con ámbito |
| Escritura sin tenant | ❌ Bloqueada | `CREATE_OPERATIONS` inyecta `tenantId` en `data` y en `create` de `upsert` |
| **SQL crudo** | ✅ Sin exposición | `grep queryRaw\|executeRaw src` → 3 usos, todos en `PrismaService`: `SELECT 1` (salud) y `truncateAll()` (guardado por `NODE_ENV=test`). **Cero SQL crudo de negocio.** |
| **Escrituras anidadas** | ⚠️ Límite conocido | `create({ data: { lines: { create: [...] } } })` no pasa por la extensión en los hijos. Los repositorios ponen `tenantId` explícitamente —verificado en `purchases.service.ts:246` y en los adaptadores de sales— y hay tests de integración que lo comprueban |
| `findUnique` degradado | ✅ Correcto | La llamada al cliente base recibe `nextArgs` **con** los filtros ya inyectados; no se salta nada |
| Bypasses explícitos | ✅ Justificados | 8 usos de `crossTenant`: login por correo (aún no se sabe el salón), refresh por hash, roles de sistema con `tenantId: null`, y el grabador de auditoría. Ninguno acepta entrada del usuario para decidir el ámbito |
| `TENANT_EXEMPT_MODELS` | ✅ Razonable | `Tenant`, `Permission` (globales), `RolePermission`/`UserRole` (puente: heredan ámbito de sus extremos), `RefreshToken`/`PasswordResetToken` (se buscan por su propio hash antes de conocer el salón) |
| Modelos nuevos | ✅ Falla seguro | La lista es de exención, no de inclusión: un modelo nuevo queda con ámbito por defecto |
| Jobs / seeds | ✅ Acotados | `runAsTenant` y `runWithoutTenantScope`, con nombres deliberadamente incómodos |
| 403 vs 404 | ✅ Correcto | ADR-0008: fuera del tenant todo es «no existe»; un 403 confirmaría la existencia |

### Suite dedicada

`test/integration/tenant-isolation.integration.spec.ts` ejecuta y pasa. El ADR-0009
eleva estos tests a primera clase: «un usuario del salón A **debe** recibir 404 al
pedir un recurso del salón B».

### Conclusión

**No se ha encontrado ninguna fuga entre inquilinos explotable.** El único hueco
estructural —escrituras anidadas— exige que un desarrollador escriba un `create`
anidado *y* omita el `tenantId` del hijo *y* que ningún test lo detecte. El
`PLATFORM_ADMIN` con `tenantId: null` obliga a indicar el tenant explícitamente, que
es el diseño correcto.

**Riesgo residual:** el aislamiento es lógico, no físico. Un fallo en la extensión de
Prisma sería sistémico y silencioso. La mitigación definitiva es Row Level Security,
correctamente pospuesta y documentada en el ADR-0003. **Recomendación: elevarlo a R4**,
porque es lo único que cubre también los dos huecos conocidos.

---

## 9. Security Review

### OWASP Top 10 (2021)

| Riesgo | Estado | Evidencia |
| --- | --- | --- |
| A01 Control de acceso roto | ✅ | RBAC por permisos, denegación por defecto, `.own` para pertenencia en el dominio, 404 sobre 403 entre tenants |
| A02 Fallos criptográficos | ✅ | Argon2id (19 MiB / t=2 / p=1), refresh **hasheado** en base, secretos ≥32 caracteres y obligatoriamente distintos |
| A03 Inyección | ✅ | Prisma parametrizado; sin SQL crudo de negocio; ordenación por lista blanca de campos |
| A04 Diseño inseguro | ✅ | Invariantes en la base, no solo en el código |
| A05 Configuración incorrecta | ✅ | `env.schema.ts` aborta el arranque: CORS `*` o vacío en producción, Swagger activo en producción, secretos por defecto |
| A06 Componentes vulnerables | ⚠️ | GHSA-ggr8-5vv4-36mx en `deepmerge-ts` vía CLI de Prisma. Riesgo aceptado y documentado en ADR-0002: solo en build, no en la imagen de producción |
| A07 Fallos de identificación | ✅ | Respuesta uniforme en login con hash señuelo, bloqueo por intentos, rotación de refresh con detección de reutilización y revocación de familia |
| A08 Integridad de datos | ✅ | `AuditLog` y kardex append-only por trigger, no por convenio |
| A09 Fallos de registro | ⚠️ | Bueno para 401 y auth; **falta el 403** (R0-BE-006). Sin métricas ni alertas (R0-BE-009) |
| A10 SSRF | ✅ | No hay superficie: la API no hace peticiones salientes con URL del usuario |

### Detalle

- **JWT / HS256.** Secretos distintos para access y refresh, validados a ≥32 caracteres, con `refine` que impide reutilizar el mismo. Un refresh no puede presentarse como access.
- **`tokenVersion`.** Se compara al refrescar, no en cada petición. **Ventana consciente de hasta 15 minutos** en la que un access token de cuenta revocada sigue valiendo. El ADR-0005 lo dice sin adornos y ofrece la salida (lista de revocación por `jti`) si algún caso no lo tolerase. Es una decisión, no un descuido.
- **Reset de contraseña.** Tokens de un solo uso en tabla propia, 204 sin cuerpo, respuesta idéntica exista o no la cuenta.
- **Enumeración de usuarios.** Cubierta en login y en recuperación.
- **Rate limiting.** Tres niveles globales más `auth` de ámbito acotado. El `ScopedThrottlerGuard` existe porque el throttler de auth limitaba la API entera a 5 peticiones cada 15 minutos —lo encontró la suite de integración, y está documentado en el propio archivo—.
- **Helmet / CORS / HSTS.** HSTS de un año con `includeSubDomains` y `preload` solo en producción. CORS por lista blanca, nunca `*` con credenciales. `trust proxy` a 1 en producción para que el rate limiting por IP distinga clientes.
- **Mass assignment.** `whitelist` + `forbidNonWhitelisted`: un campo no declarado es 400.
- **Errores 5xx.** El filtro global no revela stack ni mensaje interno; devuelve cuerpo genérico con `correlationId`.
- **Logging sensible.** El log de consultas de Prisma está **deliberadamente desactivado** para no volcar correos, teléfonos e importes al recolector. El interceptor HTTP registra método, ruta, estado y duración; ni cuerpos ni cabeceras.
- **Subida de ficheros.** Tipo deducido de los bytes mágicos con lista blanca, ruta construida por el sistema sin entrada del cliente, `Content-Disposition: attachment`, `nosniff`, `CHECK` de `mimeType LIKE 'image/%'`, URL firmadas de 15 minutos sobre bucket privado.

### Sin hallazgos de seguridad de severidad HIGH o superior.

---

## 10. Database & Concurrency Review

### Invariantes documentadas — estado verificado

| Invariante | DOCUMENTADO | IMPLEMENTADO | PROBADO |
| --- | :-: | :-: | :-: |
| Citas no solapadas | ADR-0007/0011 | ✅ `EXCLUDE USING gist` + `btree_gist` | ✅ `appointments.integration.spec.ts` |
| Auditoría inmutable | ADR-0004 | ✅ trigger `audit_logs_append_only` + extensión | ✅ `persistence.integration.spec.ts` |
| Kardex inmutable | ADR-0011 | ✅ trigger `inventory_movements_append_only`; el puerto no declara `update` | ✅ `inventory.integration.spec.ts` |
| Stock no negativo | ADR-0011 | ✅ `CHECK ("stockOnHand" >= 0)` + UPDATE condicional | ✅ concurrencia real con `Promise.all` |
| Una sola caja abierta | ADR-0014 | ✅ `cash_sessions_one_open_per_tenant` (único parcial) | ✅ `sales-cash.integration.spec.ts` |
| Reutilización de email tras baja | ADR-0004 | ✅ únicos parciales `WHERE deletedAt IS NULL`, con `lower()` | ✅ `users-roles.integration.spec.ts` |
| Consistencia de líneas de factura | ADR-0014 | ✅ `invoice_lines_amounts_valid`, `invoices_amounts_valid`, `invoice_lines_reference_matches_kind` | ✅ `sales-cash.integration.spec.ts` |
| **Recepción ≤ pedido** | — | ✅ `po_lines_quantities_valid` (solo en base) | ❌ **sin test de concurrencia** |

### Esquema

- `Decimal(12,2)` para dinero; `Money` en el dominio; cadena decimal en JSON. Coherente de extremo a extremo.
- Toda clave única de negocio es compuesta con `tenantId`, y usa `COALESCE(tenantId, '000…')` donde el tenant es nullable, porque en SQL `NULL <> NULL`. Es un detalle que se olvida a menudo y aquí está resuelto.
- Índices parciales `WHERE "deletedAt" IS NULL` para que el soft delete no bloquee la reutilización.
- Índices de consulta que empiezan por `tenantId`, más trigrama para la búsqueda de clientes por nombre en caja.
- `TIMESTAMPTZ(3)` en todas las marcas temporales.

### Concurrencia — dónde hay atomicidad real

| Operación | Mecanismo | Veredicto |
| --- | --- | --- |
| Descuento de stock | `UPDATE ... WHERE stockOnHand >= :q`, decisión por filas afectadas | ✅ Sin ventana |
| Consumo de lote FEFO | `BatchRepository.consume` condicional + `CHECK` de respaldo | ✅ Sin ventana |
| Apertura de caja | Índice único parcial | ✅ La base decide |
| Numeración de documentos | `upsert` con `increment` dentro de la transacción del documento | ✅ Sin huecos ni repetidos |
| Venta completa | Transacción única que delega inventario | ✅ Atómica |
| Envío/cancelación de pedido | `updateMany` con `where: { status }` | ✅ Condicional |
| **Recepción de mercancía** | Leer → comprobar → `increment` | ❌ **Ventana de carrera** (R0-BE-003) |
| **Creación de rol** | Leer duplicado → crear | ❌ Ventana; el índice salta y da 500 (R0-BE-008) |

Nivel de aislamiento: `PrismaService.transaction()` no fija `isolationLevel`, luego
READ COMMITTED. Es la elección correcta dado que las garantías se apoyan en
sentencias condicionales y restricciones, no en el aislamiento.

### N+1 y consultas costosas

- **No se detectó N+1** en los adaptadores: se usa `include`/`select` explícito.
- `ReportingRepository` devuelve **hechos**, no filas hidratadas, y pide solo las columnas que usa (ADR-0015).
- `PurchasesService.list()` es lo más cercano a un problema: sin paginar y con
  `include` de tres niveles (R0-BE-004).
- Agregación de informes en memoria: decisión explícita del ADR-0015, con el puerto
  ya colocado para bajarla a SQL cuando haga falta.

---

## 11. Testing Reality Check

### Batería ejecutada

| Comando | Resultado | Duración | Tests | Fallos |
| --- | --- | ---: | ---: | ---: |
| `npm run typecheck` | ✅ PASA | ~12 s | — | 0 |
| `npm run lint` | ⚠️ PASA con 758 warnings | ~40 s | — | 0 errores |
| `npx prettier --check "src/**/*.ts" "test/**/*.ts"` | ❌ **FALLA** | ~6 s | — | 25 archivos |
| `npm run build` | ✅ PASA | 15,4 s | — | 0 |
| `npm run test:unit` | ✅ PASA | 2,9 s | 832 (33 suites) | 0 |
| `npm run test:integration` | ✅ PASA | 69,0 s | 283 (12 suites) | 0 |
| `npm run test:cov` | ✅ PASA | 75,8 s | **1 115** (45 suites) | 0 |

Requisito previo ejecutado: `docker compose up -d postgres-test minio` y
`prisma migrate deploy` contra `salon_test` (14 migraciones).

### Cobertura

| Métrica | Medido | Umbral | Margen |
| --- | ---: | ---: | ---: |
| Sentencias | 94,40 % (5098/5400) | 90 % | +4,40 |
| Ramas | **80,20 %** (2411/3006) | 80 % | **+0,20** |
| Funciones | 93,63 % (1500/1602) | 90 % | +3,63 |
| Líneas | 94,85 % (4459/4701) | 90 % | +4,85 |

Por módulo, de peor a mejor en sentencias:

```
core/roles            86,9 %   ramas 60,0 %     ← sin tests unitarios
salon/inventory       90,1 %   ramas 75,9 %
salon/sales           91,3 %   ramas 84,6 %
core/auth             93,4 %   ramas 74,3 %
salon/clients         94,0 %   ramas 76,8 %
shared/infrastructure 94,5 %   ramas 86,1 %
salon/cash            94,9 %   ramas 80,2 %
salon/purchases       95,2 %   ramas 72,1 %     ← 100 % desde integración
salon/catalog         96,0 %   ramas 80,4 %
salon/appointments    96,5 %   ramas 80,2 %
core/users            96,9 %   ramas 88,5 %
salon/reports         97,0 %   ramas 82,4 %
salon/stylists        97,0 %   ramas 81,6 %
shared/domain         98,8 %   ramas 89,7 %
```

### README CLAIM vs realidad

| Afirmación del README | Estado | Comprobación |
| --- | --- | --- |
| «832 tests unitarios en ~3 s» | ✅ **VERIFIED** | 832 en 2,893 s |
| «282 tests de integración» | ⚠️ **VERIFIED con desviación** | 283. Uno más |
| «1.114 tests en verde» | ⚠️ **VERIFIED con desviación** | 1.115 |
| «los cuatro umbrales cumplidos» | ✅ **VERIFIED** | Sí, ramas por 0,2 puntos |
| «Líneas 94,86 % / Sentencias 94,37 % / Funciones 93,50 %» | ✅ **VERIFIED** | 94,85 / 94,40 / 93,63 |
| «compras sigue sin capa de dominio» | ✅ **VERIFIED** | Confirmado; el README es honesto |
| «la única excepción del repositorio es compras» | ✅ **VERIFIED** | El grep devuelve 2 coincidencias, ambas allí |
| «la extensión de Prisma es la red de seguridad» | ✅ **VERIFIED** | Leída y comprobada |
| «apps/web tiene 2 unitarios y 11 e2e» | ❌ **CONTRADICTED** | Antes de esta sesión: 13 unitarios en 4 archivos y 16 casos e2e (32 ejecuciones en 2 proyectos). El README está desactualizado a la baja |
| «20 tests de integración de compras» | ✅ **VERIFIED** | 21 `it` en el spec |
| «9 tests de integración de auth» | ✅ **VERIFIED** | Presentes |

**No se encontró ninguna afirmación del README que exagere el estado del sistema.**
Las desviaciones son de una unidad y en la dirección conservadora, salvo la del
frontend, que se queda corta. Es notable: lo habitual es lo contrario.

### Calidad de los tests, no solo cantidad

**Lo bueno, y es genuinamente bueno:**

- Los dobles **implementan el puerto de verdad**, con las mismas invariantes. `test/doubles/` respeta la exclusión de `stockOnHand` en `update` que el ADR-0013 documenta en el puerto: un doble que se desviara del contrato dejaría de probar nada.
- Los tests de fuga entre inquilinos son de primera clase, con suite propia.
- Hay tests de concurrencia **reales** con `Promise.all` en inventario: diez recepciones simultáneas suman treinta unidades; de dos salidas que compiten por las últimas existencias solo prospera una.
- Los ADR citan fallos **encontrados por los propios tests** (el throttler que limitaba la API entera, el DTO de refresco que topaba en 2 048 bytes, el `.env` que vaciaba la base de desarrollo). Eso es evidencia de que la suite trabaja.
- Tres tests de integración fijan campo a campo la forma exacta que lee `apps/web`.

**Lo que falta:**

- **Compras y roles no tienen ni un test unitario.** El 95,2 % de compras es cobertura de integración: mide líneas ejecutadas, no reglas afirmadas.
- **Concurrencia probada solo en inventario.** Ni compras (donde hay una carrera real), ni roles, ni la numeración de documentos bajo carga.
- **Ramas al filo.** 80,2 % contra 80 %.
- **No se detectaron tests de relleno** ni mocks de mocks. Los 758 warnings de ESLint en `test/` son ruido de tipos de supertest, no señal de mala calidad.

---

## 12. Performance Risk Map

Candidatos para k6 en R4, ordenados por riesgo.

| # | Endpoint / operación | Riesgo | Motivo |
| --- | --- | --- | --- |
| 1 | `GET /api/v1/purchases` | **Alto** | Sin paginar, con `include` de proveedor + líneas + producto. Crece sin cota con el histórico |
| 2 | `GET /api/v1/suppliers` | **Alto** | Sin paginar |
| 3 | `POST /api/v1/purchases/{id}/receive` | **Alto** | Carrera conocida; medir la tasa de 500 bajo concurrencia real |
| 4 | `GET /api/v1/reports/executive` | Medio | Cuatro consultas en paralelo y agregación en memoria hasta 366 días. Es la pantalla de inicio: se abre en cada sesión |
| 5 | `POST /api/v1/sales` | Medio | Transacción larga: factura + FEFO por línea + asientos de kardex + cobro + imputación a caja |
| 6 | `GET /api/v1/reports/dashboard` | Medio | Idem 4, con la caja abierta añadida |
| 7 | `POST /api/v1/inventory/receive` | Medio | Ya probado en concurrencia funcional; falta el perfil de latencia |
| 8 | `GET /api/v1/clients?search=` | Bajo | Índice trigrama presente; validar que el planificador lo usa con volumen |
| 9 | `GET /api/v1/appointments/calendar` | Bajo | Acotado por rango; verificar el índice del EXCLUDE bajo carga |
| 10 | `POST /api/v1/auth/login` | Bajo | Argon2id con 19 MiB por intento: es CPU y memoria por diseño. Medir el techo de logins simultáneos |

**Umbrales sugeridos para R4:** p95 < 300 ms en lecturas, p95 < 800 ms en las
transacciones de venta y recepción, 0 % de 5xx bajo carga nominal.

**Aviso metodológico:** el punto 10 no debe «optimizarse». Argon2id es caro a
propósito; el número que interesa es cuántos logins concurrentes tumban el proceso,
para dimensionar réplicas, no para bajar los parámetros.

---

## 13. Production Blockers

Solo lo que realmente impediría desplegar.

**Bloqueantes funcionales: ninguno.** No hay fuga entre inquilinos, ni corrupción
financiera, ni bypass de autenticación. El núcleo —agenda, inventario, ventas, caja,
informes, clientes— está en capas, probado y con las invariantes sostenidas por la
base de datos.

**Prerrequisitos operativos, por orden:**

1. **Control de versiones (R0-BE-014).** Desplegar código sin historial no es viable.
   Es lo primero, y cuesta un minuto.
2. **Poner el CI en verde (R0-BE-005).** Mientras el pipeline esté rojo por formato,
   no protege de nada. Cuesta un `prettier --write`.
3. **Observabilidad mínima (R0-BE-009).** Sin métricas se opera a ciegas. No impide
   arrancar; impide sostener.
4. **Rate limiting compartido (R0-BE-010)** — **solo si se despliega más de una
   réplica**. Con una instancia, lo actual es correcto.

**Con una sola réplica y los puntos 1 y 2 resueltos, el sistema es desplegable.**
Compras funciona; sus defectos son de modo de fallo (500 donde debería haber 409) y
de crecimiento del payload, no de corrección de los datos.

---

## 14. Technical Debt

### Intencional y documentada (no urgente)

| Deuda | Dónde | Salida prevista |
| --- | --- | --- |
| RLS de PostgreSQL pospuesto | ADR-0003 | La extensión de Prisma es el sustituto; RLS cubriría además SQL crudo y escrituras anidadas |
| Ventana de 15 min de token revocado | ADR-0005 | Lista de revocación por `jti` si algún caso lo exige |
| Rate limiting en memoria | ADR-0007 | Redis o balanceador al escalar |
| Paginación por offset | ADR-0007 | Cursor para exportaciones masivas |
| Agregación de informes en memoria | ADR-0015 | `AT TIME ZONE` en SQL cuando haya multi-sede |
| Vulnerabilidad de `deepmerge-ts` | ADR-0002 | Solo en build; revisar al actualizar Prisma |
| Miniaturas de fotos | ADR-0016 | `sharp` cuando la galería lo pida |

Esta columna es inusualmente sana: cada deuda tiene ADR, motivo y condición de salida.

### Accidental y urgente

| Deuda | Hallazgo | Por qué urge |
| --- | --- | --- |
| Sin control de versiones | R0-BE-014 | Cualquier trabajo posterior es irreversible |
| CI en rojo | R0-BE-005 | El gate no protege; la próxima regresión pasa |
| Compras sin dominio | R0-BE-001 | Bloquea 002, 003, 004 y 013 |
| Carrera en recepción | R0-BE-003 | Se manifiesta con dos personas descargando un albarán |
| Errores sin traducir en compras y roles | R0-BE-002, 008 | 500 en acciones rutinarias de usuario |

### Accidental y no urgente

| Deuda | Hallazgo |
| --- | --- |
| OpenAPI incompleto en 4 controladores | R0-BE-007 |
| `PERMISSION_DENIED` declarado y muerto | R0-BE-006 |
| 758 warnings de ESLint | R0-BE-012 |
| Ramas al filo del umbral | R0-BE-011 |
| Auditoría fuera de transacción en compras | R0-BE-013 |
| README desactualizado sobre `apps/web` | Sección 11 |

---

## 15. Proposed R1–R7 Priority

**R1 — Cerrar compras y el proceso** *(nada se implementa hasta que R1 empiece)*
1. `git init` + commit inicial + remoto (R0-BE-014)
2. `prettier --write` sobre los 25 archivos; CI en verde (R0-BE-005)
3. Reescritura hexagonal de compras según la sección 7 (R0-BE-001)
4. UPDATE condicional en recepción + test de concurrencia (R0-BE-003)
5. `withMappedErrors` y traducciones de restricción (R0-BE-002)
6. Paginación en pedidos y proveedores (R0-BE-004)
7. Auditoría dentro de la transacción (R0-BE-013)

**R2 — Consolidar core y contrato**
1. Dominio y tests de `core/roles`; unicidad por restricción, no por lectura previa (R0-BE-008)
2. `@ApiCrudResource()` en roles, usuarios, compras, inventario, caja y ventas (R0-BE-007)
3. 403 al log estructurado; decidir si `PERMISSION_DENIED` se implementa o se retira (R0-BE-006)
4. Subir ramas de inventory y core/auth para recuperar margen (R0-BE-011)
5. Tipar los helpers de test y fijar `--max-warnings=0` (R0-BE-012)

**R3 — Operación**
1. `prom-client`: histograma de latencia por ruta, contadores de error, métricas del pool (R0-BE-009)
2. Rate limiting en Redis (R0-BE-010)
3. Purga programada de `RefreshToken` expirados y de fotos con `deletedAt` vencido (ADR-0005, ADR-0016)
4. Job de conciliación de inventario que el ADR-0011 prevé y que hoy no está programado
5. Retención y partición de `AuditLog`

**R4 — Carga y aislamiento**
1. k6 sobre los diez candidatos de la sección 12
2. Row Level Security como capa 4 del ADR-0003
3. Índices derivados de lo que revele la carga real

**R5 — Frontend** — fuera del alcance de esta auditoría; corresponde al informe de Codex.

**R6 — Producto**: idempotencia efectiva (`Idempotency-Key` está declarada en CORS pero no se verificó su uso), exportaciones con cursor, multi-sede.

**R7 — Escala**: partición por `tenantId`, réplicas de lectura para informes.

---

## 16. Commands Executed

```bash
# --- Estáticos -------------------------------------------------------------
npm run typecheck
  → tsc --noEmit -p tsconfig.json
  → PASA, sin salida. ~12 s

npm run lint
  → eslint "{src,test}/**/*.ts"
  → 758 problems (0 errors, 758 warnings). ~40 s
  → 370 no-unsafe-member-access · 282 no-unsafe-argument · 92 require-await
    7 no-unsafe-return · 6 no-unsafe-call · 1 no-unsafe-assignment

npx prettier --check "src/**/*.ts" "test/**/*.ts"
  → FALLA. Code style issues found in 25 files. exit 1

npm run build
  → nest build
  → PASA. real 0m15.401s

# --- Arquitectura ----------------------------------------------------------
grep -rn "from '.*infrastructure" src/*/*/domain/ src/*/*/application/ --include=*.ts \
  | grep -v "\.spec\.ts:" | grep -v "import type"
  → 2 coincidencias, ambas en purchases/application/purchases.service.ts:15-16

grep -rln "@nestjs\|@prisma/client" src/*/*/domain/ --include=*.ts | grep -v spec
  → ninguna

grep -rn "queryRaw\|executeRaw" src --include=*.ts | grep -v spec
  → 3 usos, todos en PrismaService (SELECT 1 de salud; truncateAll de tests)

grep -rln "withMappedErrors" src --include=*.ts | grep -v spec | grep -v mapper
  → 12 archivos. Ausentes: purchases, core/roles

grep -rhoE "action: '[A-Z_]+'" src --include=*.ts | sort | uniq -c
  → PERMISSION_DENIED: 0 emisiones

# --- Infraestructura de pruebas --------------------------------------------
docker compose up -d postgres-test minio
  → salon-postgres-test Running · salon-minio Running

DATABASE_URL="postgresql://salon_test:salon_test@localhost:5443/salon_test?schema=public" \
  npx prisma migrate deploy
  → All migrations have been successfully applied. (14 migraciones)

# --- Suites ----------------------------------------------------------------
npm run test:unit
  → Test Suites: 33 passed, 33 total
  → Tests:       832 passed, 832 total
  → Time:        2.893 s

npm run test:integration
  → Test Suites: 12 passed, 12 total
  → Tests:       283 passed, 283 total
  → Time:        68.975 s

npm run test:cov
  → Test Suites: 45 passed, 45 total
  → Tests:       1115 passed, 1115 total
  → Time:        75.797 s
  → Statements 94.4 % (5098/5400) · Branches 80.2 % (2411/3006)
  → Functions  93.63 % (1500/1602) · Lines 94.85 % (4459/4701)
  → exit code 0

# --- Control de cambios (exigido por el encargo) ---------------------------
git status --short
  → fatal: not a git repository (or any of the parent directories): .git
git diff --stat
  → fatal: not a git repository
  → INEJECUTABLE. Ver R0-BE-014 y el aviso previo.
```

---

## 17. Files Inspected

**Documentación y contrato (18)**
`README.md` · `docs/adr/README.md` · `docs/adr/0001` a `0016` (16 ADR, íntegros)

**Configuración y despliegue (9)**
`package.json` · `apps/web/package.json` · `tsconfig.json` · `jest.config.ts` ·
`eslint.config.mjs` · `docker-compose.yml` · `Dockerfile` · `.github/workflows/ci.yml` ·
`.env.test`

**Esquema y migraciones (5)**
`prisma/schema.prisma` (enums, modelos, índices) ·
`prisma/migrations/20260902162600_database_invariants/migration.sql` (íntegra) ·
`20260902210000_guatemala_defaults_and_cash_guard` ·
`20260902170000_product_batches` · listado de las 14 migraciones

**Shared kernel (10)**
`prisma.service.ts` · `prisma.extensions.ts` · `prisma-repository.base.ts` ·
`prisma-error.mapper.ts` · `request-context.ts` · `guards.ts` ·
`scoped-throttler.guard.ts` · `interceptors.ts` · `filters/domain-exception.filter.ts` ·
`config/env.schema.ts`

**Núcleo y borde (4)**
`src/main.ts` · `core/health/health.module.ts` · `core/roles/…/prisma-role.repository.ts` ·
`shared/application/ports.ts`

**Compras — auditoría especial (3, íntegros)**
`purchases/application/purchases.service.ts` (371 líneas) ·
`purchases/infrastructure/http/purchases.controller.ts` ·
`purchases/purchases.module.ts`

**Tests (4)**
`test/setup-integration.ts` · `test/integration/purchases.integration.spec.ts` (índice de casos) ·
inventario de los 45 archivos de test · `coverage/coverage-summary.json` (analizado por módulo)

**Análisis agregado sobre todo el árbol**
Recuento de capas y specs por módulo (14) · `@ApiOperation` frente a endpoints en los
13 controladores · acciones de auditoría emitidas · usos de `crossTenant` /
`includingDeleted` / `bypassTenantScope` · `CHECK`, `TRIGGER`, `EXCLUDE` e índices
únicos parciales en migraciones · presencia de métricas y trazas.

---

## 18. Final Verdict

```text
READY FOR R1
```

**Fundamento.**

No se ha encontrado ningún hallazgo CRITICAL. La propiedad más importante del
sistema —el aislamiento entre salones— está construida en tres capas concéntricas,
verificada contra el código y ejercitada por una suite dedicada, con el `tenantId`
entrando por un único punto que es el claim de un token firmado. La base de datos
sostiene las invariantes que la aplicación no puede garantizar sola, y lo hace con
las herramientas correctas: `EXCLUDE` para el solapamiento, triggers para el
append-only, índices parciales para el soft delete, `CHECK` con nombre para los
importes. 1 115 tests pasan y los cuatro umbrales de cobertura se cumplen.

Los tres hallazgos HIGH no impiden pasar a R1: son la agenda de R1. Dos de ellos
—el CI en rojo y la ausencia de control de versiones— se resuelven en minutos. El
tercero, compras, es una deuda que el propio README declara, que está acotada a un
módulo, y para la que el repositorio ya contiene el patrón de solución aplicado tres
veces con éxito en los ADR-0013, 0014 y 0015.

**Lo que este repositorio hace mejor que la mayoría.** Los ADR documentan fallos
reales encontrados al probar, con el número que los desmintió: el token de 2 377
bytes frente al «por debajo de 2 KB» que la primera redacción afirmaba, el `.env` que
vaciaba la base de desarrollo, el throttler que limitaba la API entera a cinco
peticiones. Un proyecto que escribe sus propios errores en la documentación
arquitectónica es un proyecto en el que se puede confiar en lo que dice el resto de
la documentación —y esta auditoría lo comprobó: **ninguna afirmación del README
exagera el estado del sistema**.

**La reserva que hay que decir sin adornos.** La calidad no es uniforme. Entre
`salon/inventory` —con dominio, FEFO real, coste por lote y concurrencia demostrada
con `Promise.all`— y `salon/purchases` —371 líneas contra Prisma, sin dominio, sin un
test unitario y con la carrera que inventario ya eliminó— hay una distancia que no se
explica por la dificultad del problema. Compras es más sencillo que inventario. La
distancia es de atención, y el riesgo de R1 no es técnico: es que compras se dé por
terminado cuando funcione, en lugar de cuando esté al nivel del resto.

---

*Auditoría ejecutada en modo solo lectura sobre `src/`, `prisma/` y `test/`. Las tres
modificaciones previas a este informe, todas en `apps/web`, están declaradas en el
aviso inicial. El control de cambios `git status` no pudo ejecutarse por ausencia de
repositorio git (R0-BE-014).*
