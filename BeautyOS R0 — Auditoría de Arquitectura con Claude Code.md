# BeautyOS / AppSalonBelleza — FASE R0
## Auditoría técnica independiente del Backend y Arquitectura

Actúa como **Principal Backend Engineer + Software Architect con más de 10 años de experiencia** en NestJS, TypeScript, PostgreSQL, Prisma, DDD, arquitectura hexagonal, seguridad SaaS multi-tenant y sistemas transaccionales.

Estás trabajando en un sistema REAL y ya avanzado llamado `AppSalonBelleza / BeautyOS`.

NO estás comenzando un proyecto nuevo.

Tu misión en esta fase es **AUDITAR el estado real del repositorio**.

# REGLA PRINCIPAL

## NO MODIFIQUES NADA.

En esta fase está estrictamente prohibido:

- modificar código;
- crear archivos;
- borrar archivos;
- aplicar fixes;
- refactorizar;
- cambiar dependencias;
- ejecutar migraciones destructivas;
- cambiar configuración;
- hacer commits;
- hacer push;
- reformatear archivos;
- actualizar README;
- corregir tests.

Puedes ejecutar comandos de lectura, análisis, build, typecheck, lint y tests seguros.

Si encuentras un problema:

**NO LO CORRIJAS.**

Documenta:

- ubicación;
- severidad;
- causa;
- impacto;
- evidencia;
- recomendación;
- fase en la que debería solucionarse.

---

# CONTEXTO ARQUITECTÓNICO

El proyecto declara:

- NestJS
- TypeScript
- PostgreSQL
- Prisma
- REST API versionada `/api/v1`
- OpenAPI / Swagger
- Next.js en `apps/web`
- arquitectura hexagonal
- DDD táctico por módulos
- multi-tenancy shared-schema mediante `tenantId`
- JWT + refresh tokens rotativos
- RBAC granular
- auditoría append-only
- Docker
- CI
- pruebas unitarias e integración

La regla arquitectónica central es:

```text
domain
   ↑
application
   ↑
infrastructure
```

Las dependencias deben apuntar hacia adentro.

`domain` no debe depender de NestJS, Prisma ni infraestructura.

`application` solamente debe conocer dominio y puertos.

Los adaptadores deben estar en `infrastructure`.

El wiring debe ocurrir principalmente en los módulos NestJS.

---

# PRIMERA OBLIGACIÓN

Antes de sacar conclusiones:

1. Lee `README.md` completo.
2. Lee todos los ADR disponibles en:

```text
docs/adr/
```

3. Revisa:

```text
package.json
apps/web/package.json
prisma/schema.prisma
docker-compose*
Dockerfile*
.github/workflows/
src/shared/
src/core/
src/salon/
test/
```

No asumas que el README necesariamente coincide con la implementación.

Debes comprobarlo contra el código.

---

# ALCANCE PRINCIPAL DE CLAUDE

Tu auditoría se centrará especialmente en:

## 1. Arquitectura

Comprueba:

- separación domain/application/infrastructure;
- dependencias incorrectas;
- infraestructura importada desde domain;
- infraestructura importada desde application;
- lógica de negocio en controllers;
- lógica de negocio en adaptadores Prisma;
- services demasiado grandes;
- módulos con responsabilidades mezcladas;
- duplicación entre módulos;
- uso correcto del shared kernel;
- dependency inversion;
- cohesión;
- acoplamiento;
- SOLID;
- boundaries DDD.

Ejecuta también una variante del control documentado por el proyecto:

```bash
grep -rn "from '.*infrastructure" src/*/*/domain/ src/*/*/application/ --include=*.ts \
  | grep -v "\.spec\.ts:" | grep -v "import type"
```

Documenta cada coincidencia real.

---

# 2. AUDITORÍA ESPECIAL: PURCHASES

`src/salon/purchases/` debe recibir atención especial.

El README reconoce que actualmente es la única excepción estructural relevante.

Comprueba:

- si tiene domain;
- entidades;
- value objects;
- invariantes;
- puertos;
- repositorios;
- casos de uso;
- adaptadores;
- acceso directo a Prisma;
- acceso directo a QueryScopeStore;
- límites transaccionales;
- integración con inventario;
- recepción parcial;
- cancelación;
- envío;
- secuencias;
- Money;
- impuestos;
- cantidades fraccionarias;
- multi-tenancy;
- concurrency.

NO refactorices nada todavía.

