# AppSalonBelleza

Plataforma SaaS multi-inquilino para la gestión integral de salones de belleza.
Monorepo con dos aplicaciones: la **API** (raíz del repositorio) en NestJS + PostgreSQL +
Prisma, con arquitectura hexagonal y DDD por módulos, y la **interfaz web** (`apps/web`) en
Next.js, que consume la API a través de sus propias rutas de servidor.

> **Estado.** Ya no falta ningún módulo de negocio: los diez de `src/salon/` están
> implementados y la interfaz web los consume con datos reales, sin pantallas de relleno
> —el componente `ModulePending`, que hacía de marcador de posición, se ha retirado—.
> La fase R1 normalizó compras y cerró sus riesgos de precisión, atomicidad, concurrencia y
> paginación. La recuperación de contraseña ya tiene puerto de envío pero **falta elegir
> proveedor de correo**, y el **frontend está mucho menos probado que la API**. El detalle
> exacto, con su porqué, está en
> [Qué hay hecho y qué no](#qué-hay-hecho-y-qué-no); léalo antes de planificar.

---

## Puesta en marcha

Requisitos: **Node.js ≥ 20.11**, **Docker** y **npm**.

```bash
# 1. Dependencias
npm ci

# 2. Configuración (revise los puertos si tiene otro PostgreSQL en marcha)
cp .env.example .env

# 3. Servicios: base de desarrollo, base de tests y almacén de fotos
docker compose up -d postgres postgres-test minio

# 4. Esquema y datos de demostración
npm run prisma:generate
npm run prisma:deploy
npm run db:seed

# 5. Esquema de la base de tests (hay que repetirlo tras cada reinicio de Docker; ver Tests)
DATABASE_URL="postgresql://salon_test:salon_test@localhost:5443/salon_test?schema=public" \
  npx prisma migrate deploy

# 6. Arrancar la API y, en otra terminal, la interfaz web
npm run start:dev
npm run web:dev
```

En PowerShell el paso 5 se escribe en dos instrucciones, porque no admite prefijar variables
de entorno a un comando:

```powershell
$env:DATABASE_URL = 'postgresql://salon_test:salon_test@localhost:5443/salon_test?schema=public'
npx prisma migrate deploy
```

- API: <http://localhost:3000/api/v1>
- Interfaz web: <http://localhost:3001>
- Documentación interactiva: <http://localhost:3000/api/docs>
- Salud: <http://localhost:3000/api/v1/health/ready>

`minio` solo hace falta para las fotos de clienta. Sin él la API arranca igual y todo lo
demás funciona: el adaptador registra el fallo y sigue, porque un almacén caído no debería
impedir cobrar ni dar cita.

### Cuentas de demostración

Todas con la contraseña `SalonDemo2026`:

| Correo | Rol | Para qué sirve |
| ------ | --- | -------------- |
| `propietaria@bella-vista.es` | `OWNER` | Acceso total al salón |
| `encargada@bella-vista.es` | `MANAGER` | Gestión diaria, sin anular facturas ni tocar usuarios |
| `recepcion@bella-vista.es` | `RECEPTIONIST` | Agenda y cobro, **sin ver costes ni márgenes** |
| `estilista@bella-vista.es` | `STYLIST` | Solo su propia agenda |

Existe un segundo salón (`estilo-urbano.es`, mismas cuentas y contraseña) para comprobar
a mano que el aislamiento entre inquilinos funciona.

---

## Arquitectura

Hexagonal (puertos y adaptadores) con DDD táctico por módulo. La regla de dependencia es
estricta: **hacia dentro, siempre**.

```
src/
├── shared/                    Shared kernel — la razón de que no haya código duplicado
│   ├── domain/                Entity, ValueObject, AggregateRoot, Money, Email, TimeRange
│   ├── application/           Puertos: Clock, IdGenerator, PasswordHasher, TokenSigner…
│   └── infrastructure/        Prisma, HTTP, seguridad, auditoría, configuración
│
├── core/                      Plataforma
│   ├── users/                 Identidad
│   ├── auth/                  Login, refresco rotativo, cierre de sesión, recuperación
│   ├── roles/                 Roles a medida del salón sobre el catálogo de permisos
│   ├── permissions/           Catálogo de permisos y roles del sistema
│   └── health/                Sondas de vida y disponibilidad
│
└── salon/                     Negocio
    ├── clients/               Clientas (slice vertical de referencia)
    ├── stylists/              Profesionales: horario, ausencias, habilidades, comisión
    ├── catalog/               Servicios y categorías
    ├── appointments/          Agenda: reserva, estados y disponibilidad
    ├── inventory/             Existencias, lotes, Kardex y reparto FEFO
    ├── sales/                 Facturación, cobros, anulación y devoluciones
    ├── cash/                  Apertura, movimientos, arqueo y cierre de caja
    ├── reports/               Indicadores agregados en la hora del salón
    ├── purchases/             Proveedores y órdenes de compra
    └── goals/                 Metas de facturación por profesional, con recompensa
```

Cada módulo de negocio repite la misma estructura:

```
<modulo>/
├── domain/            Entidades, invariantes, PUERTOS (interfaces), errores
├── application/       Casos de uso — una intención de negocio, un método
└── infrastructure/    ADAPTADORES: Prisma, HTTP  +  el .module.ts que los cablea
```

`domain/` no importa NestJS ni Prisma. `application/` solo conoce puertos. El único sitio
donde un puerto se ata a un adaptador es el `*.module.ts`. Esto se verifica de un vistazo:

```bash
grep -rn "from '.*infrastructure" src/*/*/domain/ src/*/*/application/ --include=*.ts \
  | grep -v "\.spec\.ts:" | grep -v "import type"
```

Se descartan dos clases de coincidencia que no violan la regla: los `.spec.ts`, que toman
dobles reales de los puertos (`FixedClock`, `SequentialIdGenerator`), y los `import type`
del esquema de configuración, que TypeScript borra al compilar.

Hoy el comando **sale vacío**. Compras era la única excepción —un `purchases.service.ts`
sin dominio, atado a `PrismaService` y `QueryScopeStore`— y se normalizó al cerrar R1
([ADR-0017](docs/adr/0017-normalizacion-arquitectonica-de-compras.md)): cero coincidencias
por primera vez en el repositorio.

### Decisiones de arquitectura

Las diecisiete decisiones estructurales están documentadas en [`docs/adr/`](docs/adr/), con su
contexto, sus consecuencias **y las alternativas descartadas con el motivo del descarte**
—que es la parte que más valor tiene dentro de seis meses.

| ADR | Decisión |
| --- | -------- |
| [0001](docs/adr/0001-arquitectura-hexagonal.md) | Arquitectura hexagonal con DDD por módulos |
| [0002](docs/adr/0002-stack-tecnologico.md) | NestJS + PostgreSQL + Prisma, y cómo se evita la duplicación |
| [0003](docs/adr/0003-estrategia-multi-tenant.md) | Multi-tenancy shared-schema con `tenantId` |
| [0004](docs/adr/0004-soft-delete-y-auditoria.md) | Soft delete y auditoría append-only |
| [0005](docs/adr/0005-autenticacion-jwt-refresh.md) | JWT con refresh rotativo y detección de reutilización |
| [0006](docs/adr/0006-autorizacion-rbac.md) | RBAC por permisos granulares, nunca por rol |
| [0007](docs/adr/0007-api-rest-versionada.md) | API versionada, envoltura uniforme, rate limiting |
| [0008](docs/adr/0008-manejo-de-errores.md) | Errores de dominio y traducción a HTTP (RFC 9457) |
| [0009](docs/adr/0009-estrategia-de-testing.md) | Dos suites y umbral de cobertura |
| [0010](docs/adr/0010-dinero-y-precision-decimal.md) | El dinero nunca es `float` |
| [0011](docs/adr/0011-inventario-y-consistencia.md) | Inventario como ledger append-only |
| [0012](docs/adr/0012-lotes-caducidad-y-fefo.md) | Lotes, caducidad y consumo FEFO |
| [0013](docs/adr/0013-reconciliacion-del-motor-de-inventario.md) | Reconciliación del motor de inventario |
| [0014](docs/adr/0014-ventas-cobros-y-arqueo-de-caja.md) | Ventas, cobros y arqueo de caja |
| [0015](docs/adr/0015-informes-e-indicadores.md) | Informes e indicadores |
| [0016](docs/adr/0016-fotos-de-clienta-y-almacen-de-objetos.md) | Fotos de clienta y almacén de objetos |

---

## Aislamiento entre salones

Es la propiedad más importante del sistema: una fuga entre inquilinos significa que la
clienta de un negocio aparece en la pantalla de su competidor. Se defiende en **tres capas
concéntricas**, de forma que ningún olvido individual la rompa (ADR-0003):

1. **El `tenantId` sale del token firmado.** Nunca del cuerpo, la query ni una cabecera.
   El punto exacto de entrada es `JwtAuthGuard`, y de ahí pasa a un `AsyncLocalStorage`
   accesible a cualquier profundidad sin viajar por las firmas de los métodos.
2. **Una extensión de Prisma inyecta el filtro** en toda lectura y escritura. Un
   repositorio que se olvide del `where` sigue quedando acotado. Sin salón activo, la
   consulta **falla** en vez de devolver los datos de todos.
3. **El esquema lo hace cumplir**: las claves únicas de negocio son compuestas con
   `tenantId`, de modo que dos salones puedan tener una clienta con el mismo correo.

Los tres niveles están cubiertos por [`test/integration/tenant-isolation.integration.spec.ts`](test/integration/tenant-isolation.integration.spec.ts),
donde cada test intenta activamente provocar una fuga.

**Límite conocido:** el SQL crudo (`$queryRaw`) y las escrituras anidadas de Prisma no
pasan por la extensión. Para lo primero existe `tenantFilter()`, que lanza si no hay salón
activo; para lo segundo, los repositorios ponen el `tenantId` explícitamente y los tests
de integración lo verifican. La solución definitiva es Row Level Security de PostgreSQL,
y el ADR-0003 explica por qué se pospone.

---

## Invariantes en la base de datos

Hay reglas que la aplicación **no puede** garantizar: bajo peticiones concurrentes, todo
patrón «leer, validar, escribir» tiene una ventana de carrera. Esas reglas viven en
PostgreSQL ([`prisma/migrations/*_database_invariants`](prisma/migrations/)):

| Invariante | Mecanismo |
| ---------- | --------- |
| Dos citas no pueden solaparse para un mismo profesional | `EXCLUDE USING gist` con `tstzrange` semiabierto |
| La auditoría y el ledger de inventario son inmutables | Triggers que rechazan `UPDATE`/`DELETE` |
| El stock nunca es negativo | `CHECK (stockOnHand >= 0)` |
| Una sola caja abierta por salón | Índice único parcial sobre `status = 'OPEN'` |
| El correo de una ficha borrada se puede reutilizar | Índices únicos **parciales** (`WHERE deletedAt IS NULL`) |
| Una línea de factura referencia lo que declara | `CHECK` sobre `kind` + `serviceId`/`productId` |

El dominio comprueba las mismas reglas, pero no por redundancia: **la base de datos da la
garantía; el dominio da el mensaje de error que el usuario entiende.** Hacen falta las dos.

---

## Seguridad

| Control | Implementación |
| ------- | -------------- |
| Contraseñas | Argon2id, 19 MiB / 2 pasadas (mínimos OWASP), con rehash progresivo automático |
| Access token | JWT HS256, 15 minutos, sin consulta a BD |
| Refresh token | 7 días, **rotativo**, guardado hasheado, con detección de reutilización |
| Revocación | `tokenVersion` por usuario, comprobado al refrescar |
| Autorización | RBAC por permisos (~80), denegación por defecto |
| Fuerza bruta | Bloqueo temporal por cuenta **+** rate limiting por IP |
| Enumeración de usuarios | Respuesta y coste uniformes ante correo desconocido |
| Cabeceras | `helmet` con HSTS; CORS por lista blanca explícita |
| Entrada | `whitelist` + `forbidNonWhitelisted`: un campo no declarado es un 400 |
| Errores | RFC 9457; los 5xx nunca revelan mensaje interno ni stack |

### El flujo de refresco, en corto

Cada refresh token se usa **exactamente una vez**. Si uno ya rotado vuelve a aparecer, hay
dos portadores —el legítimo y quien lo copió— y no hay forma de saber cuál es cuál: se
revoca la **cadena entera** y se registra el incidente. Eso convierte el robo de un refresh
token de «siete días de acceso» en «acceso hasta que el usuario legítimo vuelva a entrar».

El cliente debe guardar siempre el último refresh recibido y reintentar tras un 401.

---

## Convenciones de la API

Versionada por URI: `/api/v1/...`. Contrato OpenAPI generado del código en `/api/docs`.

**Respuestas** — envoltura uniforme aplicada por interceptor:

```jsonc
{ "data": [ ... ], "meta": { "page": 1, "limit": 20, "total": 137,
                             "totalPages": 7, "hasNext": true, "hasPrevious": false } }
```

**Importes monetarios** — siempre **cadena decimal**, nunca número:

```jsonc
{ "totalSpent": "1234.56", "currency": "EUR" }
```

`JSON.parse` convertiría un número a coma flotante binaria y `0.1 + 0.2` dejaría de ser
`0.3`. En un arqueo de caja esa diferencia la ve el usuario. **Use una librería decimal en
su cliente** (ADR-0010).

**Listados** — `?page=1&limit=20&sort=createdAt:desc,name:asc`. Límite máximo 100. Los
campos ordenables se validan contra una lista blanca por recurso; uno desconocido produce
un 400 en lugar de ordenarse por otra cosa en silencio.

**Errores** — RFC 9457. Ramifique siempre sobre `code`, que es contrato estable, **nunca**
sobre `title` ni `detail`, que son texto para personas:

```jsonc
{
  "type": "https://api.salon.app/errors/appointment-overlap",
  "title": "El profesional ya tiene otra cita en esa franja horaria",
  "status": 409,
  "code": "APPOINTMENT_OVERLAP",
  "instance": "/api/v1/appointments",
  "correlationId": "0f9c1e2a-..."
}
```

El `correlationId` vuelve también en la cabecera `X-Correlation-Id`. Cítelo al reportar una
incidencia y el equipo localizará la petición exacta en los registros.

**Códigos de estado** — la distinción entre 400 y 422 es deliberada: 400 significa «la
petición está mal formada», 422 «la entiendo, pero una regla de negocio lo impide». Le
dice al cliente si reintentar con otros datos tiene sentido.

---

## Tests

Dos suites con contratos distintos (ADR-0009):

```bash
npm run test:unit          # dominio y casos de uso — sin infraestructura, 916 tests en ~12 s
npm run test:integration   # PostgreSQL real, HTTP real, guards reales — 303 tests
npm run test:cov           # ambas + informe de cobertura
```

Estado actual: **1.219 tests en verde, y los cuatro umbrales de cobertura cumplidos.**

| Métrica | Cobertura | Umbral |
| ------- | --------- | ------ |
| Líneas | 94,86 % | 90 % |
| Sentencias | 94,58 % | 90 % |
| Funciones | 93,71 % | 90 % |
| Ramas | 80,30 % | 80 % |

El margen en ramas es de dos décimas: unas pocas ramas nuevas sin cubrir vuelven a tumbar el
umbral. Si eso ocurre, el sitio donde hay más recorrido barato son los controladores HTTP,
que rondan el 75 %.

> **La suite de integración no admite paralelismo.** Todos sus tests comparten una única
> base de datos y cada uno la vacía con `TRUNCATE`, así que dos trabajadores simultáneos se
> bloquean y PostgreSQL aborta con `deadlock detected`. Por eso `test:integration` y
> `test:cov` llevan `--runInBand`. Por la misma razón, **no lance dos procesos de jest a la
> vez** contra la base de pruebas: los fallos que salen no tienen nada que ver con el código.

> **El esquema de la base de tests se pierde al reiniciar Docker.** `postgres-test` guarda
> sus datos en `tmpfs` a propósito —la suite destruye y recrea el esquema constantemente y no
> queremos ni el coste de disco ni el riesgo de tocar la base de desarrollo—, pero eso
> significa que tras cada arranque del demonio la base está vacía y la suite falla con
> `The table public.permissions does not exist`. La cura es repetir el paso 5 de
> [Puesta en marcha](#puesta-en-marcha); no hay nada roto.

La interfaz web se prueba aparte, con `npm run web:test` (Vitest) y `npm run web:test:e2e`
(Playwright). El volumen ya no es poco —175 tests unitarios en 30 archivos y 32 casos de
extremo a extremo (16 escenarios en dos dispositivos)—, pero los e2e además **interceptan la
API con `page.route`**, así que no prueban que el backend produzca esas respuestas. Está
anotado en [Pendiente](#pendiente).

Los dobles de la suite unitaria son **implementaciones reales de los puertos**, no mocks:
`InMemoryUserRepository` respeta las mismas invariantes que el adaptador de Prisma
—unicidad, soft delete, ámbito de salón—. Un mock que devuelve lo que le digas confirma
que se llamó a un método; una implementación en memoria prueba que el caso de uso funciona.

La suite de integración exige la base de pruebas en marcha. Un guard en
`test/setup-integration.ts` **aborta** si `DATABASE_URL` no apunta a `salon_test`: la suite
ejecuta `TRUNCATE` sobre todas las tablas y esa comprobación existe porque, durante el
desarrollo, una precedencia de ficheros `.env` hizo que los tests vaciaran la base de
desarrollo.

---

## Docker

```bash
# Imagen de producción (multi-etapa, usuario sin privilegios, dumb-init como PID 1)
docker build -t appsalonbelleza-api .

# Pila completa
docker compose --profile full up -d
```

El perfil `full` sirve la interfaz web desde su contenedor, en el mismo puerto 3001 que usa
`npm run web:dev`. Es una alternativa, no un complemento: **pare el servidor de desarrollo
antes**, o dé otro puerto al contenedor con `WEB_PORT`. La colisión no avisa —Docker Desktop
arranca el contenedor igual, deja el puerto sin publicar y `docker compose ps` lo muestra
`Up` mientras es inalcanzable, de modo que el navegador sigue hablando con el proceso local—.
Para volver al desarrollo con recarga, `docker compose --profile full stop web`: queda parado
pese a `restart: unless-stopped`.

La imagen final no lleva compilador de TypeScript, ni CLI de Prisma, ni dependencias de
desarrollo. `npm ci --ignore-workspaces` es necesario porque la raíz del repositorio
declara `workspaces`: sin él, la imagen de la API arrastraría el frontend entero.

El arranque en producción **falla** si la configuración no es segura: secretos de ejemplo,
CORS abierto o Swagger activo abortan el proceso con un mensaje explícito.

---

## Qué hay hecho y qué no

### Completo y probado de extremo a extremo

**Plataforma**

- **Shared kernel**: primitivas DDD, `Money` (aritmética exacta con reparto sin pérdida de
  céntimos), `Email`, `Phone`, `PersonName`, `TimeRange` (semiabierto), `Percentage`, y
  conversión de hora local del salón a instantes absolutos **con cambios de hora
  correctos**; puertos de reloj, identificadores, hashing, tokens y auditoría;
  `PrismaRepositoryBase` con paginación, ordenación validada, soft delete y restauración.
- **Multi-tenancy**: contexto de petición, extensión de Prisma, unicidades compuestas y
  batería de tests dedicada a intentar fugas entre inquilinos.
- **Identidad y autenticación**: login, refresco rotativo con detección de reutilización,
  cierre de sesión, cambio de contraseña, bloqueo por intentos, política de contraseñas.
- **RBAC**: catálogo de 80 permisos, 5 roles de sistema, guards globales con denegación
  por defecto y ámbito por filas (`.own`).
- **Auditoría**: append-only garantizado por trigger, con redacción de campos sensibles.
- **Operación**: sondas de salud, OpenAPI, Docker multi-etapa, CI, seed idempotente.

**Negocio**

| Módulo | Qué incluye |
| ------ | ----------- |
| **Clientas** | Ficha, alergias, consentimiento RGPD con sello de fecha, puntos, métricas, y **anonimización** por derecho de supresión —operación distinta del borrado, con permiso propio e irreversible. |
| **Profesionales** | Horario semanal recurrente, ausencias que **recortan** la jornada, habilidades con duración y comisión propias, y cálculo de horario trabajable en instantes absolutos. |
| **Catálogo** | Servicios con la distinción entre tiempo facturable y margen de limpieza, impuestos, escandallo de consumo; categorías en árbol con detección de ciclos. |
| **Agenda** | Reserva con precios y duraciones **congeladas**, máquina de estados completa, reprogramación, cálculo de huecos libres alineados a la rejilla horaria, y ámbito `.own` para que cada profesional vea solo su agenda. |

### Implementado y probado

Todos estos módulos, incluido **compras**, siguen la misma estructura: dominio, aplicación e
infraestructura.

| Módulo | Qué resuelve |
| ------ | ------------ |
| **Inventario, lotes y Kardex** | Ledger append-only, reparto **FEFO** con coste real por lote, y descuento de existencias con `UPDATE` condicional que cierra la pérdida de escrituras bajo concurrencia (ADR-0012, ADR-0013) |
| **Ventas y facturación** | Numeración densa y sin huecos, precios e impuestos congelados al emitir, cobro parcial, anulación y devoluciones. Descuenta stock delegando en el motor de inventario, sin reimplementarlo (ADR-0014) |
| **Caja** | Apertura, movimientos, arqueo y cierre. El efectivo esperado se calcula en **un solo sitio**, y una sola caja abierta por salón lo garantiza un índice único parcial (ADR-0014) |
| **Informes y KPIs** | Ventas, ticket medio, retención, ocupación y ranking de profesionales, agrupados por días **en la hora del salón** y no en UTC (ADR-0015) |
| **Fotos e historial de clienta** | Almacén de objetos compatible con S3, tipo deducido de los bytes del fichero, consentimiento obligatorio y borrado en dos tiempos que llega al fichero (ADR-0016) |
| **Comisiones y metas** | Comisión en cascada (habilidad → servicio → general), congelada al facturar; metas de facturación con recompensa y ámbito `.own` (ADR-0018) |

### Pendiente

Los tres módulos que esta sección listaba como ausentes —compras, recuperación de contraseña,
y usuarios y roles por HTTP— **ya están construidos y en uso desde la interfaz**. Lo que queda
es de otra naturaleza: no hay que escribir funcionalidad nueva, hay que cerrar cuatro huecos.

**1. Compras: normalización R1 completada.**

Proveedores y órdenes tienen dominio, casos de uso, puertos y adaptadores separados. La
recepción parcial delega el alta de existencias en `ReceiveStockUseCase`, usa cantidades
decimales exactas y serializa recepción y cancelación sobre la cabecera del pedido.

| Estado | Detalle |
| ------ | ------- |
| ✅ Arquitectura hexagonal | Dominio y aplicación no dependen de Prisma; el adaptador vive en infraestructura y el módulo realiza el wiring |
| ✅ ADR propio | [ADR-0017](docs/adr/0017-normalizacion-arquitectonica-de-compras.md) documenta las decisiones de R1 |
| ✅ Dinero con `Money` | Se calculaba con `number` y se persistía con `.toFixed(2)`. Además de desviar céntimos, **rompía su propia identidad contable**: un pedido guardaba subtotal 40,42 e IVA 4,85 con total 45,28, cuando la suma da 45,27. Ahora todo pasa por `Money` (ADR-0010) |
| ✅ Impuesto del producto | El tipo por defecto de una línea salía de un `12` fijo. Ahora sale del `taxRate` del producto que se compra, que es donde estaba declarado desde el principio |
| ✅ Moneda de la configuración | `currency: 'GTQ'` a mano → `DEFAULT_CURRENCY`, como el resto de módulos. `country` y `paymentTermDays` los declara ya el esquema |
| ✅ Cantidades fraccionarias | `0,3 − 0,1` da `0,19999999999999998` en coma flotante, y comparar eso con los `0,2` pendientes **rechazaba una recepción legítima**. La resta vuelve ahora a la rejilla de tres decimales del esquema |
| ✅ Pruebas unitarias y de integración | Cubren reglas, rollback, multi-tenancy, paginación y carreras recepción/recepción y cancelación/recepción |
| ✅ Listados paginados | `GET /purchases` y `GET /suppliers` aceptan `page`, `limit` y `sort`, y devuelven `meta` junto al arreglo `data` |

**2. Recuperación de contraseña: ya tiene puerto de correo; le falta un proveedor.**

El mecanismo estaba bien resuelto —token de un solo uso guardado como SHA-256, caducidad de
30 minutos, marcado atómico al consumirlo, y una respuesta que no revela si el correo
existe— pero no había forma de hacer llegar el enlace: en producción el token se emitía y no
salía de la base.

Ahora existe el puerto `EMAIL_SENDER` y el caso de uso envía por él. **Falta elegir
proveedor.** El adaptador registrado por defecto, `LoggingEmailSender`, escribe el mensaje en
el registro en lugar de enviarlo: sirve para recorrer el flujo en desarrollo sin buzón, y en
producción avisa por cada envío de que no hay proveedor configurado —en vez de tragárselo en
silencio, que es la forma en que estas cosas se descubren tarde—. Cambiarlo por SMTP, SES o
Resend es una línea en `shared.module.ts`; la decisión es de despliegue, no de código.

El flujo tiene ahora **9 tests de integración** en `auth.integration.spec.ts`: que el token se
guarda hasheado, que es de un solo uso, que caduca, que emitir uno nuevo invalida el anterior
y que un correo desconocido no se distingue de uno real.

**3. Usuarios y roles por HTTP: hecho y probado.**

Los controladores estaban completos; lo que faltaba era cobertura. Añadidos **26 tests de
integración** en `test/integration/users-roles.integration.spec.ts`, centrados en lo que
duele si falla: quién puede administrar, qué permisos acaba teniendo el administrado, que el
salón vecino no aparece, y la regla de **la última propietaria** —que se vigila en tres
sitios distintos y no tenía ni una prueba pese a ser lo que impide que un salón se quede sin
nadie capaz de administrarlo—.

**4. El frontend ya tiene volumen de tests; le falta que sean de contrato.**

Frente a los 1.219 tests del backend, `apps/web` tiene **175 unitarios** (30 archivos, Vitest)
y **32 casos de Playwright** (16 escenarios × 2 dispositivos). El volumen dejó de ser el
problema. Los e2e recorren los flujos importantes de principio a fin, pero **interceptan la
API con `page.route`**: verifican que la interfaz se comporta ante respuestas dadas, no que el
backend las produzca. Nada prueba hoy que el contrato entre ambos coincida — es el hueco que
queda, y es de naturaleza distinta a la de cantidad.

**5. `PERMISSION_DENIED` se declara y no se registra nunca.**

`AuditActionName` incluye esa acción, pero no hay una sola línea que la grabe: quien sondea
endpoints para los que no tiene permiso recibe su 403 y no deja rastro. Es una promesa que la
auditoría no cumple. Arreglarlo obliga a volver asíncrono `PermissionsGuard` —hoy es síncrono
y solo inyecta `Reflector`— y a aceptar una escritura en base por cada denegación, que es
munición para quien quiera inflar la tabla a base de peticiones. Merece un ADR antes que un
parche.

La normalización de compras usa las cuatro piezas comunes del proyecto —entidad, puerto,
casos de uso y adaptador Prisma— y reutiliza del shared kernel la paginación, el soft delete,
la traducción de errores y la aritmética monetaria.

### Deuda consciente, anotada donde corresponde

- **Row Level Security** en lugar de la extensión de Prisma (ADR-0003).
- **Lotes y caducidad** de producto: afecta a tintes y químicos, previsiblemente exigido
  por normativa en v2 (ADR-0011).
- **Rate limiting en memoria**: con más de una réplica hay que moverlo a Redis (ADR-0007).
- **Moneda por inquilino**: `Client.totalSpent` usa la moneda configurada por defecto en
  lugar de la del salón (documentado en el repositorio de clientas).
- **Zona horaria por inquilino**: igual que la moneda, sale de la configuración global y
  no de `Tenant.timezone`. Deja de valer con salones en husos distintos; la salida está
  anotada en `stylists.module.ts`.
- **Vulnerabilidad conocida**: `prisma` (CLI, solo desarrollo) arrastra `deepmerge-ts < 8`
  (GHSA-ggr8-5vv4-36mx). No forma parte de la imagen de producción ni procesa entrada de
  usuario (ADR-0002).
- **Sin proveedor de correo**: el puerto `EMAIL_SENDER` existe y el caso de uso lo usa, pero
  el adaptador registrado escribe en el registro en lugar de enviar. Antes de desplegar hay
  que sustituirlo en `shared.module.ts`; mientras tanto, la recuperación de contraseña avisa
  por cada intento de que el mensaje no ha salido.

---

## Comandos

| Comando | Para qué |
| ------- | -------- |
| `npm run start:dev` | Desarrollo con recarga |
| `npm run build` | Compilar a `dist/` |
| `npm run typecheck` | Comprobación de tipos sin emitir |
| `npm run lint` / `lint:fix` | ESLint con reglas basadas en tipos |
| `npm run format` | Prettier |
| `npm run test:unit` | Suite unitaria |
| `npm run test:integration` | Suite de integración (requiere `postgres-test`) |
| `npm run test:cov` | Cobertura con umbrales |
| `npm run prisma:migrate` | Crear migración en desarrollo |
| `npm run prisma:deploy` | Aplicar migraciones (despliegue) |
| `npm run prisma:studio` | Explorador de datos |
| `npm run db:seed` | Sembrar catálogo y datos de demostración |

Los de la interfaz web se lanzan desde la raíz y delegan en el workspace `@beautyos/web`:

| Comando | Para qué |
| ------- | -------- |
| `npm run web:dev` | Desarrollo con recarga, en el puerto 3001 |
| `npm run web:build` | Compilación de producción (`output: standalone`) |
| `npm run web:typecheck` | Comprobación de tipos sin emitir |
| `npm run web:lint` | ESLint, sin tolerar advertencias |
| `npm run web:test` | Suite unitaria (Vitest) |
| `npm run web:test:e2e` | Flujos completos (Playwright); levanta el servidor si no lo encuentra |

---

## Notas para quien continúe

1. **Lea primero los ADR.** Las decisiones no obvias están justificadas ahí, y muchas
   tienen consecuencias que no se ven en el código.
2. **Un módulo nuevo es tenant-scoped por defecto.** Si añade un modelo global, apúntelo
   en `TENANT_EXEMPT_MODELS`; el olvido falla hacia el lado seguro.
3. **Todo endpoint declara su permiso.** Sin `@RequirePermissions`, `@Authenticated` o
   `@Public`, el guard lo cierra y lo registra como omisión.
4. **El dinero pasa por `Money`.** Ningún importe debería tocar `number` en ningún punto.
5. **Si una regla solo se puede probar por HTTP, está en la capa equivocada.** Es una
   señal de diseño, no un problema de tests.
