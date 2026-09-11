# BeautyOS / AppSalonBelleza — FASE R0
## Auditoría independiente Frontend + Integración + QA + Performance

Actúa como **Principal Frontend Engineer + QA/Performance Engineer con más de 10 años de experiencia** especializado en:

- React
- Next.js
- TypeScript
- Tailwind CSS
- REST APIs
- Playwright
- Vitest
- Web Performance
- Accessibility
- sistemas SaaS empresariales.

Trabajas sobre `AppSalonBelleza / BeautyOS`.

NO estás creando una aplicación nueva.

El backend ya existe y la interfaz utiliza datos reales.

Tu misión es determinar si el frontend realmente está preparado para consumir correctamente el backend existente y si la experiencia puede considerarse production-ready.

# REGLA ABSOLUTA

## EN R0 NO MODIFIQUES NINGÚN ARCHIVO.

No:

- refactorices;
- corrijas bugs;
- añadas tests;
- cambies estilos;
- cambies dependencias;
- modifiques API;
- modifiques backend;
- actualices paquetes;
- generes componentes;
- hagas commits.

Solo:

```text
READ
INSPECT
RUN
VERIFY
REPORT
```

Todo problema encontrado deberá quedar documentado.

---

# RESPONSABILIDAD DE CODEX

Claude Code realizará paralelamente una auditoría Backend/Arquitectura.

Tú NO debes convertirte en segundo auditor backend.

Puedes inspeccionar backend cuando sea necesario para verificar el contrato API, pero tu responsabilidad principal es:

```text
Next.js
React
UX
API integration
Playwright
Vitest
Accessibility
Performance
Security frontend
Production readiness
```

---

# PRIMERA OBLIGACIÓN

Antes de concluir nada:

Lee:

```text
README.md
apps/web/
apps/web/package.json
playwright*
next.config*
tailwind*
tsconfig*
```

Después estudia el contrato backend relevante:

```text
/api/v1
OpenAPI decorators
DTOs
apps/web server routes
API client
```

Cuando haga falta, inspecciona controllers/DTOs del backend para comparar el contrato real.

---

# 1. ARQUITECTURA FRONTEND

Determina la arquitectura REAL.

Documenta:

- App Router;
- Server Components;
- Client Components;
- server routes;
- API proxy/BFF;
- layouts;
- route groups;
- data fetching;
- authentication;
- session handling;
- state management;
- forms;
- validation;
- error handling;
- loading boundaries;
- Suspense;
- caching;
- revalidation.

Busca:

- componentes gigantes;
- responsabilidades mezcladas;
- lógica de negocio en UI;
- fetch duplicado;
- tipos duplicados;
- DTOs duplicados manualmente;
- acoplamiento directo;
- uso excesivo de `use client`;
- waterfalls;
- estado global innecesario;
- prop drilling;
- hooks problemáticos.

---

# 2. CONTRACT AUDIT

Este es uno de los objetivos PRINCIPALES de R0.

El README reconoce que los actuales Playwright interceptan la API y por ello no demuestran que frontend y backend compartan realmente el mismo contrato.

Audita:

```text
Next.js
  ↓
server routes
  ↓
REST client
  ↓
NestJS
  ↓
DTO
  ↓
response
```

Compara para los módulos principales:

- auth;
- users;
- roles;
- clients;
- stylists;
- catalog;
- appointments;
- inventory;
- sales;
- cash;
- reports;
- purchases.

Comprueba:

- URL;
- HTTP method;
- body;
- DTO;
- response;
- pagination;
- sorting;
- filters;
- status codes;
- error codes;
- money serialization;
- date serialization;
- nullability;
- enums.

Clasifica cada módulo:

```text
MATCH
PARTIAL MATCH
MISMATCH
NOT VERIFIED
```

---

# 3. AUTENTICACIÓN FRONTEND

Audita:

- login;
- logout;
- refresh;
- refresh rotation;
- token storage;
- cookie usage;
- httpOnly;
- secure;
- sameSite;
- expiration;
- retry 401;
- refresh race condition;
- múltiples requests simultáneos con access token expirado;
- session invalidation;
- password reset;
- redirects;
- protected routes.

Busca especialmente:

```text
token leakage
XSS exposure
refresh storms
infinite retry
open redirect
session fixation
```

No corrijas.

---

# 4. RBAC Y UX

El backend utiliza permisos granulares.

Comprueba cómo el frontend maneja:

- OWNER;
- MANAGER;
- RECEPTIONIST;
- STYLIST;
- custom roles;
- permissions;
- `.own`.

No consideres seguridad frontend como reemplazo del backend.

Lo que queremos verificar es UX correcta.

Busca:

- botones que aparecen a usuarios sin permiso;
- páginas accesibles que después siempre reciben 403;
- acciones ocultas incorrectamente;
- información sensible visible;
- costes/márgenes visibles para recepción;
- agenda completa visible para estilistas que deberían tener `.own`.

---

# 5. CLIENTES

Audita:

- listado;
- búsqueda;
- filtros;
- ficha;
- historial;
- alergias;
- consentimiento;
- fotos;
- puntos;
- métricas;
- anonimización;
- errores;
- estados vacíos;
- loading;
- paginación.

---

# 6. AGENDA

Esta es una pantalla crítica para la operación diaria.

Audita:

- calendario;
- día;
- semana;
- mes si existe;
- estilistas;
- servicios;
- creación;
- edición;
- cancelación;
- reprogramación;
- disponibilidad;
- overlap;
- timezone;
- DST;
- loading;
- optimistic updates;
- errores;
- concurrencia.

Evalúa el número de clicks para:

```text
encontrar cliente → reservar → seleccionar estilista → seleccionar servicio → confirmar
```

Busca fricción operacional.

---

# 7. INVENTARIO

Audita UX para:

- productos;
- stock;
- lotes;
- caducidad si está expuesta;
- movimientos;
- Kardex;
- stock bajo;
- compras;
- recepción;
- recepción parcial.

Verifica que los valores financieros no dependan de aritmética JS con `number` cuando puedan perder precisión.

---

# 8. VENTAS Y CAJA

Audita flujo real:

```text
cliente
 ↓
servicio/producto
 ↓
facturación
 ↓
pago
 ↓
caja
```

Comprueba:

- cantidades;
- impuestos;
- total;
- partial payments;
- refund;
- void;
- cash movements;
- cierre;
- error states.

Los importes provenientes de API deben respetar strings decimales.

Identifica cualquier conversión peligrosa con:

```typescript
Number()
parseFloat()
+
-
*
/
```

cuando se usa sobre dinero.

---

# 9. REPORTES

Audita:

- carga;
- rangos;
- filtros;
- timezone;
- representación;
- tablas;
- gráficos;
- responsividad;
- datasets grandes;
- loading;
- empty state;
- error state.

Busca posibles endpoints capaces de generar payloads grandes.

---

# 10. UX / DESIGN SYSTEM

Evalúa coherencia de:

- spacing;
- typography;
- buttons;
- forms;
- dialogs;
- tables;
- cards;
- navigation;
- feedback;
- toast;
- destructive actions;
- confirmation;
- mobile;
- tablet;
- desktop.

La aplicación está destinada a un salón de belleza.

Prioriza operación rápida.

Evalúa especialmente:

```text
desktop reception
tablet reception
tablet stylist
mobile owner
```

NO rediseñes todavía.

---

# 11. ACCESSIBILITY

Audita con referencia práctica a WCAG 2.2 AA.

Revisa:

- labels;
- keyboard;
- focus;
- modal focus trap;
- contrast;
- aria;
- forms;
- table semantics;
- navigation;
- reduced motion;
- screen reader structure.

Si tienes herramientas disponibles para comprobarlo, ejecútalas.

No modifiques UI.

---

# 12. PERFORMANCE

Inspecciona:

- bundle;
- client JS;
- hydration;
- Server vs Client Components;
- waterfalls;
- requests duplicadas;
- imágenes;
- fonts;
- caching;
- memoization;
- dynamic imports;
- heavy dependencies;
- tables;
- calendar rendering;
- reports;
- long lists.

Ejecuta si es posible:

```bash
npm run web:build
```

Registra información relevante del build.

Si el entorno lo permite, realiza mediciones NO destructivas.

No hagas todavía el load test R4.

---

# 13. TESTING

Ejecuta cuando sea posible:

```bash
npm run web:typecheck
npm run web:lint
npm run web:test
npm run web:test:e2e
npm run web:build
```

Registra:

```text
command
passed
failed
duration if available
warnings
```

Analiza todos los tests existentes.

Especial atención a Playwright.

Determina exactamente qué pruebas usan:

```typescript
page.route(...)
```

y qué APIs interceptan.

Construye una matriz:

| Flujo | UI real | Next real | NestJS real | PostgreSQL real |
|------|---------|-----------|-------------|-----------------|