Entrega un diseño propuesto para la futura **R1**, pero solo como recomendación.

---

# 3. MULTI-TENANCY

Esta es una propiedad crítica.

Audita detalladamente:

```text
JWT
 ↓
tenant context
 ↓
AsyncLocalStorage
 ↓
Prisma extension
 ↓
repository
 ↓
PostgreSQL
```

Comprueba:

- que `tenantId` no pueda venir del body;
- que no pueda venir de query;
- que no pueda venir de headers manipulables;
- aislamiento de lectura;
- aislamiento de escritura;
- soft delete;
- relaciones;
- nested writes;
- raw SQL;
- `$queryRaw`;
- `$executeRaw`;
- bypasses de Prisma;
- tareas background;
- jobs;
- seeds;
- tests;
- modelos tenant-exempt.

Busca activamente posibles vías de fuga entre salones.

Clasifica cualquier posible fuga multi-tenant como mínimo:

```text
CRITICAL
```

salvo que puedas demostrar que no es explotable.

---

# 4. POSTGRESQL / PRISMA

Audita:

- schema;
- constraints;
- foreign keys;
- indexes;
- partial indexes;
- unique constraints;
- tenant-scoped uniqueness;
- cascades;
- timestamps;
- soft delete;
- Decimal;
- money;
- transaction boundaries;
- race conditions;
- N+1;
- consultas sin índice;
- joins costosos;
- paginación;
- ordenación;
- integridad referencial.

Comprueba especialmente las invariantes documentadas:

- citas no solapadas;
- auditoría inmutable;
- Kardex inmutable;
- stock no negativo;
- una sola caja abierta;
- reutilización de email después de soft delete;
- consistencia de líneas de factura.

Indica:

```text
DOCUMENTADO
IMPLEMENTADO
PROBADO
```

para cada una.

---

# 5. SEGURIDAD

Audita como mínimo:

- OWASP Top 10;
- JWT;
- HS256;
- gestión de secretos;
- refresh tokens;
- reuse detection;
- tokenVersion;
- Argon2id;
- password reset;
- enumeración de usuarios;
- rate limiting;
- brute force;
- CORS;
- Helmet;
- HSTS;
- Swagger producción;
- ValidationPipe;
- mass assignment;
- DTO validation;
- RBAC;
- IDOR;
- tenant isolation;
- privilege escalation;
- errores 5xx;
- stack leakage;
- logging sensible;
- correlation IDs.

Analiza específicamente:

```text
PERMISSION_DENIED
```

El proyecto declara dicha acción de auditoría pero aparentemente los 403 no se almacenan.

Determina:

- implementación actual;
- impacto;
- riesgos de escribir una auditoría por cada 403;
- posibilidad de DoS / table flooding;
- posibles alternativas;
- si requiere ADR.

NO lo implementes.

---

# 6. TRANSACCIONES DE NEGOCIO

Audita las operaciones críticas:

### Agenda

- reserva;
- reprogramación;
- concurrencia;
- overlap.

### Inventario

- Kardex;
- FEFO;
- consumo;
- stock negativo;
- concurrencia.

### Ventas

- invoice;
- pagos;
- cancelación;
- devolución;
- inventory consumption.

### Caja

- apertura;
- movimientos;
- cierre;
- expected cash;
- concurrencia.

### Compras

- orden;
- recepción parcial;
- integración con inventario.

Determina dónde existe atomicidad real y dónde podrían existir estados parciales.

---

# 7. TESTING BACKEND

Ejecuta, cuando el entorno lo permita:

```bash
npm run typecheck
npm run lint
npm run build
npm run test:unit
npm run test:integration
npm run test:cov
```

IMPORTANTE:

La suite de integración comparte base de datos y debe ejecutarse secuencialmente.

No ejecutes suites de integración simultáneamente.

Si PostgreSQL de tests no está disponible, NO cambies la configuración indiscriminadamente.

Documenta la limitación.

Registra:

```text
comando
resultado
duración aproximada si está disponible
tests ejecutados
tests fallidos
coverage
warnings
```

No te limites al número de tests.

Evalúa la CALIDAD de los tests.

Busca:

- tests que no prueban nada útil;
- mocks excesivos;
- invariantes sin cubrir;
- happy paths únicamente;
- errores concurrentes no cubiertos;
- tests frágiles;
- tests duplicados.

---

# 8. OPENAPI

Comprueba que los endpoints realmente correspondan al contrato generado.

Revisa:

- DTOs;
- schemas;
- códigos HTTP;
- errores RFC 9457;
- strings monetarios;
- paginación;
- filtros;
- sorting;
- permissions;
- endpoint versioning.

Identifica posibles incompatibilidades con el frontend.

---

# 9. PERFORMANCE BACKEND

NO hagas todavía una prueba destructiva de carga.

Haz análisis estático y pruebas razonables.

Busca:

- N+1;
- queries secuenciales evitables;
- falta de índices;
- operaciones O(n);
- carga excesiva en memoria;
- serialización innecesaria;
- payloads grandes;
- reportes costosos;
- queries agregadas peligrosas;
- bloqueo de event loop;
- transacciones largas.

Identifica endpoints candidatos para la futura fase R4 con k6.

---

# 10. OBSERVABILIDAD

Revisa:

- structured logging;
- correlationId;
- error logging;
- health probes;
- readiness;
- liveness;
- audit logs;
- métricas;
- tracing;
- request latency;
- database latency.

No agregues herramientas todavía.

Indica qué falta para producción.

---

# FORMATO DE HALLAZGOS

Cada problema debe usar:

```text
ID:
R0-BE-XXX

Título:

Severidad:
CRITICAL | HIGH | MEDIUM | LOW | INFO

Área:

Archivo(s):

Línea(s):

Evidencia:

Problema:

Impacto:

Cómo reproducir/verificar:

Recomendación:

Fase sugerida:
R1 | R2 | R3 | R4 | R5 | R6 | R7

Confianza:
ALTA | MEDIA | BAJA
```

---

# SEVERIDADES

## CRITICAL

Ejemplos:

- fuga entre tenants;
- corrupción financiera;
- auth bypass;
- RCE;
- pérdida irreversible de información;
- corrupción grave de inventario.

## HIGH

- privilege escalation;
- race condition transaccional;
- inconsistencias de caja;
- facturación incorrecta;
- bypass de invariantes.

## MEDIUM

- arquitectura incorrecta;
- deuda que dificulta cambios;
- tests insuficientes;
- rendimiento potencialmente problemático.

## LOW

- mantenibilidad;
- naming;
- simplificación.

No infles artificialmente las severidades.

---

# ENTREGA FINAL

Entrega exactamente estas secciones:

# R0 Backend Audit

## 1. Executive Summary

Máximo 15 puntos.

## 2. Repository Health

Da puntuación 0-10 para:

```text
Architecture
Domain model
Database
Multi-tenancy
Security
API design
Testing
Performance readiness
Observability
Production readiness
```

Justifica cada puntuación.

## 3. Verified Architecture

Explica cómo funciona realmente el sistema según el código.

## 4. Architecture Violations

Lista completa.

## 5. Critical / High Findings

Ordenados por severidad.

## 6. Medium / Low Findings

## 7. Purchases Gap Analysis

Detalla exactamente cómo debería evolucionar en R1.

NO escribas todavía el código.

## 8. Multi-Tenant Threat Analysis

Incluye posibles rutas de escape.

## 9. Security Review

## 10. Database & Concurrency Review

## 11. Testing Reality Check

Diferencia:

```text
README CLAIM
VERIFIED
NOT VERIFIED
CONTRADICTED
```

## 12. Performance Risk Map

Endpoints/operaciones candidatas para k6.

## 13. Production Blockers

Solamente problemas que realmente impedirían producción.

## 14. Technical Debt

Separa:

```text
intentional
accidental
urgent
non-urgent
```

## 15. Proposed R1-R7 Priority

Sin implementar nada.

## 16. Commands Executed

Incluye resultado.

## 17. Files Inspected

## 18. Final Verdict

Debe ser uno:

```text
READY FOR R1
R0 BLOCKED
CRITICAL REMEDIATION REQUIRED
```

---

# CONTROL DE CAMBIOS

Al finalizar ejecuta:

```bash
git status --short
git diff --stat
```

El resultado esperado es que NO hayas modificado ningún archivo.

Si aparece un cambio causado por ti, restáuralo antes de finalizar.

No reviertas modificaciones que ya existían antes de comenzar.

## OBJETIVO

Queremos una auditoría crítica y verificable.

No queremos elogios.

No queremos una reescritura del README.

No queremos una lista genérica de buenas prácticas.

Cada afirmación importante debe derivarse del código, configuración, esquema, tests o ejecución real del proyecto.

**NO MODIFIQUES EL CÓDIGO EN R0.**