Ejemplo:

```text
Login
Crear cliente
Reservar cita
Venta
Caja
Inventario
Compras
```

No añadas tests todavía.

---

# 14. PLAN PARA R2/R3

Necesitamos posteriormente dos cosas diferentes.

## R2 — Contract Testing

Diseña conceptualmente cómo evitar drift entre:

```text
NestJS OpenAPI
        ↓
Next.js
```

Evalúa alternativas:

- OpenAPI-generated client;
- generated types;
- schema validation;
- contract tests.

Recomienda una.

NO la implementes.

## R3 — TRUE E2E

Diseña la estrategia para Playwright con:

```text
Browser real
 ↓
Next.js real
 ↓
NestJS real
 ↓
PostgreSQL test real
```

No interceptar `/api/*` para estos tests.

Los E2E mockeados pueden mantenerse como tests de frontend rápidos si aportan valor, pero no deben llamarse prueba completa de integración.

Diseña cuáles deben convertirse en TRUE E2E.

---

# 15. PERFORMANCE R4

Crea solamente el mapa de pruebas futuras.

Sugiere escenarios para:

```text
Login
Agenda
Availability
Clients search
Inventory
Sale
Reports
```

Para cada uno indica:

```text
risk
expected traffic
data volume
concurrency candidate
measurement
```

NO ejecutes aún pruebas agresivas.

---

# FORMATO DE HALLAZGOS

Cada hallazgo:

```text
ID:
R0-FE-XXX

Título:

Severidad:
CRITICAL | HIGH | MEDIUM | LOW | INFO

Área:

Archivo(s):

Línea(s):

Evidencia:

Problema:

Impacto:

Cómo reproducir:

Recomendación:

Fase:
R2 | R3 | R4 | R5 | R6 | R7

Confianza:
ALTA | MEDIA | BAJA
```

---

# CRITERIOS DE SEVERIDAD

## CRITICAL

- exposición de credenciales;
- fuga tenant;
- acceso a datos sensibles;
- corrupción financiera;
- auth bypass.

## HIGH

- flujo principal roto;
- contrato incompatible;
- pérdida de información;
- incorrect permission handling;
- errores monetarios.

## MEDIUM

- UX significativamente deficiente;
- performance;
- testing insuficiente;
- mantenibilidad.

## LOW

- refinamientos;
- consistencia;
- deuda menor.

---

# ENTREGA FINAL

Genera exactamente:

# R0 Frontend Audit

## 1. Executive Summary

Máximo 15 puntos.

## 2. Frontend Health Score

Puntúa 0-10:

```text
Architecture
Code quality
API integration
Authentication
Authorization UX
Testing
Accessibility
Performance
Responsive UX
Production readiness
```

Justifica cada puntuación.

## 3. Actual Frontend Architecture

## 4. API Contract Matrix

Debe incluir todos los módulos importantes.

## 5. Critical / High Findings

## 6. Medium / Low Findings

## 7. Authentication & Session Review

## 8. RBAC UX Review

## 9. Business Flow Review

Incluye:

```text
Client
Appointment
Inventory
Purchase
Sale
Cash
Reports
```

## 10. Playwright Reality Check

Explica exactamente qué es realmente E2E y qué está mockeado.

## 11. True-E2E Coverage Matrix

## 12. Accessibility Review

## 13. Performance Review

## 14. Recommended R2 Contract Strategy

## 15. Recommended R3 Playwright Strategy

## 16. R4 Performance Test Map

## 17. Production Blockers

Solamente problemas que realmente bloqueen producción.

## 18. Commands Executed

## 19. Files Inspected

## 20. Final Verdict

Uno de:

```text
READY FOR R2/R3
R0 BLOCKED
CRITICAL REMEDIATION REQUIRED
```

---

# GIT SAFETY CHECK

Antes de concluir ejecuta:

```bash
git status --short
git diff --stat
```

No debes haber modificado archivos.

Si accidentalmente modificaste algo, restaura únicamente TUS cambios.

No reviertas cambios que existían antes de comenzar.

# PRINCIPIO DE ESTA AUDITORÍA

No confíes automáticamente en README.

No confíes automáticamente en nombres de tests.

No confíes automáticamente en comentarios.

Comprueba la implementación.

Queremos evidencia, no impresiones.

Queremos saber exactamente dónde está BeautyOS antes de introducir más cambios.

**FASE R0 = SOLO AUDITORÍA. NO ESCRIBIR CÓDIGO.**